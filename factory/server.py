"""HTTP API for the UI. Read-only views over runs/, plus endpoints to start runs and pause the line.

    factory serve            # http://127.0.0.1:8100, docs at /docs
"""
import asyncio
import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from factory import line
from factory.config import Config
from factory.events import verify_chain
from factory.fixers import get_fixer
from factory.models import BugReport
from factory.pipeline import STATIONS, new_run_id, run_pipeline
from factory.reproducers import get_reproducer

config = Config()
app = FastAPI(title="Lord of the Dark Factory")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ARTIFACTS = {"fix.diff", "repro_test.py"}


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
                                             "rogue:big_rewrite", "rogue:game_test"],
            "reproducers": ["nemotron", "dev"], "classifiers": ["nemotron", "none"], "reviewers": ["nemotron", "none"], "target": {"repo": str(config.target_repo), "ref": config.target_ref}}


@app.get("/api/bugs")
def bugs():
    return [b.__dict__ for b in _bugs().values()]


@app.get("/api/runs")
def runs(limit: int = 50):
    dirs = sorted((d for d in config.runs_dir.glob("*") if d.is_dir()), reverse=True)[:limit]
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
    threading.Thread(target=run_pipeline, args=(bug, fixer, reproducer, config, run_id),
                     kwargs={"classifier": req.classifier, "reviewer": req.reviewer}, daemon=True).start()
    return {"run_id": run_id}


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
        last = since
        while True:
            for e in _read_jsonl(path):
                if e["seq"] > last:
                    last = e["seq"]
                    yield f"id: {e['seq']}\ndata: {json.dumps(e)}\n\n"
            yield ": keepalive\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream")
