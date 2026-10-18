from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

Outcome = Literal["pass", "escalate"]


@dataclass
class BugReport:
    id: str
    title: str
    body: str
    source: str

    @classmethod
    def from_markdown(cls, path: Path) -> "BugReport":
        text = path.read_text().strip()
        first, _, rest = text.partition("\n")
        return cls(id=path.stem.split("_")[0], title=first.lstrip("# ").strip(),
                   body=rest.strip(), source=str(path))


@dataclass
class Verdict:
    station: str
    outcome: Outcome
    reason: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Run:
    id: str
    bug: BugReport
    fixer: str
    workspace: Path
    verdicts: list[Verdict] = field(default_factory=list)
    repro_test_path: str | None = None
    repro_test_code: str | None = None
    diff: str | None = None

    @property
    def outcome(self) -> str:
        if any(v.outcome == "escalate" for v in self.verdicts):
            return "escalated"
        return "shipped"

    @property
    def escalation(self) -> Verdict | None:
        return next((v for v in self.verdicts if v.outcome == "escalate"), None)
