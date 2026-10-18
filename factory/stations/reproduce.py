"""Pre-check 2: can we get a test that reproduces the bug?

A candidate test qualifies only if, on the unmodified code, it:
  - collects at least one test,
  - fails on every rerun, with the same failing tests each time (deterministic),
  - fails for a plausible reason: no collection/fixture errors, no ImportError/SyntaxError/NameError
    (those mean the test is broken, not that it found the bug).
"""
import re
from typing import Protocol

from factory.models import BugReport, Verdict
from factory.policy import Policy
from factory.workspace import TestResult, Workspace

BROKEN_TEST_ERRORS = {"ImportError", "ModuleNotFoundError", "SyntaxError", "IndentationError", "NameError"}

# A test using any of these can pass or fail by chance, so its red runs are not evidence.
NONDETERMINISTIC_CONSTRUCTS = {
    "threads": r"\b(import threading|from threading|ThreadPoolExecutor|threading\.Thread)\b",
    "processes": r"\b(multiprocessing|ProcessPoolExecutor)\b",
    "async concurrency": r"\basyncio\.(gather|create_task|wait)\b",
    "sleeps / timing": r"\btime\.sleep\s*\(|\bimport time\b",
    "randomness": r"\bimport random\b|\brandom\.\w+\(",
}


def _static_nondeterminism(code: str) -> list[str]:
    return [kind for kind, pat in NONDETERMINISTIC_CONSTRUCTS.items() if re.search(pat, code)]


class Reproducer(Protocol):
    name: str

    def candidates(self, bug: BugReport, repo: Workspace) -> list:
        """Return Candidate objects (code + metadata) that should reproduce the bug."""


def repro_test_path(bug: BugReport) -> str:
    return f"tests/test_repro_{bug.id}.py"


def _judge(results: list[TestResult]) -> tuple[bool, str]:
    first = results[0]
    if not first.cases:
        return False, "no tests collected (likely an import or syntax error)"
    for i, r in enumerate(results, 1):
        errors = [c for c in r.cases if c.status == "error"]
        if errors:
            return False, f"run {i}: test errored during setup ({errors[0].error_type or 'unknown'})"
        broken = [c for c in r.cases if c.status == "failed" and c.error_type in BROKEN_TEST_ERRORS]
        if broken:
            return False, f"run {i}: failed for the wrong reason ({broken[0].error_type}); the test itself is broken"
        if r.passed:
            return False, f"run {i}: test passed on the buggy code, so it does not reproduce the bug"
    failing_sets = [frozenset(c.name for c in r.cases if c.status == "failed") for r in results]
    if len(set(failing_sets)) != 1:
        return False, "failing tests changed between reruns (non-deterministic)"
    return True, f"fails deterministically on {len(results)}/{len(results)} runs"


def judge_test(ws: Workspace, path: str, code: str, policy: Policy, tag: str = "c") -> tuple[bool, str, list[TestResult]]:
    """Does this test qualify as a reproduction on the workspace's current (unfixed) code?"""
    if kinds := _static_nondeterminism(code):
        return False, f"test relies on {', '.join(kinds)}, so it can only reproduce the bug by chance", []
    ws.write_file(path, code)
    results = [ws.run_tests(path, tag=f"repro-{tag}-r{i}") for i in range(policy.repro_reruns)]
    (ws.path / path).unlink()
    ok, why = _judge(results)
    return ok, why, results


def reproduce(bug: BugReport, ws: Workspace, reproducer: Reproducer, policy: Policy) -> tuple[Verdict, str | None]:
    path = repro_test_path(bug)
    attempts = []
    candidates = reproducer.candidates(bug, ws)
    for n, cand in enumerate(candidates, 1):
        code = cand.code
        if not code:
            attempts.append({"candidate": n, "qualified": False, "runs": [],
                             "reason": cand.meta.get("error", "no test produced"), "generator": cand.meta})
            continue
        ok, why, results = judge_test(ws, path, code, policy, tag=f"c{n}")
        attempts.append({"candidate": n, "qualified": ok, "reason": why,
                         "runs": ["red" if not r.passed else "green" for r in results],
                         "first_run": results[0].summary() if results else None,
                         "generator": cand.meta, "test_code": code})
        if ok:
            return Verdict("reproduce", "pass", f"Reproducing test found: {why}.",
                           {"reproducer": reproducer.name, "test_path": path, "attempts": attempts,
                            "test_code": code}), code
    reason = (f"None of {len(attempts)} candidate tests reproduces the bug reliably." if attempts
              else "Reproducer produced no candidate tests.")
    return Verdict("reproduce", "escalate", reason,
                   {"reproducer": reproducer.name, "attempts": attempts}), None
