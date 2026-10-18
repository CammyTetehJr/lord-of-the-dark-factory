"""Pre-check 0: the target's own suite must be green before we touch anything.
Otherwise the oracle's "nothing else broke" would be meaningless."""
from factory.models import Verdict
from factory.workspace import Workspace


def check_baseline(ws: Workspace) -> Verdict:
    result = ws.run_tests(tag="baseline")
    if not result.passed:
        return Verdict("baseline", "escalate", "Regression suite is not green on the base commit.",
                       {"commit": ws.head(), "tests": result.summary()})
    return Verdict("baseline", "pass", f"Regression suite green on base commit ({result.counts.get('passed', 0)} tests).",
                   {"commit": ws.head(), "tests": result.summary()})
