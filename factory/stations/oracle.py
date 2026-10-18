"""Post-check A, the oracle: does the behaviour prove the bug is gone and nothing else broke?"""
from factory.models import Verdict
from factory.policy import Policy
from factory.workspace import Workspace


def oracle(ws: Workspace, diff: str, repro_path: str, repro_code: str, policy: Policy) -> Verdict:
    ws.reset()
    applied, err = ws.apply_diff(diff)
    if not applied:
        return Verdict("oracle", "escalate", "Diff does not apply cleanly to the base commit.", {"git_apply": err})
    ws.write_file(repro_path, repro_code)

    repro_runs = [ws.run_tests(repro_path, tag=f"oracle-repro-{i}") for i in range(policy.repro_reruns)]
    repro_ok = all(r.passed for r in repro_runs)
    suite = ws.run_tests(tag="oracle-suite")
    suite_attempts = [suite.summary()]
    flaky = False
    if not suite.passed:
        for i in range(policy.suite_reruns_on_failure):
            again = ws.run_tests(tag=f"oracle-suite-rerun-{i}")
            suite_attempts.append(again.summary())
            if again.passed:
                flaky = True
    evidence = {
        "repro_test": {"path": repro_path, "runs": ["green" if r.passed else "red" for r in repro_runs],
                       "last": repro_runs[-1].summary()},
        "suite": {"attempts": suite_attempts, "flaky": flaky},
    }
    if not repro_ok:
        return Verdict("oracle", "escalate", "Reproducing test is not green on every run after the fix.", evidence)
    if not suite.passed:
        why = "Regression suite is flaky after the fix." if flaky else "Fix breaks the regression suite."
        return Verdict("oracle", "escalate", why, evidence)
    n = suite.counts.get("passed", 0)
    return Verdict("oracle", "pass",
                   f"Reproducing test red to green ({len(repro_runs)}/{len(repro_runs)} runs); full suite green ({n} tests).",
                   evidence)
