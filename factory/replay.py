"""Replay a past run from its signed record and stored artifacts.

1. Integrity: every event of the run has a valid hash and signature, and the stored artifacts
   match the hashes recorded in those events.
2. Re-execution: every deterministic gate runs again on a fresh checkout of the recorded commit
   with the recorded test and diff. Each must reach the same outcome it reached originally.
3. Model decisions (classifier, fixer, reviewer) are not re-sampled; their recorded inputs
   (prompt hash) and outputs are shown, since they are part of the signed record.
"""
import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

from factory import signing
from factory.config import Config
from factory.events import verify_entry
from factory.models import BugReport
from factory.policy import Policy
from factory.stations.baseline import check_baseline
from factory.stations.diff_inspection import inspect_diff
from factory.stations.oracle import oracle
from factory.stations.reproduce import judge_test
from factory.stations.scope import check_rules
from factory.workspace import Workspace


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def replay(run_id: str, config: Config | None = None) -> dict:
    config = config or Config()
    run_dir = config.runs_dir / run_id
    events_path = run_dir / "events.jsonl"
    if not events_path.exists():
        raise FileNotFoundError(f"no run {run_id}")
    events = [json.loads(l) for l in events_path.read_text().splitlines() if l.strip()]

    # 1. integrity
    public = signing.load_public()
    bad = [(e["seq"], p) for e in events if (p := verify_entry(e, public))]
    recorded = {e["station"]: e for e in events if e["type"] == "station_finished"}
    started = next(e for e in events if e["type"] == "run_started")
    artifacts = run_dir / "artifacts"
    test_code = (artifacts / "repro_test.py").read_text() if (artifacts / "repro_test.py").exists() else None
    diff = (artifacts / "fix.diff").read_text() if (artifacts / "fix.diff").exists() else None
    artifact_checks = []
    if test_code is not None:
        want = recorded.get("reproduce", {}).get("evidence", {}).get("test_sha256")
        artifact_checks.append({"artifact": "repro_test.py", "ok": want == _sha(test_code)})
    if diff is not None:
        want = recorded.get("fix", {}).get("evidence", {}).get("diff_sha256")
        artifact_checks.append({"artifact": "fix.diff", "ok": want == _sha(diff)})
    integrity = {"events": len(events), "bad_events": bad, "artifacts": artifact_checks,
                 "ok": not bad and all(a["ok"] for a in artifact_checks)}

    # 2. re-execute deterministic gates on the recorded commit
    commit = started["target"]["commit"]
    replay_cfg = replace(config, target_ref=commit)
    ws_path = run_dir / "replay_workspace"
    shutil.rmtree(ws_path, ignore_errors=True)
    ws = Workspace.create(ws_path, replay_cfg)
    policy = Policy.load(ws.path)
    bug = BugReport(**started["bug"])
    test_path = recorded.get("reproduce", {}).get("evidence", {}).get("test_path", f"tests/test_repro_{bug.id}.py")

    rows = []

    def row(station: str, kind: str, outcome: str | None, note: str = "") -> None:
        orig = recorded.get(station)
        rec = orig["outcome"] if orig else None
        rows.append({"station": station, "kind": kind, "recorded": rec, "replayed": outcome,
                     "match": outcome == rec if kind == "deterministic" else None, "note": note})

    for station in [s for s in started["stations"] if s in recorded]:
        if station == "scope":
            rules = check_rules(bug)
            clf = recorded["scope"]["evidence"].get("classifier")
            note = ""
            if isinstance(clf, dict) and clf.get("model"):
                prompts = sorted({v["prompt_sha256"][:12] for v in clf.get("votes", []) if "prompt_sha256" in v})
                note = f"model: {clf['model']}, {clf.get('trivial_votes')}/{len(clf.get('votes', []))} votes, prompt {', '.join(prompts)}"
            # rules are deterministic; if they passed, the recorded outcome also includes the classifier
            if rules.outcome == "escalate" or not isinstance(clf, dict):
                row("scope", "deterministic", rules.outcome, "keyword rules")
            else:
                row("scope", "model", "recorded", "rules: pass; classifier " + note)
        elif station == "baseline":
            row("baseline", "deterministic", check_baseline(ws).outcome)
        elif station == "reproduce":
            if test_code is None:
                row("reproduce", "model", "recorded", "no qualifying test was produced")
            else:
                ok, why, _ = judge_test(ws, test_path, test_code, policy, tag="replay")
                if recorded["reproduce"]["outcome"] == "closed":
                    # the base-commit half is re-checkable; production has moved on since, so the rest is recorded
                    fixed = recorded["reproduce"]["evidence"].get("production_check", {})
                    rows.append({"station": "reproduce", "kind": "deterministic", "recorded": "closed",
                                 "replayed": "pass" if ok else "escalate", "match": ok,
                                 "note": f"test still fails on base commit ({why}); recorded as already fixed "
                                         f"by {str(fixed.get('fixed_by', '?'))[:10]}"})
                else:
                    row("reproduce", "deterministic", "pass" if ok else "escalate", why)
        elif station == "fix":
            meta = (recorded["fix"]["evidence"].get("fixer_meta") or {}).get("attempts") or []
            row("fix", "model", "recorded", f"fixer {recorded['fix']['evidence'].get('fixer')}, "
                                            f"{len(meta)} model call(s)" if meta else f"fixer {recorded['fix']['evidence'].get('fixer')}")
        elif station == "oracle" and diff and test_code:
            v = oracle(ws, diff, test_path, test_code, policy)
            row("oracle", "deterministic", v.outcome, v.reason)
        elif station == "diff_inspection" and diff:
            v = inspect_diff(diff, policy, test_path)
            row("diff_inspection", "deterministic", v.outcome, v.reason)
        elif station == "review":
            ans = recorded["review"]["evidence"]
            row("review", "model", "recorded",
                f"model: {ans['model']} prompt {ans['prompt_sha256'][:12]}" if "model" in ans else "reviewer disabled")
        elif station == "deploy":
            row("deploy", "recorded", "recorded", recorded["deploy"]["reason"])
        else:
            row(station, "recorded", "recorded")

    shutil.rmtree(ws_path, ignore_errors=True)
    deterministic = [r for r in rows if r["kind"] == "deterministic"]
    return {
        "run_id": run_id, "bug": bug.id, "commit": commit, "integrity": integrity, "stations": rows,
        "ok": integrity["ok"] and all(r["match"] for r in deterministic),
        "outcome": next((e["outcome"] for e in events if e["type"] == "run_finished"), None),
    }
