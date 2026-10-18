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

ICON = {"pass": "✓", "escalate": "✗", "closed": "○"}


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
        _print_run(run_pipeline(bug, get_fixer(args.fixer), get_reproducer(args.reproducer), config,
                                classifier=args.classifier, reviewer=args.reviewer, deploy=args.deploy))


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
    runs = [run_pipeline(b, get_fixer(args.fixer), get_reproducer(args.reproducer), config,
                         classifier=args.classifier, reviewer=args.reviewer, deploy=args.deploy)
            for b in _bugs(config, args.bugs)]
    key = {b["id"]: b for b in json.loads((ROOT / "eval" / "bugs.json").read_text())["bugs"]}
    print(f"\n{'bug':<6}{'expected':<10}{'actual':<11}{'station':<17}{'hidden test':<13}result")
    correct = 0
    for run in runs:
        exp = key[run.bug.id]["expected"]
        actual = {"shipped": "ship", "escalated": "escalate"}.get(run.outcome, run.outcome)
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
    ok, msg = verify_chain(Path(args.log) if args.log else Config().runs_dir / "events.jsonl",
                           Path(args.pubkey) if args.pubkey else None)
    print(("✓ " if ok else "✗ ") + msg)
    sys.exit(0 if ok else 1)


def cmd_replay(args) -> None:
    from factory.replay import replay
    r = replay(args.run_id)
    i = r["integrity"]
    print(f"\nreplay {r['run_id']}  ({r['bug']}, commit {r['commit'][:10]}, recorded outcome: {r['outcome']})")
    print(f"  integrity: {i['events']} events, {'all signatures valid' if not i['bad_events'] else 'BAD: ' + str(i['bad_events'])}; "
          + ", ".join(f"{a['artifact']} {'matches' if a['ok'] else 'DOES NOT MATCH'} its signed hash" for a in i["artifacts"]))
    for row in r["stations"]:
        mark = {True: "✓", False: "✗", None: "·"}[row["match"]]
        what = f"{row['recorded']} → {row['replayed']}" if row["kind"] == "deterministic" else f"{row['recorded']} ({row['kind']})"
        print(f"  {mark} {row['station']:<16} {what:<22} {row['note'][:90]}")
    print("  => REPLAY " + ("CONFIRMS THE RECORD" if r["ok"] else "DOES NOT MATCH THE RECORD"))
    sys.exit(0 if r["ok"] else 1)


def cmd_pubkey(args) -> None:
    from factory import signing
    print(signing.public_pem().decode(), end="")
    print(f"key id: {signing.key_id()}")


def cmd_prod(args) -> None:
    from factory.prod import Prod
    prod = Prod()
    if args.action == "status":
        st = prod.status()
        print(f"stable: {'UP' if st['up'] else 'DOWN'}  {st['url'] or '-'}")
        print("production commits:")
        for c in st["mainline"]:
            print(f"  {c}")
        for h in st["history"][-8:]:
            print(f"  {h['ts']}  {h['event']:<16} {h.get('title') or h.get('reason') or h.get('commit', '')[:10]}")
    elif args.action == "start":
        with prod.lock():
            print(f"stable up at {prod.ensure_stable().url}")
    elif args.action == "rollback":
        r = prod.rollback_last("cli")
        print(("✓ " if r["ok"] else "✗ ") + r["message"])
    elif args.action == "reset":
        prod.reset()
        print("production environment removed")


def cmd_setup(args) -> None:
    """Create .target-venv with the target's dependencies (not the target package itself)."""
    config = Config()
    meta = tomllib.loads((config.target_repo / "pyproject.toml").read_text())["project"]
    deps = list(meta.get("dependencies", [])) + [d for ds in meta.get("optional-dependencies", {}).values() for d in ds]
    venv = config.target_python.parent.parent
    subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(config.target_python), "-m", "pip", "install", "-q", *deps], check=True)
    print(f"target env ready: {config.target_python}")


def cmd_serve(args) -> None:
    import uvicorn
    uvicorn.run("factory.server:app", host=args.host, port=args.port)


def cmd_line(args) -> None:
    from factory import line
    s = line.set_paused(Config().runs_dir, args.action == "pause", "cli", args.reason)
    print(f"line {'PAUSED' if s['paused'] else 'running'}")


def main() -> None:
    p = argparse.ArgumentParser(prog="factory", description="Lord of the Dark Factory")
    sub = p.add_subparsers(required=True)

    for name, fn, help_ in [("run", cmd_run, "run bugs through the line"),
                            ("eval", cmd_eval, "run bugs and grade against the answer key")]:
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("bugs", nargs="*", help="bug ids (default: all in inbox)")
        sp.add_argument("--fixer", default="reference", help="reference | nemotron | rogue:<mode>")
        sp.add_argument("--reproducer", default="dev", help="dev | nemotron")
        sp.add_argument("--classifier", default="none", choices=["none", "nemotron"], help="scope classifier")
        sp.add_argument("--reviewer", default="none", choices=["none", "nemotron"], help="veto reviewer")
        sp.add_argument("--deploy", default="branch", choices=["branch", "canary"], help="gated deploy mode")
        sp.add_argument("--live", action="store_true", help="shorthand: Nemotron for every role, canary deploy")
        sp.set_defaults(fn=fn)

    sp = sub.add_parser("verify", help="verify the event log hash chain and signatures")
    sp.add_argument("--log")
    sp.add_argument("--pubkey", help="PEM public key to verify against (default: this factory's key)")
    sp.set_defaults(fn=cmd_verify)
    sub.add_parser("setup", help="create the target test environment").set_defaults(fn=cmd_setup)
    sp = sub.add_parser("replay", help="re-verify a past run from its signed record")
    sp.add_argument("run_id")
    sp.set_defaults(fn=cmd_replay)
    sub.add_parser("pubkey", help="print the audit public key").set_defaults(fn=cmd_pubkey)
    sp = sub.add_parser("prod", help="production environment: status, start, rollback (kill switch), reset")
    sp.add_argument("action", choices=["status", "start", "rollback", "reset"])
    sp.set_defaults(fn=cmd_prod)
    sp = sub.add_parser("serve", help="HTTP API for the UI")
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=8100)
    sp.set_defaults(fn=cmd_serve)
    sp = sub.add_parser("line", help="pause or resume the line (andon cord)")
    sp.add_argument("action", choices=["pause", "resume"])
    sp.add_argument("--reason", default="")
    sp.set_defaults(fn=cmd_line)

    args = p.parse_args()
    if getattr(args, "live", False):
        args.fixer = args.fixer if args.fixer != "reference" else "nemotron"
        args.reproducer = args.classifier = args.reviewer = "nemotron"
        args.deploy = "canary"
    args.fn(args)


if __name__ == "__main__":
    main()
