"""A small production environment for the target service.

deploy/mainline     git repo: what production runs. Every promoted fix is a commit here.
deploy/releases/*   one checkout per running instance (stable, canary)
deploy/state.json   which instance is stable, and the deploy history

Instances run the target with uvicorn on a free local port, each with its own SQLite database
seeded with production-scale data, so performance problems that tests cannot see do show up.
"""
import fcntl
import json
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.request
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from factory import sandbox
from factory.config import Config

PROD_API_KEY = "factory-prod-traffic"
CUSTOMERS = 200


@dataclass
class Instance:
    name: str
    commit: str
    dir: str
    port: int
    pid: int

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def healthy(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def seed_db(db: Path, migrations: Path, invoices: int) -> None:
    """Deterministic production-like data: customers, invoices with line items, and an API key."""
    db.unlink(missing_ok=True)
    conn = sqlite3.connect(db)
    for sql in sorted(migrations.glob("*.sql")):
        conn.executescript(sql.read_text())
    conn.execute("INSERT INTO api_keys (key, owner, expires_at) VALUES (?, 'traffic', NULL)", (PROD_API_KEY,))
    conn.executemany("INSERT INTO customers (id, name, email) VALUES (?, ?, ?)",
                     [(i, f"Customer {i}", f"customer{i}@example.com") for i in range(1, CUSTOMERS + 1)])
    conn.executemany(
        "INSERT INTO invoices (id, number, customer_id, discount_rate, tax_rate, created_at) VALUES (?, ?, ?, 0, 0.19, ?)",
        [(i, f"INV-{i:06d}", 1 + i % CUSTOMERS, "2026-01-01T00:00:00+00:00") for i in range(1, invoices + 1)])
    conn.executemany(
        "INSERT INTO line_items (invoice_id, description, quantity, unit_price_cents) VALUES (?, 'Service', ?, ?)",
        [(i, 1 + i % 3, 1000 + (i * 37) % 9000) for i in range(1, invoices + 1)])
    conn.commit()
    conn.close()


class Prod:
    def __init__(self, config: Config | None = None):
        self.config = config or Config()
        self.root = self.config.deploy_dir
        self.mainline = self.root / "mainline"
        self.releases = self.root / "releases"
        self.state_path = self.root / "state.json"

    # ---------- state ----------
    def state(self) -> dict:
        return json.loads(self.state_path.read_text()) if self.state_path.exists() else {"stable": None, "history": []}

    def _save(self, state: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(state, indent=2))

    def _record(self, **entry) -> None:
        s = self.state()
        s["history"].append({"ts": _now(), **entry})
        self._save(s)

    @contextmanager
    def lock(self):
        """One change on the production line at a time."""
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / ".lock", "w") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def git(self, cwd: Path, *args: str, input: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=cwd, input=input, capture_output=True, text=True)

    # ---------- instances ----------
    def ensure_mainline(self) -> None:
        if (self.mainline / ".git").exists():
            return
        self.root.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", "--no-hardlinks", str(self.config.target_repo), str(self.mainline)], check=True)
        self.git(self.mainline, "checkout", "-q", "-B", "production", self.config.target_ref)
        self.git(self.mainline, "config", "user.email", "factory@lord-of-the-dark-factory")
        self.git(self.mainline, "config", "user.name", "Dark Factory")

    def head(self) -> str:
        return self.git(self.mainline, "rev-parse", "HEAD").stdout.strip()

    def checkout_release(self, name: str) -> Path:
        path = self.releases / name
        shutil.rmtree(path, ignore_errors=True)
        self.releases.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", "--no-hardlinks", str(self.mainline), str(path)], check=True)
        return path

    def start(self, name: str, release: Path) -> Instance | None:
        db = release / "prod.db"
        seed_db(db, release / "migrations", self.config.prod_invoices)
        port = _free_port()
        log = open(release / "server.log", "w")
        proc = subprocess.Popen(
            sandbox.wrap([str(self.config.target_python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                          "--port", str(port), "--log-level", "warning"]),
            cwd=release, env=sandbox.clean_env(INVOICE_DB_PATH=str(db)),
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        commit = self.git(release, "rev-parse", "HEAD").stdout.strip()
        inst = Instance(name=name, commit=commit, dir=str(release), port=port, pid=proc.pid)
        st = self.state()
        st.setdefault("pids", []).append(proc.pid)
        self._save(st)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if healthy(inst.url):
                return inst
            if proc.poll() is not None:
                break
            time.sleep(0.2)
        self.stop(inst)
        return None

    def stop(self, inst: Instance | dict | None) -> None:
        if not inst:
            return
        pid = inst["pid"] if isinstance(inst, dict) else inst.pid
        if _alive(pid):
            try:
                os.killpg(pid, signal.SIGTERM)
            except OSError:
                pass
            for _ in range(25):
                if not _alive(pid):
                    break
                time.sleep(0.1)

    def ensure_stable(self) -> Instance:
        self.ensure_mainline()
        s = self.state()
        st = s.get("stable")
        if st and _alive(st["pid"]) and healthy(f"http://127.0.0.1:{st['port']}"):
            return Instance(**st)
        self.stop(st)
        release = self.checkout_release(f"stable-{self.head()[:10]}")
        inst = self.start("stable", release)
        if inst is None:
            raise RuntimeError(f"production stable failed to start; see {release / 'server.log'}")
        s = self.state()
        s["stable"] = asdict(inst)
        self._save(s)
        self._record(event="stable_started", commit=inst.commit, port=inst.port)
        return inst

    # ---------- releases ----------
    def build_release(self, name: str, diff: str, extra_files: dict[str, str], message: str) -> tuple[Path, str | None]:
        """Current production + this change, committed. Returns (path, error)."""
        release = self.checkout_release(name)
        res = self.git(release, "apply", "--whitespace=nowarn", "-", input=diff if diff.endswith("\n") else diff + "\n")
        if res.returncode != 0:
            return release, f"fix does not apply on top of current production: {res.stderr.strip()[:300]}"
        for rel, content in extra_files.items():
            (release / rel).parent.mkdir(parents=True, exist_ok=True)
            (release / rel).write_text(content)
        self.git(release, "add", "-A")
        self.git(release, "-c", "user.email=factory@lord-of-the-dark-factory", "-c", "user.name=Dark Factory",
                 "commit", "-q", "-m", message)
        return release, None

    def promote(self, canary: Instance, run_id: str, title: str) -> str:
        """Canary becomes stable: fast-forward mainline to the release, retire the old stable."""
        release = Path(canary.dir)
        commit = canary.commit
        self.git(self.mainline, "fetch", "-q", str(release), "HEAD")
        res = self.git(self.mainline, "merge", "-q", "--ff-only", "FETCH_HEAD")
        if res.returncode != 0:
            raise RuntimeError(f"mainline moved during deploy: {res.stderr.strip()}")
        s = self.state()
        old = s.get("stable")
        s["stable"] = {**asdict(canary), "name": "stable"}
        self._save(s)
        self.stop(old)
        if old:
            shutil.rmtree(old["dir"], ignore_errors=True)
        self._record(event="promoted", run_id=run_id, title=title, commit=commit, port=canary.port)
        return commit

    def discard(self, inst: Instance | None, release: Path) -> None:
        self.stop(inst)
        shutil.rmtree(release, ignore_errors=True)

    def rollback_last(self, by: str = "operator") -> dict:
        """Human kill switch: revert the most recent promoted change and restart stable without it."""
        with self.lock():
            self.ensure_mainline()
            last = next((h for h in reversed(self.state()["history"]) if h["event"] == "promoted"
                         and not h.get("reverted")), None)
            if last is None:
                return {"ok": False, "message": "nothing to roll back"}
            res = self.git(self.mainline, "revert", "--no-edit", last["commit"])
            if res.returncode != 0:
                self.git(self.mainline, "revert", "--abort")
                return {"ok": False, "message": f"revert failed: {res.stderr.strip()[:200]}"}
            s = self.state()
            for h in s["history"]:
                if h.get("commit") == last["commit"] and h["event"] == "promoted":
                    h["reverted"] = True
            old = s.get("stable")
            s["stable"] = None
            self._save(s)
            self.stop(old)
            inst = self.ensure_stable()
            self._record(event="manual_rollback", by=by, reverted=last["commit"], run_id=last.get("run_id"),
                         commit=inst.commit)
            return {"ok": True, "message": f"reverted {last['commit'][:10]} ({last.get('title')})", "stable": asdict(inst)}

    def status(self) -> dict:
        s = self.state()
        st = s.get("stable")
        up = bool(st and _alive(st["pid"]) and healthy(f"http://127.0.0.1:{st['port']}"))
        commits = []
        if (self.mainline / ".git").exists():
            commits = self.git(self.mainline, "log", "--format=%h %s", "-n", "10").stdout.splitlines()
        return {"stable": st, "up": up, "url": f"http://127.0.0.1:{st['port']}" if st else None,
                "mainline": commits, "history": s["history"][-20:]}

    def reset_production(self, by: str = "operator") -> Instance:
        """Start production over from the original code (all seeded bugs back), keeping the lock.
        Waits for any deploy in progress to finish first."""
        with self.lock():
            for pid in self.state().get("pids", []):
                self.stop({"pid": pid})
            shutil.rmtree(self.mainline, ignore_errors=True)
            shutil.rmtree(self.releases, ignore_errors=True)
            self.state_path.unlink(missing_ok=True)
            inst = self.ensure_stable()
            self._record(event="reset", by=by, commit=inst.commit, port=inst.port)
            return inst

    def reset(self) -> None:
        """Stop every instance this factory started and delete the production environment."""
        for pid in self.state().get("pids", []):
            self.stop({"pid": pid})
        shutil.rmtree(self.root, ignore_errors=True)
