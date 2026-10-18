"""Is the bug already fixed in production?

Each fix is built on the base commit, but production moves on as other fixes are promoted. Before
spending model calls on a fix, run the reproducing test against what production runs now. If it
already passes, the bug is closed with a pointer to the production commit that fixed it.
"""
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

from factory.config import Config
from factory.policy import Policy
from factory.prod import Prod
from factory.workspace import Workspace


def _passes(ws: Workspace, path: str, code: str, reruns: int) -> bool:
    ws.write_file(path, code)
    try:
        return all(ws.run_tests(path, tag=f"prod-check-{i}").passed for i in range(reruns))
    finally:
        (ws.path / path).unlink(missing_ok=True)


def check_production(base_commit: str, test_path: str, test_code: str, policy: Policy, config: Config,
                     scratch: Path) -> dict | None:
    """None if production does not exist or still has the bug; otherwise details of the fixing commit."""
    prod = Prod(config)
    if not (prod.mainline / ".git").exists():
        return None
    commits = prod.git(prod.mainline, "rev-list", "--reverse", f"{base_commit}..HEAD").stdout.split()
    if not commits:
        return None

    shutil.rmtree(scratch, ignore_errors=True)
    ws = Workspace.create(scratch, replace(config, target_repo=prod.mainline, target_ref=commits[-1]))
    try:
        if not _passes(ws, test_path, test_code, policy.repro_reruns):
            return None
        # walk production history to name the commit that fixed it (first one where the test passes)
        fixed_by = commits[-1]
        for sha in commits[:-1]:
            subprocess.run(["git", "checkout", "-q", sha], cwd=ws.path, check=True)
            if _passes(ws, test_path, test_code, 1):
                fixed_by = sha
                break
        subject = prod.git(prod.mainline, "log", "-1", "--format=%s", fixed_by).stdout.strip()
        return {"production_head": commits[-1], "fixed_by": fixed_by, "fixed_by_subject": subject}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
