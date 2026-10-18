import json

from factory.config import Config
from factory.events import EventLog, verify_chain
from factory.recovery import recover_interrupted


def test_interrupted_run_is_escalated_and_logged(tmp_path):
    config = Config()
    config.runs_dir = tmp_path
    log = EventLog(tmp_path, "r-interrupted")
    log.emit("run_started", bug={"id": "bug2", "title": "t", "body": "b", "source": "s"}, fixer="nemotron",
             reproducer="nemotron", stations=["scope", "fix"])
    log.emit("station_started", station="scope")
    log.emit("station_finished", station="scope", outcome="pass", reason="ok", evidence={})
    log.emit("station_started", station="fix")
    done = EventLog(tmp_path, "r-done")
    done.emit("run_started", bug={"id": "bug1", "title": "t", "body": "b", "source": "s"}, fixer="x",
              reproducer="y", stations=["scope"])
    done.emit("run_finished", outcome="shipped")

    assert recover_interrupted(config) == ["r-interrupted"]
    result = json.loads((tmp_path / "r-interrupted" / "run.json").read_text())
    assert result["outcome"] == "escalated" and result["verdicts"][-1]["station"] == "fix"
    assert "Interrupted" in result["verdicts"][-1]["reason"]
    assert "r-interrupted" in (tmp_path / "escalations.jsonl").read_text()
    assert verify_chain(tmp_path / "events.jsonl")[0]
    assert recover_interrupted(config) == []  # idempotent
