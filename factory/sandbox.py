"""Runtime containment for code the factory did not write: Nemotron's tests and fixes, and the
target service itself. Every such process gets

  - a clean environment: no API keys or other secrets, only what Python needs to run;
  - on macOS, a sandbox-exec profile: no outbound network except localhost, and no read access to
    the factory's secrets (.env, signing key) or the operator's credentials.

The gates judge the diff, but the code runs while being judged; this closes that gap.
Set FACTORY_SANDBOX=off to disable (local debugging only).
"""
import os
import shutil
import sys
from pathlib import Path

from factory.config import ROOT

ENV_ALLOWLIST = ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "USER")


def clean_env(**extra: str) -> dict[str, str]:
    env = {k: os.environ[k] for k in ENV_ALLOWLIST if k in os.environ}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra)
    return env


def _profile() -> str:
    home = Path.home()
    secrets = [ROOT / ".env", ROOT / ".factory-keys", home / ".ssh", home / ".aws", home / ".config",
               home / ".netrc", home / ".docker", home / "Library" / "Application Support" / "ngrok",
               home / "Library" / "Keychains"]
    denies = "\n".join(f'(deny file-read* (subpath "{p}"))' if not p.suffix and p.name != ".env"
                       else f'(deny file-read* (literal "{p}"))' for p in secrets)
    return f"""(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
{denies}
"""


def enabled() -> bool:
    return (os.environ.get("FACTORY_SANDBOX", "on") != "off" and sys.platform == "darwin"
            and shutil.which("sandbox-exec") is not None)


def wrap(cmd: list[str]) -> list[str]:
    """Prefix a command so it runs inside the sandbox (no-op where unavailable)."""
    return ["sandbox-exec", "-p", _profile(), *cmd] if enabled() else cmd


def describe() -> dict:
    return {"clean_env": True, "os_sandbox": "sandbox-exec" if enabled() else "unavailable",
            "network": "localhost only" if enabled() else "unrestricted"}
