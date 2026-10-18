"""Loads the target repo's .darkfactory.yml. Missing keys fall back to strict defaults."""
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEPENDENCY_FILES = [
    "pyproject.toml", "setup.py", "setup.cfg", "requirements*.txt", "Pipfile", "Pipfile.lock",
    "poetry.lock", "uv.lock", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]


@dataclass
class Policy:
    protected_paths: list[str] = field(default_factory=list)
    max_files_changed: int = 2
    max_lines_changed: int = 30
    max_hunks: int = 4
    forbid_dependency_changes: bool = True
    forbid_test_deletions: bool = True
    forbid_secrets: bool = True
    repro_reruns: int = 3
    suite_reruns_on_failure: int = 2

    @classmethod
    def load(cls, repo: Path) -> "Policy":
        path = repo / ".darkfactory.yml"
        if not path.exists():
            return cls()
        raw = yaml.safe_load(path.read_text()) or {}
        limits = raw.get("limits", {})
        forbid = raw.get("forbid", {})
        oracle = raw.get("oracle", {})
        d = cls()
        return cls(
            protected_paths=list(raw.get("protected_paths", [])),
            max_files_changed=limits.get("max_files_changed", d.max_files_changed),
            max_lines_changed=limits.get("max_lines_changed", d.max_lines_changed),
            max_hunks=limits.get("max_hunks", d.max_hunks),
            forbid_dependency_changes=forbid.get("dependency_changes", True),
            forbid_test_deletions=forbid.get("test_deletions", True),
            forbid_secrets=forbid.get("secrets", True),
            repro_reruns=oracle.get("repro_reruns", d.repro_reruns),
            suite_reruns_on_failure=oracle.get("suite_reruns_on_failure", d.suite_reruns_on_failure),
        )
