"""The line: intake, pre-checks, black box, post-checks, deploy. Every step is logged as it happens.
Default rule: anything that does not clearly pass is escalated to a human."""
import hashlib
import json
import secrets
from dataclasses import asdict
from datetime import datetime, timezone

from factory.config import Config
from factory import line
from factory.events import EventLog
from factory.fixers.base import Fixer
from factory.models import BugReport, Run, Verdict
from factory.policy import Policy
from factory.stations.baseline import check_baseline
from factory.stations.deploy import deploy
from factory.stations.diff_inspection import inspect_diff
from factory.stations.fix import run_fixer
from factory.stations.oracle import oracle
from factory.stations.reproduce import repro_test_path, reproduce
from factory.stations.scope import check_scope
from factory.workspace import Workspace

STATIONS = ["scope", "baseline", "reproduce", "fix", "oracle", "diff_inspection", "deploy"]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def new_run_id(bug: BugReport) -> str:
    return f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{bug.id}-{secrets.token_hex(3)}"


class LinePaused(Exception):
    pass


def run_pipeline(bug: BugReport, fixer: Fixer, reproducer, config: Config | None = None,
                 run_id: str | None = None) -> Run:
    config = config or Config()
    run_id = run_id or new_run_id(bug)
    run_dir = config.runs_dir / run_id
    artifacts = run_dir / "artifacts"
    artifacts.mkdir(parents=True)
    log = EventLog(config.runs_dir, run_id)

    ws = Workspace.create(run_dir / "workspace", config)
    policy = Policy.load(ws.path)  # always the policy at the base commit, never one a fix could edit
    run = Run(id=run_id, bug=bug, fixer=fixer.name, workspace=ws.path)

    log.emit("run_started", bug=asdict(bug), fixer=fixer.name, reproducer=reproducer.name,
             target={"repo": str(config.target_repo), "ref": config.target_ref, "commit": ws.head()},
             policy=asdict(policy), stations=STATIONS)

    def record(v: Verdict) -> bool:
        run.verdicts.append(v)
        log.emit("station_finished", station=v.station, outcome=v.outcome, reason=v.reason, evidence=v.evidence)
        return v.outcome == "pass"

    def start(station: str) -> None:
        if line.state(config.runs_dir).get("paused"):
            raise LinePaused(station)
        log.emit("station_started", station=station)

    try:
        start("scope")
        if not record(check_scope(bug)):
            return _finish(run, log, run_dir)
        start("baseline")
        if not record(check_baseline(ws)):
            return _finish(run, log, run_dir)

        start("reproduce")
        verdict, repro_code = reproduce(bug, ws, reproducer, policy)
        if repro_code:
            run.repro_test_path, run.repro_test_code = repro_test_path(bug), repro_code
            (artifacts / "repro_test.py").write_text(repro_code)
            verdict.evidence["test_sha256"] = _sha(repro_code)
        if not record(verdict):
            return _finish(run, log, run_dir)

        start("fix")
        verdict, diff = run_fixer(bug, ws, run.repro_test_path, run.repro_test_code, fixer)
        if diff:
            run.diff = diff
            (artifacts / "fix.diff").write_text(diff)
            verdict.evidence["diff_sha256"] = _sha(diff)
        if not record(verdict):
            return _finish(run, log, run_dir)

        # Both post-checks always run so the record shows every reason a fix was rejected.
        start("oracle")
        oracle_ok = record(oracle(ws, diff, run.repro_test_path, run.repro_test_code, policy))
        start("diff_inspection")
        inspect_ok = record(inspect_diff(diff, policy, run.repro_test_path))
        if not (oracle_ok and inspect_ok):
            return _finish(run, log, run_dir)

        start("deploy")
        record(deploy(run, ws))
    except LinePaused as e:
        record(Verdict(str(e), "escalate", "Line paused by a human operator before this station.",
                       {"line": line.state(config.runs_dir)}))
    except Exception as e:  # a bug in the factory itself must never look like a pass
        record(Verdict("factory", "escalate", f"Pipeline error: {type(e).__name__}: {e}", {}))
    return _finish(run, log, run_dir)


def _finish(run: Run, log: EventLog, run_dir) -> Run:
    esc = run.escalation
    if esc:
        log.emit("escalated", station=esc.station, reason=esc.reason)
        with (run_dir.parent / "escalations.jsonl").open("a") as f:
            f.write(json.dumps({"run_id": run.id, "bug": run.bug.id, "title": run.bug.title,
                                "station": esc.station, "reason": esc.reason,
                                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n")
    log.emit("run_finished", outcome=run.outcome)
    summary = {
        "run_id": run.id, "bug": asdict(run.bug), "fixer": run.fixer, "outcome": run.outcome,
        "verdicts": [v.to_dict() for v in run.verdicts],
    }
    (run_dir / "run.json").write_text(json.dumps(summary, indent=2))
    return run
