"""HTTP API for the UI. Read-only views over runs/, plus endpoints to start runs and pause the line.

    factory serve            # http://127.0.0.1:8100, docs at /docs

Public mode (judges): set FACTORY_ACCESS_CODE. Every request then needs the code, once as
`?code=...` (which sets a cookie) and via that cookie afterwards. If ui/dist exists it is served
from the same origin, so one link opens everything.
"""
import asyncio
import hmac
import json
import os
import shutil
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from factory import line, sandbox
from factory.config import ROOT, Config
from factory.events import verify_chain
from factory.fixers import get_fixer
from factory.models import BugReport
from factory.pipeline import STATIONS, new_run_id, run_pipeline
from factory.reproducers import get_reproducer

config = Config()
app = FastAPI(title="Lord of the Dark Factory")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ACCESS_CODE = os.environ.get("FACTORY_ACCESS_CODE", "")
COOKIE = "df_access"
UI_DIST = ROOT / "ui" / "dist"

DENIED_PAGE = b"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Dark Factory</title><body style="background:#0d0f12;color:#d8dde3;font:16px/1.5 ui-monospace,Menlo,monospace;
display:grid;place-items:center;min-height:100vh;margin:0;padding:16px"><div style="max-width:28rem">
<h1 style="font-size:20px;letter-spacing:.08em">DARK FACTORY</h1>
<p>This link needs an access code. Open the full link you were given, including <code>?code=...</code></p></div>"""


class AccessCode:
    """Pure ASGI middleware (safe with the long-lived event stream)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not ACCESS_CODE:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        cookie = SimpleCookie(headers.get(b"cookie", b"").decode())
        has_cookie = COOKIE in cookie and hmac.compare_digest(cookie[COOKIE].value, ACCESS_CODE)
        code = parse_qs(scope.get("query_string", b"").decode()).get("code", [""])[0]
        has_code = bool(code) and hmac.compare_digest(code, ACCESS_CODE)
        path = scope["path"]

        if has_code and not path.startswith("/api"):
            # set the cookie and drop the code from the address bar
            secure = "; Secure" if headers.get(b"x-forwarded-proto") == b"https" else ""
            await send({"type": "http.response.start", "status": 303, "headers": [
                (b"location", path.encode() or b"/"),
                (b"set-cookie", f"{COOKIE}={ACCESS_CODE}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax{secure}".encode()),
            ]})
            return await send({"type": "http.response.body", "body": b""})
        if has_cookie or has_code:
            return await self.app(scope, receive, send)
        if path.startswith("/api") or path in ("/docs", "/openapi.json"):
            body, ctype = b'{"detail": "access code required"}', b"application/json"
        else:
            body, ctype = DENIED_PAGE, b"text/html; charset=utf-8"
        await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", ctype)]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(AccessCode)


@app.on_event("startup")
def _recover_interrupted_runs() -> None:
    from factory.recovery import recover_interrupted
    for run_id in recover_interrupted(config):
        print(f"recovered interrupted run {run_id}: escalated by default", flush=True)


INTAKE_REPO = os.environ.get("FACTORY_INTAKE_REPO", "")
_intake = None


@app.on_event("startup")
def _start_github_intake() -> None:
    """Issues labelled `autofix` on INTAKE_REPO go through the full live line on their own."""
    global _intake
    if not INTAKE_REPO:
        return
    from factory.intake import GitHubIntake

    def submit(bug, run_id, on_done):
        return submit_run(bug, get_fixer("nemotron"), get_reproducer("nemotron"), run_id,
                          {"classifier": "nemotron", "reviewer": "nemotron", "deploy": "canary"}, on_done)

    _intake = GitHubIntake(INTAKE_REPO, submit, config, public_url=os.environ.get("FACTORY_PUBLIC_URL") or None,
                           interval_s=float(os.environ.get("FACTORY_INTAKE_INTERVAL_S", "20")))
    _intake.start()
    print(f"github intake: watching {INTAKE_REPO} for issues labelled autofix", flush=True)


@app.get("/api/intake")
def intake_status():
    return _intake.status() if _intake else {"enabled": False}

# Run queue: at most MAX_ACTIVE runs at once, a short queue behind them, and an hourly cap.
MAX_ACTIVE = int(os.environ.get("FACTORY_MAX_ACTIVE_RUNS", "2"))
MAX_QUEUED = int(os.environ.get("FACTORY_MAX_QUEUED_RUNS", "10"))
MAX_PER_HOUR = int(os.environ.get("FACTORY_MAX_RUNS_PER_HOUR", "80"))
_executor = ThreadPoolExecutor(MAX_ACTIVE, thread_name_prefix="run")
_queue_lock = threading.Lock()
_in_flight = 0
_started: deque[float] = deque()


class LineBusy(Exception):
    pass


