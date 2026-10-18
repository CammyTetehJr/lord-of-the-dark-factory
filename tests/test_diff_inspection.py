from factory.diffparse import parse_diff
from factory.policy import Policy
from factory.stations.diff_inspection import inspect_diff

POLICY = Policy(protected_paths=["app/auth/**", "migrations/**", "pyproject.toml"])
REPRO = "tests/test_repro_bug1.py"


def diff(path: str, removed: list[str], added: list[str]) -> str:
    body = "".join(f"-{l}\n" for l in removed) + "".join(f"+{l}\n" for l in added)
    return (f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
            f"@@ -1,{len(removed)} +1,{len(added)} @@\n{body}")


def failed_checks(d: str) -> set[str]:
    v = inspect_diff(d, POLICY, REPRO)
    return {c["check"] for c in v.evidence["checks"] if not c["ok"]}


def test_parse_counts_lines_and_hunks():
    [f] = parse_diff(diff("app/x.py", ["a"], ["b", "c"]))
    assert (f.path, f.removed, f.added, f.hunks) == ("app/x.py", ["a"], ["b", "c"], 1)


def test_small_clean_diff_passes():
    v = inspect_diff(diff("app/invoices.py", ["x = 1"], ["x = 2"]), POLICY, REPRO)
    assert v.outcome == "pass"


def test_protected_path_rejected():
    assert "protected_paths" in failed_checks(diff("app/auth/keys.py", ["a"], ["b"]))


def test_dependency_change_rejected():
    assert "dependency_changes" in failed_checks(diff("requirements.txt", [], ["requests"]))


def test_removing_test_lines_rejected():
    assert "test_deletions" in failed_checks(diff("tests/test_invoices.py", ["    assert x"], []))


def test_editing_repro_test_rejected():
    assert "repro_test_untouched" in failed_checks(diff(REPRO, [], ["# hi"]))


def test_secret_rejected():
    assert "secrets" in failed_checks(diff("app/db.py", [], ['KEY = "nvapi-abcdefghijklmnopqrstuvwxyz123"']))


def test_network_import_rejected():
    assert "suspicious_code" in failed_checks(diff("app/db.py", [], ["import requests"]))


def test_size_limit_rejected():
    assert "max_lines_changed" in failed_checks(diff("app/db.py", [], [f"x{i} = {i}" for i in range(40)]))


def test_empty_diff_rejected():
    assert inspect_diff("", POLICY, REPRO).outcome == "escalate"


def test_concurrency_change_rejected():
    assert "suspicious_code" in failed_checks(diff("app/numbering.py", [], ["        self._lock = threading.Lock()"]))


def test_threaded_repro_test_rejected_before_running():
    from factory.stations.reproduce import _static_nondeterminism
    assert "threads" in _static_nondeterminism("import threading\ndef test_x(): ...")
    assert _static_nondeterminism("def test_x(client):\n    assert client.get('/').status_code == 200") == []
