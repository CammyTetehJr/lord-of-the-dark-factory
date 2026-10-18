import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    target_repo: Path = field(default_factory=lambda: Path(
        os.environ.get("FACTORY_TARGET_REPO", ROOT.parent / "dark-factory-target")).resolve())
    target_ref: str = os.environ.get("FACTORY_TARGET_REF", "main")
    # Interpreter with the target's dependencies installed (not the target package itself),
    # so tests always import code from the run's workspace.
    target_python: Path = field(default_factory=lambda: Path(
        os.environ.get("FACTORY_TARGET_PYTHON", ROOT / ".target-venv" / "bin" / "python")))
    runs_dir: Path = field(default_factory=lambda: Path(
        os.environ.get("FACTORY_RUNS_DIR", ROOT / "runs")))
    inbox_dir: Path = field(default_factory=lambda: Path(
        os.environ.get("FACTORY_INBOX_DIR", ROOT / "eval" / "bugs")))
    test_timeout_s: int = 180
    # production simulation for the gated deploy
    deploy_dir: Path = field(default_factory=lambda: Path(
        os.environ.get("FACTORY_DEPLOY_DIR", ROOT / "deploy")))
    canary_steps: tuple[int, ...] = (10, 50, 100)
    canary_step_seconds: float = float(os.environ.get("FACTORY_CANARY_STEP_SECONDS", "4"))
    prod_invoices: int = int(os.environ.get("FACTORY_PROD_INVOICES", "50000"))