def _execute(run_args: tuple, run_kwargs: dict, on_done=None) -> None:
    global _in_flight
    run_id = run_args[4]
    run = None
    try:
        run = run_pipeline(*run_args, **run_kwargs)
    finally:
        if on_done is not None:
            try:
                on_done(run_id, run)
            except Exception as e:  # reporting back must never take the line down
                print(f"on_done for {run_id} failed: {type(e).__name__}: {e}", flush=True)
        # keep evidence, artifacts and the signed log; drop the working copies
        for d in ("workspace", "fixer_workspace", "production_check"):
            shutil.rmtree(config.runs_dir / run_id / d, ignore_errors=True)
        with _queue_lock:
            _in_flight -= 1

ARTIFACTS = {"fix.diff", "repro_test.py"}
SSE_HEARTBEAT_S = float(os.environ.get("FACTORY_SSE_HEARTBEAT_S", "5"))


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def _bugs() -> dict[str, BugReport]:
    return {b.id: b for b in (BugReport.from_markdown(p) for p in sorted(config.inbox_dir.glob("*.md")))}


def _run_summary(run_dir: Path) -> dict:
    final = run_dir / "run.json"
    if final.exists():
        d = json.loads(final.read_text())
        esc = next((v for v in d["verdicts"] if v["outcome"] == "escalate"), None)
        return {"run_id": d["run_id"], "bug": d["bug"], "fixer": d["fixer"], "status": d["outcome"],
                "stations": {v["station"]: v["outcome"] for v in d["verdicts"]},
                "escalation": {"station": esc["station"], "reason": esc["reason"]} if esc else None}
    events = _read_jsonl(run_dir / "events.jsonl")
    started = next((e for e in events if e["type"] == "run_started"), {})
    stations: dict[str, str] = {}
    for e in events:
        if e["type"] == "station_started":
            stations[e["station"]] = "running"
        elif e["type"] == "station_finished":
            stations[e["station"]] = e["outcome"]
    return {"run_id": run_dir.name, "bug": started.get("bug"), "fixer": started.get("fixer"),
            "status": "running", "stations": stations, "escalation": None}


@app.get("/api/meta")
def meta():
    return {"stations": STATIONS, "fixers": ["nemotron", "reference", "rogue:delete_test", "rogue:touch_auth",
                                             "rogue:add_dependency", "rogue:leak_secret", "rogue:phone_home",
                                             "rogue:big_rewrite", "rogue:game_test", "rogue:slow_fix"],
            "sandbox": sandbox.describe(),
            "limits": {"max_active_runs": MAX_ACTIVE, "max_queued_runs": MAX_QUEUED, "max_runs_per_hour": MAX_PER_HOUR},
            "reproducers": ["nemotron", "dev"], "classifiers": ["nemotron", "none"], "reviewers": ["nemotron", "none"], "deploys": ["canary", "branch"], "target": {"repo": str(config.target_repo), "ref": config.target_ref}}


@app.get("/api/bugs")
def bugs():
    return [b.__dict__ for b in _bugs().values()]


@app.get("/api/runs")
def runs(limit: int = 50):
    dirs = sorted((d for d in config.runs_dir.glob("*") if (d / "events.jsonl").exists()), reverse=True)[:limit]
    return [_run_summary(d) for d in dirs]


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    run_dir = config.runs_dir / run_id
    if not run_dir.is_dir() or "/" in run_id or ".." in run_id:
        raise HTTPException(404, "run not found")
    final = run_dir / "run.json"
    return {"summary": _run_summary(run_dir), "events": _read_jsonl(run_dir / "events.jsonl"),
            "result": json.loads(final.read_text()) if final.exists() else None}


@app.get("/api/runs/{run_id}/artifacts/{name}", response_class=PlainTextResponse)
def artifact(run_id: str, name: str):
    path = config.runs_dir / run_id / "artifacts" / name
    if name not in ARTIFACTS or ".." in run_id or not path.exists():
        raise HTTPException(404, "artifact not found")
    return path.read_text()


class RunRequest(BaseModel):
    bug_id: str
    fixer: str = "nemotron"
    reproducer: str = "nemotron"
    classifier: str = "nemotron"
    reviewer: str = "nemotron"
    deploy: str = "canary"


@app.post("/api/runs", status_code=202)
def start_run(req: RunRequest):
    bug = _bugs().get(req.bug_id)
    if bug is None:
        raise HTTPException(404, f"no bug report {req.bug_id}")
    try:
        fixer, reproducer = get_fixer(req.fixer), get_reproducer(req.reproducer)
    except ValueError as e:
        raise HTTPException(400, str(e))
    run_id = new_run_id(bug)
    if req.classifier not in ("none", "nemotron") or req.reviewer not in ("none", "nemotron"):
        raise HTTPException(400, "classifier and reviewer must be 'none' or 'nemotron'")
    if req.deploy not in ("branch", "canary"):
        raise HTTPException(400, "deploy must be 'branch' or 'canary'")
    try:
        position = submit_run(bug, fixer, reproducer, run_id,
                              {"classifier": req.classifier, "reviewer": req.reviewer, "deploy": req.deploy})
    except LineBusy as e:
        raise HTTPException(429, str(e))
    return {"run_id": run_id, "queued_behind": position}


