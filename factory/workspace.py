"""Isolated copy of the target repo for one run, plus a pytest runner that reports why tests failed."""
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from factory import sandbox
from factory.config import Config


@dataclass
class TestCase:
    name: str
    status: str  # passed | failed | error | skipped
    error_type: str | None = None
    message: str | None = None


@dataclass
class TestResult:
    exit_code: int
    cases: list[TestCase] = field(default_factory=list)
    output_tail: str = ""

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and bool(self.cases) and all(c.status in ("passed", "skipped") for c in self.cases)

    @property
    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for c in self.cases:
            out[c.status] = out.get(c.status, 0) + 1
        return out

    def summary(self) -> dict:
        return {
            "exit_code": self.exit_code,
            "counts": self.counts,
            "failures": [
                {"test": c.name, "status": c.status, "error_type": c.error_type, "message": (c.message or "")[:300]}
                for c in self.cases if c.status in ("failed", "error")
            ],
        }


def _error_type(message: str | None, text: str | None) -> str | None:
    # pytest puts "ExcType: msg" or "assert ..." in the message attribute
    for source in (message or "", text or ""):
        if source.startswith("assert") or "AssertionError" in source.split("\n")[0]:
            return "AssertionError"
        head = source.split(":", 1)[0].strip().split(".")[-1]
        if head.endswith(("Error", "Exception")):
            return head
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith("E ") and ":" in line:
            head = line[1:].split(":", 1)[0].strip().split(".")[-1]
            if head.endswith(("Error", "Exception")):
                return head
    return None


class Workspace:
    def __init__(self, path: Path, config: Config):
        self.path = path
        self.config = config

    @classmethod
    def create(cls, path: Path, config: Config) -> "Workspace":
        subprocess.run(["git", "clone", "-q", "--no-hardlinks", str(config.target_repo), str(path)], check=True)
        subprocess.run(["git", "checkout", "-q", config.target_ref], cwd=path, check=True)
        subprocess.run(["git", "config", "user.email", "factory@lord-of-the-dark-factory"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.name", "Dark Factory"], cwd=path, check=True)
        return cls(path, config)

    def git(self, *args: str, input: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.path, input=input, capture_output=True, text=True)

    def head(self) -> str:
        return self.git("rev-parse", "HEAD").stdout.strip()

    def reset(self) -> None:
        self.git("reset", "-q", "--hard", "HEAD")
        self.git("clean", "-qfd")

    def write_file(self, rel: str, content: str) -> None:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def apply_diff(self, diff: str) -> tuple[bool, str]:
        if not diff.endswith("\n"):
            diff += "\n"
        check = self.git("apply", "--check", "--whitespace=nowarn", "-", input=diff)
        if check.returncode != 0:
            return False, check.stderr.strip()
        res = self.git("apply", "--whitespace=nowarn", "-", input=diff)
        return res.returncode == 0, res.stderr.strip()

    def run_tests(self, *targets: str, tag: str = "run") -> TestResult:
        report = self.path / ".factory" / f"junit-{tag}.xml"
        report.parent.mkdir(exist_ok=True)
        report.unlink(missing_ok=True)
        cmd = [str(self.config.target_python), "-m", "pytest", "-q", "-p", "no:cacheprovider",
               "-p", "no:warnings", f"--junitxml={report}", *targets]
        try:
            proc = subprocess.run(sandbox.wrap(cmd), cwd=self.path, capture_output=True, text=True,
                                  timeout=self.config.test_timeout_s, env=sandbox.clean_env())
            exit_code, out = proc.returncode, proc.stdout + proc.stderr
        except subprocess.TimeoutExpired as e:
            return TestResult(exit_code=-1, output_tail=f"timeout after {e.timeout}s")
        return TestResult(exit_code=exit_code, cases=_parse_junit(report), output_tail=out[-3000:])


def _parse_junit(report: Path) -> list[TestCase]:
    if not report.exists():
        return []
    cases = []
    for tc in ET.parse(report).getroot().iter("testcase"):
        name = f"{tc.get('classname')}::{tc.get('name')}"
        failure, error, skipped = tc.find("failure"), tc.find("error"), tc.find("skipped")
        if failure is not None:
            cases.append(TestCase(name, "failed", _error_type(failure.get("message"), failure.text),
                                  failure.get("message")))
        elif error is not None:
            cases.append(TestCase(name, "error", _error_type(error.get("message"), error.text),
                                  error.get("message")))
        elif skipped is not None:
            cases.append(TestCase(name, "skipped"))
        else:
            cases.append(TestCase(name, "passed"))
    return cases
