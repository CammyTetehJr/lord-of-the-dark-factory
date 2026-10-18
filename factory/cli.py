import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

from factory.config import ROOT, Config
from factory.events import verify_chain
from factory.fixers import get_fixer
from factory.models import BugReport
from factory.pipeline import run_pipeline
from factory.reproducers import get_reproducer

ICON = {"pass": "✓", "escalate": "✗"}


def _bugs(config: Config, ids: list[str] | None) -> list[BugReport]:
    reports = [BugReport.from_markdown(p) for p in sorted(config.inbox_dir.glob("*.md"))]
    if ids:
        reports = [b for b in reports if b.id in ids]
        missing = set(ids) - {b.id for b in reports}
        if missing:
            sys.exit(f"no bug report for: {', '.join(sorted(missing))}")
    return reports


def _print_run(run) -> None:
    print(f"\n{run.bug.id}  {run.bug.title}")
    for v in run.verdicts:
        print(f"  {ICON[v.outcome]} {v.station:<16} {v.reason}")
    print(f"  => {run.outcome.upper()}  (run {run.id})")


def cmd_run(args) -> None:
    config = Config()
    for bug in _bugs(config, args.bugs):
        _print_run(run_pipeline(bug, get_fixer(args.fixer), get_reproducer(args.reproducer), config))


def _hidden_test_passes(run, bug_id: str) -> bool | None:
    hidden = sorted((ROOT / "eval" / "hidden_tests").glob(f"test_{bug_id}_*.py"))
    if not hidden:
        return None
    dest = run.workspace / "tests" / hidden[0].name
    shutil.copy(hidden[0], dest)
    config = Config()
    proc = subprocess.run([str(config.target_python), "-m", "pytest", "-q", "-p", "no:cacheprovider", str(dest)],
                          cwd=run.workspace, capture_output=True, text=True)
    dest.unlink()
    return proc.returncode == 0


def cmd_eval(args) -> None:
    """Run every bug, then grade against the answer key. The answer key is read only after the runs."""
    config = Config()
    runs = [run_pipeline(b, get_fixer(args.fixer), get_reproducer(args.reproducer), config)
            for b in _bugs(config, args.bugs)]
    key = {b["id"]: b for b in json.loads((ROOT / "eval" / "bugs.json").read_text())["bugs"]}
    print(f"\n{'bug':<6}{'expected':<10}{'actual':<11}{'station':<17}{'hidden test':<13}result")
    correct = 0
    for run in runs:
        exp = key[run.bug.id]["expected"]
        actual = "ship" if run.outcome == "shipped" else "escalate"
        station = run.escalation.station if run.escalation else "-"
        hidden = _hidden_test_passes(run, run.bug.id) if actual == "ship" else None
        ok = actual == exp and hidden is not False
        correct += ok
        hidden_s = "-" if hidden is None else ("pass" if hidden else "FAIL")
        print(f"{run.bug.id:<6}{exp:<10}{actual:<11}{station:<17}{hidden_s:<13}{'ok' if ok else 'WRONG'}")
    print(f"\n{correct}/{len(runs)} correct")
    if correct != len(runs):
        sys.exit(1)


def cmd_verify(args) -> None:
    ok, msg = verify_chain(Path(args.log) if args.log else Config().runs_dir / "events.jsonl")
    print(("✓ " if ok else "✗ ") + msg)
    sys.exit(0 if ok else 1)


def cmd_setup(args) -> None:
    """Create .target-venv with the target's dependencies (not the target package itself)."""
    config = Config()
    meta = tomllib.loads((config.target_repo / "pyproject.toml").read_text())["project"]
    deps = list(meta.get("dependencies", [])) + [d for ds in meta.get("optional-dependencies", {}).values() for d in ds]
    venv = config.target_python.parent.parent
    subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(config.target_python), "-m", "pip", "install", "-q", *deps], check=True)
    print(f"target env ready: {config.target_python}")


def main() -> None:
    p = argparse.ArgumentParser(prog="factory", description="Lord of the Dark Factory")
    sub = p.add_subparsers(required=True)

    for name, fn, help_ in [("run", cmd_run, "run bugs through the line"),
                            ("eval", cmd_eval, "run bugs and grade against the answer key")]:
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("bugs", nargs="*", help="bug ids (default: all in inbox)")
        sp.add_argument("--fixer", default="reference", help="reference | rogue:<mode>")
        sp.add_argument("--reproducer", default="dev", help="dev")
        sp.set_defaults(fn=fn)

    sp = sub.add_parser("verify", help="verify the event log hash chain")
    sp.add_argument("--log")
    sp.set_defaults(fn=cmd_verify)
    sub.add_parser("setup", help="create the target test environment").set_defaults(fn=cmd_setup)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
