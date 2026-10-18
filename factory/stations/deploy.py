"""Gated deploy. For now: commit the verified fix plus its reproducing test to a release branch
in the run workspace. The canary + automatic rollback gate plugs in here later."""
from factory.models import Run, Verdict
from factory.workspace import Workspace


def deploy(run: Run, ws: Workspace) -> Verdict:
    branch = f"factory/{run.id}"
    ws.git("checkout", "-q", "-b", branch)
    ws.git("add", "-A", "--", ".", ":(exclude).factory")
    msg = f"fix({run.bug.id}): {run.bug.title}\n\nAutonomous fix by Lord of the Dark Factory.\nRun: {run.id}\n"
    res = ws.git("commit", "-q", "-m", msg)
    if res.returncode != 0:
        return Verdict("deploy", "escalate", "Could not commit the verified fix.", {"git": res.stderr.strip()})
    return Verdict("deploy", "pass", f"Fix committed to {branch}. Canary deploy gate not wired yet.",
                   {"branch": branch, "commit": ws.head(), "canary": "not_implemented"})
