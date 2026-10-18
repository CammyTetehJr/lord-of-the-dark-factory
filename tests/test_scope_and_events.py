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
