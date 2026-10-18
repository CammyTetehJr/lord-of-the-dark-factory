"""Gated deploy.

"branch": commit the verified fix to a branch in the run workspace (no production).
"canary": build production + fix, start it next to stable, shift traffic 10% → 50% → 100%
          while comparing it against stable. Any SLO breach, a failed health check, or a human
          pulling the andon cord rolls it back automatically; stable is never touched.
"""
from typing import Callable

from factory import line
from factory.config import Config
from factory.models import Run, Verdict
from factory.prod import Prod
from factory.traffic import Metrics, run_step
from factory.workspace import Workspace

MAX_ERROR_RATE = 0.01      # at most 1% of canary requests may fail
LATENCY_FACTOR = 2.0       # canary p95 may be at most 2x stable p95 ...
LATENCY_SLACK_MS = 10.0    # ... or stable p95 + 10 ms, whichever is larger
MIN_REQUESTS = 20          # fewer canary requests than this cannot prove anything


def deploy_branch(run: Run, ws: Workspace) -> Verdict:
    branch = f"factory/{run.id}"
    ws.git("checkout", "-q", "-b", branch)
    ws.git("add", "-A", "--", ".", ":(exclude).factory")
    msg = f"fix({run.bug.id}): {run.bug.title}\n\nAutonomous fix by Lord of the Dark Factory.\nRun: {run.id}\n"
    res = ws.git("commit", "-q", "-m", msg)
    if res.returncode != 0:
        return Verdict("deploy", "escalate", "Could not commit the verified fix.", {"git": res.stderr.strip()})
    return Verdict("deploy", "pass", f"Fix committed to {branch} (production deploy not enabled for this run).",
                   {"mode": "branch", "branch": branch, "commit": ws.head()})


def check_slo(canary: Metrics, stable_p95: float) -> tuple[bool, str]:
    if canary.requests < MIN_REQUESTS:
        return False, f"only {canary.requests} canary requests, too few to judge"
    if canary.error_rate > MAX_ERROR_RATE:
        return False, (f"error rate {canary.error_rate:.1%} > {MAX_ERROR_RATE:.0%} "
                       f"({canary.errors}/{canary.requests}; e.g. {canary.error_samples[0] if canary.error_samples else '?'})")
    limit = max(stable_p95 * LATENCY_FACTOR, stable_p95 + LATENCY_SLACK_MS)
    if canary.p(0.95) > limit:
        return False, f"p95 latency {canary.p(0.95):.1f} ms > limit {limit:.1f} ms (stable p95 {stable_p95:.1f} ms)"
    return True, f"errors {canary.error_rate:.1%}, p95 {canary.p(0.95):.1f} ms (limit {limit:.1f} ms)"


def deploy_canary(run: Run, config: Config, emit: Callable[..., None]) -> Verdict:
    prod = Prod(config)
    evidence: dict = {"mode": "canary", "slo": {"max_error_rate": MAX_ERROR_RATE, "latency_factor": LATENCY_FACTOR,
                                                "latency_slack_ms": LATENCY_SLACK_MS}, "steps": []}
    with prod.lock():
        stable = prod.ensure_stable()
        evidence["stable"] = {"commit": stable.commit, "url": stable.url}

        msg = f"fix({run.bug.id}): {run.bug.title}\n\nAutonomous fix by Lord of the Dark Factory.\nRun: {run.id}\n"
        release, err = prod.build_release(f"canary-{run.id}", run.diff, {run.repro_test_path: run.repro_test_code}, msg)
        if err:
            prod.discard(None, release)
            return Verdict("deploy", "escalate", err.capitalize() + ".", evidence)

        suite = Workspace(release, config).run_tests(tag="release")
        evidence["release_suite"] = suite.summary()
        if not suite.passed:
            prod.discard(None, release)
            return Verdict("deploy", "escalate", "Regression suite fails on current production + this fix.", evidence)

        emit("deploy_progress", phase="starting_canary")
        canary = prod.start("canary", release)
        if canary is None:
            prod.discard(None, release)
            return Verdict("deploy", "escalate", "Canary failed its health check; never received traffic.", evidence)
        evidence["canary"] = {"commit": canary.commit, "url": canary.url}

        # reference: stable on its own, same traffic mix
        ref = run_step(stable.url, canary.url, 0, max(1.0, config.canary_step_seconds / 2), config.prod_invoices, seed=1)
        stable_p95 = ref["stable"].p(0.95)
        evidence["stable_reference"] = ref["stable"].summary()

        def rollback(reason: str) -> Verdict:
            prod.discard(canary, release)
            prod._record(event="rolled_back", run_id=run.id, title=run.bug.title, reason=reason)
            emit("deploy_progress", phase="rolled_back", reason=reason)
            return Verdict("deploy", "escalate", f"{reason} Rolled back automatically; stable was never touched.", evidence)

        for i, pct in enumerate(config.canary_steps, 2):
            if line.state(config.runs_dir).get("paused"):
                return rollback(f"Line paused by a human operator at {pct}% canary.")
            emit("deploy_progress", phase="canary_step", canary_pct=pct)
            m = run_step(stable.url, canary.url, pct, config.canary_step_seconds, config.prod_invoices, seed=i)
            if m["stable"].requests >= MIN_REQUESTS:
                stable_p95 = max(stable_p95, m["stable"].p(0.95))
            ok, why = check_slo(m["canary"], stable_p95)
            step = {"canary_pct": pct, "ok": ok, "detail": why, "canary": m["canary"].summary(),
                    "stable": m["stable"].summary()}
            evidence["steps"].append(step)
            emit("deploy_progress", phase="canary_step_finished", **step)
            if not ok:
                return rollback(f"Canary breached SLO at {pct}% traffic: {why}.")

        commit = prod.promote(canary, run.id, run.bug.title)
        evidence["promoted_commit"] = commit
        emit("deploy_progress", phase="promoted", commit=commit)
        steps = " → ".join(f"{s['canary_pct']}%" for s in evidence["steps"])
        return Verdict("deploy", "pass",
                       f"Canary healthy at {steps}; promoted to production ({commit[:10]}).", evidence)
