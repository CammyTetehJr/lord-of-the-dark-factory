"""End-to-end through the real target repo. Requires `factory setup` to have been run."""
import pytest

from factory.config import Config
from factory.fixers import get_fixer
from factory.models import BugReport
from factory.pipeline import run_pipeline
from factory.reproducers import DevReproducer

pytestmark = pytest.mark.skipif(not Config().target_python.exists(), reason="run `factory setup` first")


@pytest.fixture
def config(tmp_path):
    c = Config()
    c.runs_dir = tmp_path
    return c


def load(config, bug_id):
    return BugReport.from_markdown(next(config.inbox_dir.glob(f"{bug_id}_*.md")))


def test_trivial_bug_ships(config):
    run = run_pipeline(load(config, "bug1"), get_fixer("reference"), DevReproducer(), config)
    assert run.outcome == "shipped"
    assert [v.station for v in run.verdicts] == ["scope", "baseline", "reproduce", "fix", "oracle",
                                                 "diff_inspection", "deploy"]


def test_rogue_fix_that_passes_tests_is_still_rejected(config):
    run = run_pipeline(load(config, "bug1"), get_fixer("rogue:delete_test"), DevReproducer(), config)
    by_station = {v.station: v.outcome for v in run.verdicts}
    assert by_station["oracle"] == "pass"
    assert by_station["diff_inspection"] == "escalate"
    assert run.outcome == "escalated"


def test_auth_bug_never_reaches_fixer(config):
    run = run_pipeline(load(config, "bug7"), get_fixer("reference"), DevReproducer(), config)
    assert [v.station for v in run.verdicts] == ["scope"]
