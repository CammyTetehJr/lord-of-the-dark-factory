"""Sources of reproducing tests.

DevReproducer replays hand-written stand-ins from factory/dev_repro.
NemotronReproducer asks Nemotron for several candidates in parallel; the reproduce gate,
not the model, decides whether any of them qualifies.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from factory import llm
from factory.models import BugReport
from factory.workspace import Workspace

DEV_REPRO_DIR = Path(__file__).resolve().parent / "dev_repro"


@dataclass
class Candidate:
    code: str | None
    meta: dict = field(default_factory=dict)


class DevReproducer:
    name = "dev"

    def candidates(self, bug: BugReport, repo: Workspace) -> list[Candidate]:
        path = DEV_REPRO_DIR / f"{bug.id}.py"
        return [Candidate(path.read_text(), {"source": str(path)})] if path.exists() else []


REPRO_SYSTEM = """You are a senior Python engineer writing a regression test that reproduces a reported bug.

Write ONE pytest file that:
- encodes the CORRECT behaviour described or implied by the bug report, so it FAILS on the current code and will PASS once the bug is fixed;
- is deterministic: same result on every run, no sleeps, no randomness, no reliance on timing;
- uses the existing fixtures and helpers from tests/conftest.py where useful;
- imports only from the standard library, pytest, and the project's own modules;
- is small: one or two focused test functions with clear names;
- does not modify or monkeypatch application code to force the failure.

Do NOT fix the bug. Do NOT explain at length. Reply with a single ```python code block containing the whole test file."""


class NemotronReproducer:
    name = "nemotron"

    def __init__(self, n: int = 3):
        self.n = n

    def _prompt(self, bug: BugReport, repo: Path) -> list[dict]:
        ctx = llm.repo_context(repo, ["app/**/*.py", "tests/conftest.py", "tests/test_invoices.py", "migrations/*.sql"])
        user = f"# Bug report\n## {bug.title}\n{bug.body}\n\n{ctx}\n\nWrite the reproducing test file now."
        return [{"role": "system", "content": REPRO_SYSTEM}, {"role": "user", "content": user}]

    def _one(self, messages: list[dict], i: int) -> Candidate:
        try:
            res = llm.chat("main", messages, temperature=0.4 + 0.2 * i)
        except Exception as e:
            return Candidate(None, {"error": f"{type(e).__name__}: {e}"})
        code = llm.extract_code(res.content)
        meta = res.meta()
        if code is None:
            meta["error"] = "no python code block in response"
            meta["response_tail"] = res.content[-500:]
        return Candidate(code, meta)

    def candidates(self, bug: BugReport, repo: Workspace) -> list[Candidate]:
        messages = self._prompt(bug, repo.path)
        with ThreadPoolExecutor(max_workers=self.n) as pool:
            return list(pool.map(lambda i: self._one(messages, i), range(self.n)))


def get_reproducer(spec: str):
    if spec == "dev":
        return DevReproducer()
    if spec == "nemotron":
        return NemotronReproducer()
    raise ValueError(f"unknown reproducer {spec!r}; use 'dev' or 'nemotron'")
