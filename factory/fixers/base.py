from pathlib import Path
from typing import Protocol

from factory.models import BugReport


class Fixer(Protocol):
    """The black box. Gets a bug, the failing test and its own copy of the repo; returns a unified diff."""
    name: str

    def fix(self, bug: BugReport, failing_test: str, repo: Path) -> str: ...
