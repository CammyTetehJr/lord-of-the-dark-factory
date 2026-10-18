import json

from factory.events import EventLog, verify_chain
from factory.models import BugReport
from factory.stations.scope import check_scope


def bug(body: str) -> BugReport:
    return BugReport(id="b", title="Something is wrong", body=body, source="test")


def test_scope_escalates_auth():
    v = check_scope(bug("Expired API keys still work after the deadline."))
    assert v.outcome == "escalate" and "authentication" in v.reason


def test_scope_passes_plain_bug():
    assert check_scope(bug("The total on page 2 is off by one cent.")).outcome == "pass"


def test_event_chain_detects_tampering(tmp_path):
    log = EventLog(tmp_path, "r1")
    for i in range(3):
        log.emit("station_finished", station=f"s{i}", outcome="escalate")
    assert verify_chain(log.global_path)[0]
    lines = log.global_path.read_text().splitlines()
    entry = json.loads(lines[1]); entry["outcome"] = "pass"
    lines[1] = json.dumps(entry, sort_keys=True)
    log.global_path.write_text("\n".join(lines) + "\n")
    ok, msg = verify_chain(log.global_path)
    assert not ok and "line 2" in msg


def test_scope_escalates_intermittent_bug():
    v = check_scope(bug("A few requests fail randomly during busy periods; we can't reproduce it reliably."))
    assert v.outcome == "escalate" and "non-deterministic" in v.reason


def test_all_trivial_seeded_reports_stay_in_scope():
    from factory.config import Config
    for i in range(1, 6):
        report = BugReport.from_markdown(next(Config().inbox_dir.glob(f"bug{i}_*.md")))
        assert check_scope(report).outcome == "pass", report.id


def test_extract_json_handles_fenced_and_bare_replies():
    from factory.llm import extract_json
    assert extract_json('Thinking...\n```json\n{"trivial": true, "confidence": 0.9}\n```') == {"trivial": True, "confidence": 0.9}
    assert extract_json('Answer: {"verdict": "veto", "concerns": ["a {b}"]} done')["verdict"] == "veto"
    assert extract_json("no json here") is None


def test_model_roles_disabled_means_rules_only():
    from factory.stations.review import review
    assert check_scope(bug("The total on page 2 is off by one cent."), classifier="none").evidence["classifier"] == "disabled"
    assert review(bug("x" * 30), None, "", "", reviewer="none").outcome == "pass"


def test_forged_entry_with_recomputed_hash_fails_signature(tmp_path):
    from factory.events import entry_hash
    log = EventLog(tmp_path, "r1")
    log.emit("station_finished", station="oracle", outcome="escalate")
    entry = json.loads(log.global_path.read_text())
    entry["outcome"] = "pass"
    entry["hash"] = entry_hash(entry)  # an attacker can recompute the hash, but not the signature
    log.global_path.write_text(json.dumps(entry, sort_keys=True) + "\n")
    ok, msg = verify_chain(log.global_path)
    assert not ok and "signature" in msg
