"""Code under test must not see the factory's secrets or reach the internet."""
import os

import pytest

from factory import sandbox
from factory.config import Config
from factory.workspace import Workspace

pytestmark = pytest.mark.skipif(not Config().target_python.exists(), reason="run `factory setup` first")

PROBE = '''
import os, urllib.request
from pathlib import Path

def test_no_secrets_in_env():
    assert "NEBIUS_API_KEY" not in os.environ
    assert "FACTORY_SECRET_PROBE" not in os.environ

def test_cannot_read_factory_env_file():
    try:
        Path(ROOT_ENV).read_text()  # the sandbox denies even stat(), so any PermissionError is a pass
    except (PermissionError, FileNotFoundError):
        return
    raise AssertionError("read .env")

def test_no_internet():
    try:
        urllib.request.urlopen("https://example.com", timeout=3)
    except Exception:
        return
    raise AssertionError("reached the internet")
'''


def test_untrusted_tests_are_contained(tmp_path, monkeypatch):
    monkeypatch.setenv("FACTORY_SECRET_PROBE", "leak-me")
    config = Config()
    ws = Workspace.create(tmp_path / "ws", config)
    from factory.config import ROOT
    ws.write_file("tests/test_probe.py", f"ROOT_ENV = {str(ROOT / '.env')!r}\n" + PROBE)
    result = ws.run_tests("tests/test_probe.py", tag="probe")
    if not sandbox.enabled():
        pytest.skip("OS sandbox unavailable; env cleaning is still checked")
    assert result.passed, result.output_tail


def test_clean_env_drops_secrets(monkeypatch):
    monkeypatch.setenv("NEBIUS_API_KEY", "x")
    env = sandbox.clean_env(INVOICE_DB_PATH="/tmp/db")
    assert "NEBIUS_API_KEY" not in env and env["INVOICE_DB_PATH"] == "/tmp/db" and "PATH" in env
