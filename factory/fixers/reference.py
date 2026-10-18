"""Dev stand-in for a real fixer: returns the known-good patch from eval/reference_fixes.
This reads the answer key, so it is only for building and testing the pipeline."""
from pathlib import Path

from factory.config import ROOT
from factory.models import BugReport


class ReferenceFixer:
    name = "reference"

    def __init__(self, fixes_dir: Path = ROOT / "eval" / "reference_fixes"):
        self.fixes_dir = fixes_dir

    def fix(self, bug: BugReport, failing_test: str, repo: Path) -> str:
        matches = sorted(self.fixes_dir.glob(f"{bug.id}_*.patch"))
        if not matches:
            raise FileNotFoundError(f"no reference fix for {bug.id}")
        return matches[0].read_text()
