"""The real black box: Nemotron proposes search/replace edits, we apply them in the fixer's own
copy of the repo, run the failing test, and feed failures back for up to N attempts.

Nothing here is trusted by the factory. The returned diff is re-verified by the oracle and
diff inspection in a separate workspace."""
import re
import subprocess
from pathlib import Path

from factory import llm
from factory.config import Config
from factory.models import BugReport
from factory.policy import Policy

FIX_SYSTEM = """You are a careful senior engineer fixing a bug in a production service.

You get a bug report, a failing test that reproduces it, and the source code.
Make the SMALLEST change to the application code that makes the failing test pass without breaking any other behaviour.

Rules:
- Do not modify, delete or add tests. Do not touch these protected paths: {protected}
- Do not add dependencies, network calls, subprocess calls or secrets.
- Keep the change local: a few lines in one or two files.
- Keep existing function signatures and their meaning unchanged: other code and existing tests rely on them.

Reply with one or more edit blocks in exactly this format and nothing else:

FILE: path/to/file.py
<<<<<<< SEARCH
exact lines copied from the current file
=======
replacement lines
>>>>>>> REPLACE

The SEARCH text must match the current file exactly (including indentation) and be unique in the file.
Keep SEARCH short: just enough lines to be unique."""

EDIT_RE = re.compile(r"FILE:\s*(\S+)\s*\n<<<<<<< SEARCH\n(.*?)\n?=======\n(.*?)\n?>>>>>>> REPLACE", re.S)


def parse_edits(text: str) -> list[tuple[str, str, str]]:
    return [(path.strip().strip("`"), search, replace) for path, search, replace in EDIT_RE.findall(text)]


def apply_edits(repo: Path, edits: list[tuple[str, str, str]]) -> list[str]:
    """Apply edits in place. Returns a list of problems (empty means all applied)."""
    problems = []
    for path, search, replace in edits:
        target = (repo / path).resolve()
        if not str(target).startswith(str(repo.resolve())):
            problems.append(f"{path}: path escapes the repository")
            continue
        if not target.exists():
            problems.append(f"{path}: file does not exist")
            continue
        src = target.read_text()
        count = src.count(search)
        if count != 1:
            problems.append(f"{path}: SEARCH block matched {count} times (must match exactly once)")
            continue
        target.write_text(src.replace(search, replace, 1))
    return problems


class NemotronFixer:
    name = "nemotron"

    def __init__(self, max_attempts: int = 3, config: Config | None = None):
        self.max_attempts = max_attempts
        self.config = config or Config()
        self.last_meta: dict = {}

    def _run(self, repo: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=repo, capture_output=True, text=True, timeout=self.config.test_timeout_s)

    def _test(self, repo: Path, *targets: str) -> tuple[bool, str]:
        p = self._run(repo, str(self.config.target_python), "-m", "pytest", "-q", "-p", "no:cacheprovider",
                      "-p", "no:warnings", "--tb=short", *targets)
        return p.returncode == 0, (p.stdout + p.stderr)[-2500:]

    def fix(self, bug: BugReport, failing_test: str, repo: Path) -> str:
        test_path = next(str(p.relative_to(repo)) for p in (repo / "tests").glob("test_repro_*.py"))
        policy = Policy.load(repo)
        ctx = llm.repo_context(repo, ["app/**/*.py", "migrations/*.sql"])
        messages = [
            {"role": "system", "content": FIX_SYSTEM.format(protected=", ".join(policy.protected_paths) or "none")},
            {"role": "user", "content": f"# Bug report\n## {bug.title}\n{bug.body}\n\n"
                                        f"# Failing test ({test_path})\n```python\n{failing_test}```\n\n{ctx}"},
        ]
        attempts = []
        self.last_meta = {"attempts": attempts}
        for n in range(1, self.max_attempts + 1):
            res = llm.chat("main", messages, temperature=0.2)
            edits = parse_edits(res.content)
            record = {"attempt": n, **res.meta(), "edits": len(edits)}
            attempts.append(record)

            if not edits:
                record["result"] = "no edit blocks in reply"
                feedback = "Your reply contained no valid edit blocks. Use exactly the FILE/SEARCH/REPLACE format."
            elif problems := apply_edits(repo, edits):
                record["result"] = "edits did not apply: " + "; ".join(problems)
                self._run(repo, "git", "checkout", "--", ".")
                feedback = "These edits could not be applied:\n- " + "\n- ".join(problems) + \
                           "\nCopy SEARCH text exactly from the current file."
            else:
                ok, output = self._test(repo, test_path)
                suite_ok, suite_output = self._test(repo) if ok else (False, "")
                if ok and suite_ok:
                    record["result"] = "failing test passes, full suite green"
                    break
                self._run(repo, "git", "checkout", "--", ".")
                if not ok:
                    record["result"] = "test still failing"
                    feedback = f"After your edits the test still fails:\n```\n{output}\n```\nThe edits were reverted. Try again."
                else:
                    record["result"] = "test passes but existing tests broke"
                    feedback = (f"Your edits made the failing test pass but broke existing tests:\n```\n{suite_output}\n```\n"
                                "The edits were reverted. Fix the bug without changing behaviour those tests rely on.")
            messages += [{"role": "assistant", "content": res.content}, {"role": "user", "content": feedback}]
        else:
            return ""  # gave up: the fix station escalates on an empty diff

        # stage everything except the factory's reproducing test, so new files are included too
        self._run(repo, "git", "add", "-A", "--", ".", f":(exclude){test_path}")
        return self._run(repo, "git", "diff", "--cached").stdout