def submit_run(bug: BugReport, fixer, reproducer, run_id: str, run_kwargs: dict, on_done=None) -> int:
    """Queue a run under the shared limits (UI and GitHub intake alike). Returns how many runs
    are ahead of it; raises LineBusy with a plain-language reason when the line is full."""
    global _in_flight
    with _queue_lock:
        now = time.time()
        while _started and now - _started[0] > 3600:
            _started.popleft()
        if len(_started) >= MAX_PER_HOUR:
            wait = int((3600 - (now - _started[0])) / 60) + 1 if _started else 60
            raise LineBusy(f"Hourly limit of {MAX_PER_HOUR} runs reached. Try again in about {wait} min.")
        if _in_flight >= MAX_ACTIVE + MAX_QUEUED:
            raise LineBusy(f"The line is busy ({_in_flight} runs in progress or waiting). Try again in a minute.")
        position = max(0, _in_flight - MAX_ACTIVE + 1)
        _in_flight += 1
        _started.append(now)
    _executor.submit(_execute, (bug, fixer, reproducer, config, run_id), run_kwargs, on_done)
    return position


@app.get("/api/escalations")
def escalations():
    return list(reversed(_read_jsonl(config.runs_dir / "escalations.jsonl")))


@app.get("/api/line")
def line_state():
    return line.state(config.runs_dir)


class PauseRequest(BaseModel):
    by: str = "operator"
    reason: str = ""


@app.post("/api/line/pause")
def pause(req: PauseRequest):
    return line.set_paused(config.runs_dir, True, req.by, req.reason)


@app.post("/api/line/resume")
def resume(req: PauseRequest):
    return line.set_paused(config.runs_dir, False, req.by, req.reason)


@app.post("/api/runs/{run_id}/replay")
def run_replay(run_id: str):
    from factory.replay import replay
    if "/" in run_id or ".." in run_id:
        raise HTTPException(404, "run not found")
    try:
        return replay(run_id, config)
    except FileNotFoundError:
        raise HTTPException(404, "run not found")


@app.get("/api/audit/pubkey", response_class=PlainTextResponse)
def audit_pubkey():
    from factory import signing
    return signing.public_pem().decode()


@app.get("/api/prod")
def prod_status():
    from factory.prod import Prod
    return Prod(config).status()


@app.post("/api/prod/start")
def prod_start():
    from factory.prod import Prod
    prod = Prod(config)
    with prod.lock():
        return {"url": prod.ensure_stable().url}


@app.post("/api/prod/reset")
def prod_reset(req: PauseRequest):
    from dataclasses import asdict

    from factory.prod import Prod
    inst = Prod(config).reset_production(req.by or "operator")
    return {"ok": True, "message": "Production restarted from the original code; all seeded bugs are back.",
            "url": inst.url, "commit": inst.commit, "stable": asdict(inst)}


@app.post("/api/prod/rollback")
def prod_rollback(req: PauseRequest):
    from factory.prod import Prod
    return Prod(config).rollback_last(req.by)


@app.get("/api/audit/verify")
def audit_verify():
    path = config.runs_dir / "events.jsonl"
    if not path.exists():
        return {"ok": True, "message": "no events yet", "events": 0}
    ok, msg = verify_chain(path)
    return {"ok": ok, "message": msg, "events": len(path.read_text().splitlines())}


@app.get("/api/events/stream")
async def stream(since: int = 0):
    """Server-sent events: every event with seq > since, then live as they are written."""
    path = config.runs_dir / "events.jsonl"

    async def gen():
        events = _read_jsonl(path)
        # a client remembering a higher seq than the log has saw an older, archived log: start over
        last = since if events and since <= events[-1]["seq"] else 0
        # Proxies such as ngrok drop SSE comment lines, so a stream of ": keepalive" never even sends
        # its headers. Heartbeats are real events named "ping": EventSource.onmessage ignores named
        # events, so the UI is unaffected, but every proxy passes them on immediately.
        yield f"event: ping\ndata: {json.dumps({'since': last})}\n\n"
        beat = 0.0
        while True:
            for e in events:
                if e["seq"] > last:
                    last = e["seq"]
                    yield f"id: {e['seq']}\ndata: {json.dumps(e)}\n\n"
            beat += 0.5
            if beat >= SSE_HEARTBEAT_S:
                beat = 0.0
                yield "event: ping\ndata: {}\n\n"
            await asyncio.sleep(0.5)
            events = _read_jsonl(path)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# The built UI, same origin as the API. Mounted last so every /api route wins.
if UI_DIST.is_dir():
    app.mount("/", StaticFiles(directory=UI_DIST, html=True), name="ui")
