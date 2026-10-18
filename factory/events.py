"""Append-only event stream. One JSON object per line, each hash-chained to the previous one.

Per-run log: runs/<run_id>/events.jsonl
Global log:  runs/events.jsonl (every event from every run, in order; the UI tails this)
See docs/events.md for the schema.
"""
import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GENESIS = "0" * 64
_lock = threading.Lock()


def _last_hash(path: Path) -> tuple[str, int]:
    if not path.exists() or path.stat().st_size == 0:
        return GENESIS, 0
    with path.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 65536))
        last = f.read().splitlines()[-1]
    entry = json.loads(last)
    return entry["hash"], entry["seq"]


def entry_hash(entry: dict) -> str:
    body = {k: v for k, v in entry.items() if k != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class EventLog:
    def __init__(self, runs_dir: Path, run_id: str):
        self.global_path = runs_dir / "events.jsonl"
        self.run_path = runs_dir / run_id / "events.jsonl"
        self.run_id = run_id
        self.run_path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, type: str, **data: Any) -> dict:
        with _lock:
            prev, seq = _last_hash(self.global_path)
            entry = {
                "seq": seq + 1,
                "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "run_id": self.run_id,
                "type": type,
                **data,
                "prev_hash": prev,
            }
            entry["hash"] = entry_hash(entry)
            line = json.dumps(entry, sort_keys=True) + "\n"
            for path in (self.global_path, self.run_path):
                with path.open("a") as f:
                    f.write(line)
        return entry


def verify_chain(path: Path) -> tuple[bool, str]:
    prev = GENESIS
    for n, line in enumerate(path.read_text().splitlines(), 1):
        entry = json.loads(line)
        if entry["prev_hash"] != prev:
            return False, f"line {n}: prev_hash does not match line {n - 1}"
        if entry_hash(entry) != entry["hash"]:
            return False, f"line {n}: content was modified (hash mismatch)"
        prev = entry["hash"]
    return True, "chain intact"
