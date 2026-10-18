"""Runs interrupted by a factory restart.

A run lives in a server thread; if the process stops mid-run, its log ends with a station that
started and never finished, and the run would show as "running" forever. On startup, every such
run is closed the only safe way: its result is unknown, so it is escalated to a human.
"""
import json
from datetime import datetime, timezone

from factory.config import Config
from factory.events import EventLog


def recover_interrupted(config: Config | None = None) -> list[str]:
    config = config or Config()
    recovered = []
    for events_path in sorted(config.runs_dir.glob("*/events.jsonl")):
        run_dir = events_path.parent
        if (run_dir / "run.json").exists():
            continue
        events = [json.loads(l) for l in events_path.read_text().splitlines() if l.strip()]
        if not events or any(e["type"] == "run_finished" for e in events):
            continue
        started = next((e for e in events if e["type"] == "run_started"), None)
        if started is None:
            continue
        finished = {e["station"] for e in events if e["type"] == "station_finished"}
        open_station = next((e["station"] for e in reversed(events)
                             if e["type"] == "station_started" and e["station"] not in finished), None)
        station = open_station or "factory"
        reason = (f"Interrupted: the factory restarted while {station} was running. "
                  "Its result is unknown, so it is escalated by default.")
        if station == "deploy":
            reason += " Check production status: the canary may have been mid-rollout."

        log = EventLog(config.runs_dir, run_dir.name)
        log.emit("station_finished", station=station, outcome="escalate", reason=reason,
                 evidence={"interrupted": True, "last_seq_before_restart": events[-1]["seq"]})
        log.emit("escalated", station=station, reason=reason)
        with (config.runs_dir / "escalations.jsonl").open("a") as f:
            f.write(json.dumps({"run_id": run_dir.name, "bug": started["bug"]["id"], "title": started["bug"]["title"],
                                "station": station, "reason": reason,
                                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n")
        log.emit("run_finished", outcome="escalated")

        all_events = [json.loads(l) for l in events_path.read_text().splitlines() if l.strip()]
        verdicts = [{"station": e["station"], "outcome": e["outcome"], "reason": e["reason"], "evidence": e["evidence"]}
                    for e in all_events if e["type"] == "station_finished"]
        (run_dir / "run.json").write_text(json.dumps(
            {"run_id": run_dir.name, "bug": started["bug"], "fixer": started["fixer"], "outcome": "escalated",
             "interrupted": True, "verdicts": verdicts}, indent=2))
        recovered.append(run_dir.name)
    return recovered
