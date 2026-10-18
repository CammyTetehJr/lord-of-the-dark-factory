"""The andon cord: a human can pause the whole line at any time. Runs check before every station."""
import json
from datetime import datetime, timezone
from pathlib import Path


def _path(runs_dir: Path) -> Path:
    return runs_dir / "line.json"


def state(runs_dir: Path) -> dict:
    p = _path(runs_dir)
    return json.loads(p.read_text()) if p.exists() else {"paused": False}


def set_paused(runs_dir: Path, paused: bool, by: str = "operator", reason: str = "") -> dict:
    runs_dir.mkdir(parents=True, exist_ok=True)
    s = {"paused": paused, "by": by, "reason": reason,
         "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    _path(runs_dir).write_text(json.dumps(s))
    return s
