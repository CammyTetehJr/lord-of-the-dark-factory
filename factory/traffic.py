"""Synthetic production traffic. A load balancer would split real user traffic between stable and
canary; we have no users, so this generator plays both roles: it sends a realistic request mix and
routes each request to the canary with the configured probability."""
import http.client
import json
import random
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from factory.prod import CUSTOMERS, PROD_API_KEY


@dataclass
class Metrics:
    requests: int = 0
    errors: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    error_samples: list[str] = field(default_factory=list)

    def add(self, ms: float, error: str | None) -> None:
        self.requests += 1
        self.latencies_ms.append(ms)
        if error:
            self.errors += 1
            if len(self.error_samples) < 5:
                self.error_samples.append(error)

    def p(self, q: float) -> float:
        if not self.latencies_ms:
            return 0.0
        xs = sorted(self.latencies_ms)
        return xs[min(len(xs) - 1, int(q * len(xs)))]

    @property
    def error_rate(self) -> float:
        return self.errors / self.requests if self.requests else 0.0

    def summary(self) -> dict:
        return {"requests": self.requests, "errors": self.errors, "error_rate": round(self.error_rate, 4),
                "p50_ms": round(self.p(0.50), 1), "p95_ms": round(self.p(0.95), 1),
                "error_samples": self.error_samples}


def _request(base: str, rng: random.Random, invoices: int) -> tuple[str, str, bytes | None]:
    r = rng.random()
    if r < 0.40:
        return "GET", f"{base}/invoices?page={rng.randint(1, 200)}&page_size=50", None
    if r < 0.65:
        return "GET", f"{base}/invoices/{rng.randint(1, invoices)}", None
    if r < 0.80:
        return "GET", f"{base}/customers/lookup?email=customer{rng.randint(1, CUSTOMERS)}@example.com", None
    if r < 0.95:
        body = {"customer_id": rng.randint(1, CUSTOMERS), "tax_rate": 0.19, "discount_pct": rng.choice([0, 5, 10]),
                "lines": [{"description": "Service", "quantity": rng.randint(1, 3), "unit_price_cents": rng.randint(100, 9000)}]}
        return "POST", f"{base}/invoices", json.dumps(body).encode()
    return "GET", f"{base}/health", None


class _Client:
    """One persistent keep-alive connection per backend, like a load balancer's upstream pool."""

    def __init__(self) -> None:
        self.conns: dict[str, http.client.HTTPConnection] = {}

    def send(self, method: str, url: str, body: bytes | None) -> tuple[float, str | None]:
        parts = urllib.parse.urlsplit(url)
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        headers = {"X-API-Key": PROD_API_KEY, "Content-Type": "application/json"}
        start = time.perf_counter()
        for attempt in (1, 2):  # one reconnect if the server closed an idle keep-alive connection
            conn = self.conns.get(parts.netloc)
            if conn is None:
                conn = self.conns[parts.netloc] = http.client.HTTPConnection(parts.netloc, timeout=5)
            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
                resp.read()
                break
            except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError) as e:
                conn.close()
                self.conns.pop(parts.netloc, None)
                if attempt == 2:
                    return (time.perf_counter() - start) * 1000, f"{type(e).__name__} on {method} {path}"
            except Exception as e:
                conn.close()
                self.conns.pop(parts.netloc, None)
                return (time.perf_counter() - start) * 1000, f"{type(e).__name__}: {e} on {method} {path}"
        ms = (time.perf_counter() - start) * 1000
        return ms, (f"HTTP {resp.status} on {method} {path}" if resp.status >= 500 else None)

    def close(self) -> None:
        for c in self.conns.values():
            c.close()


def run_step(stable_url: str, canary_url: str, canary_pct: int, seconds: float, invoices: int,
             concurrency: int = 8, rate_per_s: float = 200, seed: int = 0) -> dict[str, Metrics]:
    """Steady open-loop-ish load: each worker sends at a fixed pace, so a slow canary shows up as
    latency instead of silently reducing the load it receives."""
    metrics = {"stable": Metrics(), "canary": Metrics()}
    lock = threading.Lock()
    deadline = time.monotonic() + seconds
    interval = concurrency / rate_per_s

    def worker(wid: int) -> None:
        rng = random.Random(seed * 1000 + wid)
        client = _Client()
        next_at = time.monotonic() + rng.random() * interval
        while next_at < deadline:
            time.sleep(max(0.0, next_at - time.monotonic()))
            next_at += interval
            target = "canary" if rng.random() * 100 < canary_pct else "stable"
            method, url, body = _request(stable_url if target == "stable" else canary_url, rng, invoices)
            ms, err = client.send(method, url, body)
            with lock:
                metrics[target].add(ms, err)
        client.close()

    with ThreadPoolExecutor(concurrency) as pool:
        list(pool.map(worker, range(concurrency)))
    return metrics
