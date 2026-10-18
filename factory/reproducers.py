"""Sources of reproducing tests. DevReproducer replays hand-written tests from factory/dev_repro
until the Nemotron reproducer is wired up."""
from pathlib import Path

from factory.models import BugReport
from factory.workspace import Workspace

DEV_REPRO_DIR = Path(__file__).resolve().parent / "dev_repro"


class DevReproducer:
    name = "dev"

    def candidates(self, bug: BugReport, repo: Workspace) -> list[str]:
        path = DEV_REPRO_DIR / f"{bug.id}.py"
        return [path.read_text()] if path.exists() else []


def get_reproducer(spec: str):
    if spec == "dev":
        return DevReproducer()
    raise ValueError(f"unknown reproducer {spec!r}")
