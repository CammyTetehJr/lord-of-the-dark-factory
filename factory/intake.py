"""GitHub intake: the factory picks up its own work.

Every open issue on the target repo labelled `autofix` becomes a bug report and goes through the
full live line (Nemotron in every role, canary deploy) with no human starting it. When the run
finishes, the factory reports back on the issue: what happened, why, and where it shipped.

Only repository collaborators can add labels, so the label is the gate: strangers can open
issues, but only a maintainer can put one on the line.

Enable with FACTORY_INTAKE_REPO=owner/name (uses the `gh` CLI's login).
"""
import json
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from factory.config import Config
from factory.models import BugReport

TRIGGER = ("autofix", "5319e7", "Let the dark factory try to fix this on its own")
STATUS = {
    "running": ("factory: running", "fbca04", "The dark factory is working on this"),
    "shipped": ("factory: shipped", "0e8a16", "Fixed and shipped by the dark factory"),
    "closed": ("factory: already fixed", "c5def5", "Already fixed in production"),
    "escalated": ("needs-human", "d93f0b", "The dark factory escalated this to a human"),
}

Gh = Callable[..., subprocess.CompletedProcess]


def _gh(*args: str, input: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], input=input, capture_output=True, text=True, timeout=60)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class GitHubIntake:
    def __init__(self, repo: str, submit: Callable, config: Config | None = None, gh: Gh = _gh,
                 interval_s: float = 20, public_url: str | None = None):
        self.repo = repo
        self.submit = submit  # submit(bug, run_id, on_done) -> queue position; raises on a full line
        self.config = config or Config()
        self.gh = gh
        self.interval_s = interval_s
        self.public_url = public_url
        self.state_path: Path = self.config.runs_dir / "intake.json"
        self.last_poll: str | None = None
        self.last_error: str | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # a run can finish before its "picked up" comment is posted (scope refuses in under a
        # second); the report waits for the pick-up so the issue reads in order
        self._picked_up: dict[int, threading.Event] = {}

    # ---------- state: issue number -> run ----------
    def state(self) -> dict:
        return json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def _save(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(state, indent=2))

    # ---------- GitHub ----------
    def ensure_labels(self) -> None:
        for name, color, desc in [TRIGGER, *STATUS.values()]:
            self.gh("label", "create", name, "-R", self.repo, "--color", color, "--description", desc, "--force")

    def _label(self, number: int, add: str | None = None, remove: list[str] = ()) -> None:
        args = ["issue", "edit", str(number), "-R", self.repo]
        if add:
            args += ["--add-label", add]
        for r in remove:
            args += ["--remove-label", r]
        self.gh(*args)

    def _comment(self, number: int, body: str) -> None:
        self.gh("issue", "comment", str(number), "-R", self.repo, "--body-file", "-", input=body)

    # ---------- the loop ----------
    def poll(self) -> list[str]:
        """Put every new `autofix` issue on the line. Returns the run ids started."""
        res = self.gh("issue", "list", "-R", self.repo, "--label", TRIGGER[0], "--state", "open",
                      "--json", "number,title,body,url,labels", "--limit", "50")
        self.last_poll = _now()
        if res.returncode != 0:
            self.last_error = res.stderr.strip()[:300]
            return []
        self.last_error = None
        started = []
        status_names = {s[0] for s in STATUS.values()}
        for issue in sorted(json.loads(res.stdout or "[]"), key=lambda i: i["number"]):
            n = issue["number"]
            with self._lock:
                if str(n) in self.state():
                    continue
            if status_names & {l["name"] for l in issue.get("labels", [])}:
                continue  # handled before (state file lost); a maintainer removes the label to retry
            bug = BugReport(id=f"issue{n}", title=issue["title"].strip(), body=(issue.get("body") or "").strip(),
                            source=issue["url"])
            from factory.pipeline import new_run_id
            run_id = new_run_id(bug)
            picked_up = self._picked_up[n] = threading.Event()
            try:
                position = self.submit(bug, run_id, lambda rid, run, n=n: self.report(n, rid, run))
            except Exception as e:  # line busy or hourly cap: try again on the next poll
                self._picked_up.pop(n, None)
                self.last_error = f"issue #{n} waiting: {e}"
                break
            with self._lock:
                state = self.state()
                state[str(n)] = {"run_id": run_id, "status": "running", "url": issue["url"], "started": _now()}
                self._save(state)
            self._label(n, add=STATUS["running"][0])
            wait = f" ({position} run{'s' if position != 1 else ''} ahead of it)" if position else ""
            where = f" Watch it live: {self.public_url}" if self.public_url else ""
            try:
                self._comment(n, f"🏭 Picked up by the dark factory as run `{run_id}`{wait}. No human will approve "
                                 f"the change; I'll report back here when the line is done.{where}")
            finally:
                picked_up.set()
            started.append(run_id)
        return started

    def report(self, number: int, run_id: str, run) -> None:
        """Called when the run finishes: comment, relabel, and close the issue if nothing is left to do."""
        if (ev := self._picked_up.get(number)) is not None:
            ev.wait(timeout=60)
            self._picked_up.pop(number, None)
        outcome = run.outcome if run is not None else "escalated"
        verdicts = run.verdicts if run is not None else []
        rows = "\n".join(f"| {v.station} | {'✅' if v.outcome == 'pass' else '⏹️' if v.outcome == 'closed' else '❌'} "
                         f"{v.reason.replace('|', '/')[:220]} |" for v in verdicts)
        table = f"\n\n| Station | Result |\n|---|---|\n{rows}" if rows else ""
        footer = (f"\n\nRun `{run_id}`. Every step above is in the factory's signed audit log and can be replayed "
                  f"with `factory replay {run_id}`.")

        if outcome == "shipped":
            deploy = next((v for v in verdicts if v.station == "deploy"), None)
            commit = (deploy.evidence.get("promoted_commit") or deploy.evidence.get("commit") or "") if deploy else ""
            head = (f"✅ **Fixed and shipped to production** (`{commit[:10]}`), with no human approving the change. "
                    "The canary held its SLOs at every traffic step.")
            status, close = "shipped", True
        elif outcome == "closed":
            head = f"⏹️ **Nothing to do:** {verdicts[-1].reason if verdicts else 'already fixed.'}"
            status, close = "closed", True
        else:
            esc = run.escalation if run is not None else None
            where = f" at **{esc.station}**" if esc else ""
            why = esc.reason if esc else "the run did not finish."
            head = f"🧑‍🔧 **Escalated to a human**{where}: {why}\n\nThe factory did not change production."
            status, close = "escalated", False

        self._comment(number, head + table + footer)
        self._label(number, add=STATUS[status][0], remove=[STATUS["running"][0]])
        if close:
            self.gh("issue", "close", str(number), "-R", self.repo, "--reason", "completed")
        with self._lock:
            state = self.state()
            state.setdefault(str(number), {}).update({"run_id": run_id, "status": status, "finished": _now()})
            self._save(state)

    def run_forever(self) -> None:
        try:
            self.ensure_labels()
        except Exception as e:
            self.last_error = f"label setup failed: {e}"
        while not self._stop.is_set():
            try:
                self.poll()
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"
            self._stop.wait(self.interval_s)

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.run_forever, name="github-intake", daemon=True)
        t.start()
        return t

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict:
        return {"enabled": True, "repo": self.repo, "label": TRIGGER[0], "interval_s": self.interval_s,
                "last_poll": self.last_poll, "last_error": self.last_error, "issues": self.state()}
