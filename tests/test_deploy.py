"""Gated deploy against a real (local) production. Requires `factory setup`."""
from dataclasses import replace

import pytest

from factory.config import Config
from factory.fixers import get_fixer
from factory.models import BugReport
from factory.pipeline import run_pipeline
from factory.prod import Prod
from factory.reproducers import DevReproducer
from factory.stations.deploy import check_slo
from factory.traffic import Metrics

pytestmark = pytest.mark.skipif(not Config().target_python.exists(), reason="run `factory setup` first")


def metrics(n: int, ms: float, errors: int = 0) -> Metrics:
    m = Metrics()
    for i in range(n):
        m.add(ms, "HTTP 500" if i < errors else None)
    return m


def test_slo_rules():
    assert check_slo(metrics(100, 5), stable_p95=5)[0]
    assert not check_slo(metrics(100, 5, errors=2), stable_p95=5)[0]       # 2% errors
    assert not check_slo(metrics(100, 40), stable_p95=5)[0]                # 8x slower
    assert check_slo(metrics(100, 14), stable_p95=5)[0]                    # within +10 ms slack
    assert not check_slo(metrics(5, 5), stable_p95=5)[0]                   # too little traffic to judge


@pytest.fixture
def config(tmp_path):
    c = replace(Config(), runs_dir=tmp_path / "runs", deploy_dir=tmp_path / "deploy", canary_step_seconds=1.0)
    yield c
    Prod(c).reset()


def load(config, bug_id):
    return BugReport.from_markdown(next(config.inbox_dir.glob(f"{bug_id}_*.md")))


def test_honest_fix_is_promoted_and_slow_fix_rolled_back(config):
    slow = run_pipeline(load(config, "bug1"), get_fixer("rogue:slow_fix"), DevReproducer(), config, deploy="canary")
    assert {v.station: v.outcome for v in slow.verdicts}["oracle"] == "pass"
    assert slow.escalation.station == "deploy" and "SLO" in slow.escalation.reason

    good = run_pipeline(load(config, "bug1"), get_fixer("reference"), DevReproducer(), config, deploy="canary")
    assert good.outcome == "shipped"
    status = Prod(config).status()
    assert status["up"] and status["mainline"][0].split(" ", 1)[1].startswith("fix(bug1)")
