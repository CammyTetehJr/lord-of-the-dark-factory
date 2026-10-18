"""The black box. We hand the fixer its own copy of the repo plus the failing test and get a diff back.
Nothing it does inside is trusted; post-checks judge only the diff."""
import shutil
import subprocess
import time
import traceback

from factory.fixers.base import Fixer
from factory.models import BugReport, Verdict
from factory.workspace import Workspace


def run_fixer(bug: BugReport, ws: Workspace, repro_path: str, repro_code: str, fixer: Fixer) -> tuple[Verdict, str | None]:
    sandbox = ws.path.parent / "fixer_workspace"
    shutil.rmtree(sandbox, ignore_errors=True)
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", str(ws.path), str(sandbox)], check=True)
    (sandbox / repro_path).write_text(repro_code)
    started = time.monotonic()
    try:
        diff = fixer.fix(bug, repro_code, sandbox)
    except Exception as e:  # the box is untrusted; any crash is an escalation, not a pipeline failure
        return Verdict("fix", "escalate", f"Fixer crashed: {type(e).__name__}: {e}",
                       {"fixer": fixer.name, "traceback": traceback.format_exc()[-2000:]}), None
    elapsed = round(time.monotonic() - started, 2)
    if not diff or not diff.strip():
        return Verdict("fix", "escalate", "Fixer returned no change.", {"fixer": fixer.name, "seconds": elapsed}), None
    return Verdict("fix", "pass", "Fixer returned a diff (not yet trusted).",
                   {"fixer": fixer.name, "seconds": elapsed, "diff": diff}), diff
