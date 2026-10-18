"""Post-check B, diff inspection: is the change itself acceptable, regardless of what the tests say?"""
import fnmatch
import re

from factory.diffparse import FileChange, parse_diff
from factory.models import Verdict
from factory.policy import DEPENDENCY_FILES, Policy

SECRET_PATTERNS = {
    "private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "AWS access key": r"\bAKIA[0-9A-Z]{16}\b",
    "NVIDIA API key": r"\bnvapi-[A-Za-z0-9_\-]{20,}",
    "OpenAI-style key": r"\bsk-[A-Za-z0-9_\-]{20,}",
    "GitHub token": r"\bgh[pousr]_[A-Za-z0-9]{30,}",
    "hardcoded credential": r"(?i)\b(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{12,}['\"]",
}

SUSPICIOUS_CODE = {
    "dynamic code execution": r"\b(eval|exec|compile)\s*\(",
    "shell / process execution": r"\b(subprocess|os\.system|os\.popen|pty\.spawn)\b",
    "network access": r"\b(import|from)\s+(requests|httpx|urllib|socket|http\.client|aiohttp)\b|urlopen\s*\(",
    "deserialization": r"\b(pickle|marshal)\.loads?\s*\(",
    "concurrency change": r"\b(threading|multiprocessing)\b|\b(Lock|RLock|Semaphore|Condition)\s*\(",
}


def _match(path: str, patterns: list[str]) -> str | None:
    name = path.rsplit("/", 1)[-1]
    for p in patterns:
        if fnmatch.fnmatch(path, p) or fnmatch.fnmatch(name, p):
            return p
    return None


def inspect_diff(diff: str, policy: Policy, repro_path: str) -> Verdict:
    files = parse_diff(diff)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": ok, "detail": detail})

    lines = sum(len(f.added) + len(f.removed) for f in files)
    hunks = sum(f.hunks for f in files)
    check("non_empty", bool(files), f"{len(files)} file(s) changed")
    check("max_files_changed", len(files) <= policy.max_files_changed,
          f"{len(files)} file(s), limit {policy.max_files_changed}")
    check("max_lines_changed", lines <= policy.max_lines_changed, f"{lines} line(s), limit {policy.max_lines_changed}")
    check("max_hunks", hunks <= policy.max_hunks, f"{hunks} hunk(s), limit {policy.max_hunks}")

    protected = [(f.path, p) for f in files for p in [_match(f.path, policy.protected_paths)] if p]
    check("protected_paths", not protected,
          "; ".join(f"{f} matches {p}" for f, p in protected) or "no protected paths touched")

    if policy.forbid_dependency_changes:
        deps = [f.path for f in files if _match(f.path, DEPENDENCY_FILES)]
        check("dependency_changes", not deps, ", ".join(deps) or "no dependency manifests touched")

    def touches_tests(f: FileChange) -> bool:
        return f.path.startswith("tests/") or f.path.rsplit("/", 1)[-1].startswith("test_")

    repro_touched = [f.path for f in files if f.path == repro_path]
    check("repro_test_untouched", not repro_touched,
          "fixer modified the reproducing test" if repro_touched else "reproducing test not modified")
    if policy.forbid_test_deletions:
        weakened = [f"{f.path} ({'deleted' if f.is_deleted else f'-{len(f.removed)} lines'})"
                    for f in files if touches_tests(f) and (f.is_deleted or f.removed)]
        check("test_deletions", not weakened, ", ".join(weakened) or "no existing test removed or modified")

    added = [(f.path, line) for f in files for line in f.added]
    if policy.forbid_secrets:
        secrets = [f"{kind} in {path}" for path, line in added for kind, pat in SECRET_PATTERNS.items()
                   if re.search(pat, line)]
        check("secrets", not secrets, "; ".join(sorted(set(secrets))) or "no secrets in added lines")

    suspicious = [f"{kind} in {path}: {line.strip()[:80]}" for path, line in added
                  for kind, pat in SUSPICIOUS_CODE.items() if re.search(pat, line)]
    check("suspicious_code", not suspicious, "; ".join(suspicious) or "no risky calls added")

    failed = [c for c in checks if not c["ok"]]
    evidence = {"files": [f.path for f in files], "lines_changed": lines, "hunks": hunks, "checks": checks}
    if failed:
        return Verdict("diff_inspection", "escalate",
                       "Diff rejected: " + "; ".join(f"{c['check']} ({c['detail']})" for c in failed), evidence)
    return Verdict("diff_inspection", "pass",
                   f"Diff is small and clean: {len(files)} file(s), {lines} line(s), all {len(checks)} checks passed.",
                   evidence)
