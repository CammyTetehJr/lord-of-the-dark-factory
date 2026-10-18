"""GitHub intake against a fake `gh`: pick-up, no double pick-up, busy line, and reporting back."""
import json
import subprocess

from factory.config import Config
from factory.intake import STATUS, GitHubIntake
from factory.models import Run, Verdict


class FakeGh:
    def __init__(self, issues):
        self.issues = issues
        self.calls: list[tuple] = []

    def __call__(self, *args, input=None):
        self.calls.append((args, input))
        out = json.dumps(self.issues) if args[:2] == ("issue", "list") else ""
        return subprocess.CompletedProcess(args, 0, out, "")

    def comments(self, n):
        return [inp for args, inp in self.calls if args[:3] == ("issue", "comment", str(n))]

    def did(self, *prefix):
        return any(args[:len(prefix)] == prefix for args, _ in self.calls)


ISSUE = {"number": 7, "title": "Customer lookup fails with capitals", "body": "Ada@Example.com gives 404.",
         "url": "https://github.com/o/r/issues/7", "labels": [{"name": "autofix"}]}


def make(tmp_path, issues, submit):
    c = Config()
    c.runs_dir = tmp_path
    gh = FakeGh(issues)
    return GitHubIntake("o/r", submit, c, gh=gh, public_url="https://ctl.example"), gh


def run_with(outcome_verdicts, bug):
    return Run(id="r1", bug=bug, fixer="nemotron", workspace=None, verdicts=outcome_verdicts)


def test_new_issue_goes_on_the_line_once(tmp_path):
    submitted = []
    intake, gh = make(tmp_path, [ISSUE], lambda bug, run_id, on_done: submitted.append((bug, run_id, on_done)) or 0)
    started = intake.poll()
    assert len(started) == 1 and len(submitted) == 1
    bug = submitted[0][0]
    assert (bug.id, bug.title, bug.source) == ("issue7", ISSUE["title"], ISSUE["url"])
    assert gh.did("issue", "edit", "7", "-R", "o/r", "--add-label", STATUS["running"][0])
    assert "Picked up" in gh.comments(7)[0] and "https://ctl.example" in gh.comments(7)[0]
    assert intake.poll() == [] and len(submitted) == 1  # never twice


def test_busy_line_is_retried_next_poll(tmp_path):
    calls = {"n": 0}

    def submit(bug, run_id, on_done):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("The line is busy")
        return 0

    intake, gh = make(tmp_path, [ISSUE], submit)
    assert intake.poll() == [] and "busy" in intake.last_error and gh.comments(7) == []
    assert len(intake.poll()) == 1


def test_already_labelled_issue_is_skipped(tmp_path):
    issue = {**ISSUE, "labels": [{"name": "autofix"}, {"name": STATUS["escalated"][0]}]}
    intake, _ = make(tmp_path, [issue], lambda *a: 0)
    assert intake.poll() == []


def test_report_shipped_closes_with_commit(tmp_path):
    intake, gh = make(tmp_path, [ISSUE], lambda *a: 0)
    intake.poll()
    bug = None
    run = run_with([Verdict("oracle", "pass", "red to green"),
                    Verdict("deploy", "pass", "promoted", {"promoted_commit": "abc1234def999"})], bug)
    intake.report(7, "r1", run)
    body = gh.comments(7)[-1]
    assert "shipped to production" in body and "abc1234def" in body and "| oracle |" in body
    assert gh.did("issue", "close", "7")
    assert gh.did("issue", "edit", "7", "-R", "o/r", "--add-label", STATUS["shipped"][0], "--remove-label", STATUS["running"][0])
    assert intake.state()["7"]["status"] == "shipped"


def test_report_escalated_stays_open_and_needs_human(tmp_path):
    intake, gh = make(tmp_path, [ISSUE], lambda *a: 0)
    run = run_with([Verdict("scope", "escalate", "Out of scope: authentication")], None)
    intake.report(7, "r1", run)
    body = gh.comments(7)[-1]
    assert "Escalated to a human" in body and "**scope**" in body and "did not change production" in body
    assert not gh.did("issue", "close", "7")
    assert gh.did("issue", "edit", "7", "-R", "o/r", "--add-label", "needs-human", "--remove-label", STATUS["running"][0])


def test_report_crashed_run_is_an_escalation(tmp_path):
    intake, gh = make(tmp_path, [ISSUE], lambda *a: 0)
    intake.report(7, "r1", None)
    assert "Escalated to a human" in gh.comments(7)[-1] and not gh.did("issue", "close", "7")


def test_instant_run_reports_after_the_pick_up_comment(tmp_path):
    """Scope can refuse in under a second; the issue must still read 'picked up' then 'escalated'."""
    import threading
    intake = None

    def submit(bug, run_id, on_done):  # the run finishes on another thread before poll() posts its comment
        threading.Thread(target=on_done, args=(run_id, run_with([Verdict("scope", "escalate", "auth")], bug))).start()
        return 0

    intake, gh = make(tmp_path, [ISSUE], submit)
    intake.poll()
    for _ in range(200):
        if len(gh.comments(7)) == 2:
            break
        import time; time.sleep(0.01)
    first, second = gh.comments(7)
    assert "Picked up" in first and "Escalated" in second
