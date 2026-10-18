# UI handoff

Everything the UI needs is served by `factory serve`. You can build the whole UI without a Nebius key.

## Setup (once)

```bash
git clone https://github.com/CammyTetehJr/lord-of-the-dark-factory
git clone https://github.com/CammyTetehJr/dark-factory-target      # must sit next to the factory repo
cd lord-of-the-dark-factory
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/factory setup
.venv/bin/factory serve           # http://127.0.0.1:8100  (interactive docs at /docs)
```

**Developing without a key:** start runs with
`{"bug_id": "bug1", "fixer": "reference", "reproducer": "dev", "classifier": "none", "reviewer": "none", "deploy": "branch"}`.
They run the real pipeline in about 2 seconds and cost nothing. Use `"deploy": "canary"` to include the production canary (about 15 more seconds, still free). In the real demo leave all those fields out: they default to Nemotron and canary.

## API

| Method | Path | Use |
|---|---|---|
| GET | `/api/meta` | Station order (draw the line from this), available fixers and reproducers |
| GET | `/api/bugs` | Bug inbox: `id`, `title`, `body` |
| POST | `/api/runs` | Start a run: `{"bug_id": "bug1"}` (all roles default to Nemotron) → `{"run_id", "queued_behind"}`. **429** with a readable `detail` when the line is busy or the hourly cap is hit |
| GET | `/api/runs` | Recent runs: `status` (`running`/`shipped`/`escalated`), per-station outcome, escalation reason |
| GET | `/api/runs/{id}` | One run: `summary`, all `events`, final `result` with full evidence |
| GET | `/api/runs/{id}/artifacts/fix.diff` | The diff (plain text) |
| GET | `/api/runs/{id}/artifacts/repro_test.py` | The reproducing test (plain text) |
| GET | `/api/events/stream?since=<seq>` | **Live feed** (Server-Sent Events). Use `new EventSource(url)` |
| GET | `/api/escalations` | Human queue, newest first |
| GET | `/api/line` | `{"paused": bool, "by", "reason", "ts"}` |
| POST | `/api/line/pause` / `/api/line/resume` | Andon cord. Body: `{"by": "name", "reason": "..."}` |
| GET | `/api/audit/verify` | `{"ok", "message", "events"}`: chain and signatures intact, or the line where it broke |
| POST | `/api/runs/{id}/replay` | Re-run every deterministic gate from the signed record (5 to 10 s). Returns `integrity` and `stations[]` with `recorded`, `replayed`, `match` |
| GET | `/api/audit/pubkey` | The public key anyone can verify the log with |
| GET | `/api/prod` | Production: `up`, `url`, `stable` instance, `mainline` (recent production commits), `history` (promoted, rolled_back, manual_rollback) |
| POST | `/api/prod/start` | Start production if it is not running |
| POST | `/api/prod/rollback` | Human kill switch: revert the last promoted fix. Body: `{"by": "name"}` |
| GET | `/api/intake` | GitHub intake: `{enabled, repo, label, last_poll, last_error, issues: {"<number>": {run_id, status, url}}}`. Runs it starts have bug ids like `issue7` and `bug.source` = the issue URL |
| POST | `/api/prod/reset` | Restart production from the original code (all seeded bugs back). Body: `{"by": "name"}` → `{ok, message, url, commit}` |

Event fields and per-station evidence are documented in [events.md](events.md).

## Screens, in demo order

1. **The line.** Eight stations left to right (`/api/meta`). Each bug moves through them live: running, pass, escalate. Clicking "Run all" posts one run per bug. This is the hero view; it must read from across a room.
2. **Run detail.** The reason line for each station, the reproducing test, the diff, the `diff_inspection` checks as a checklist, the reviewer's verdict and concerns, and every Nemotron call (model, seconds, tokens): `scope.evidence.classifier`, `reproduce.evidence.attempts[].generator`, `fix.evidence.fixer_meta.attempts[]`, `review.evidence`. A **Replay** button that calls the replay endpoint and shows recorded vs replayed per station.
3. **Escalation queue.** What went to a human, and why, in one sentence each.
4. **Governance bar.** Always visible: the andon cord (pause/resume), the production kill switch (rollback last change), and the audit status ("chain intact, all signed" in green, or the broken line in red).
5. **Canary panel** (inside run detail, or live on the line while `deploy` runs). Listen for `deploy_progress` events: `phase` is `starting_canary`, `canary_step` (with `canary_pct`), `canary_step_finished` (with `ok`, `detail`, `canary` and `stable` metrics: `requests`, `errors`, `p95_ms`), `rolled_back`, `promoted`. A bar for the traffic split and two p95 numbers side by side is enough to tell the story.

## The demo beats the UI has to land

| Beat | What the audience sees |
|---|---|
| Run bugs 1 to 5 with Nemotron | Each goes all the way to deploy. Nobody touches anything. |
| Bug 6 (race condition) | Stops at scope: "non-deterministic behaviour". |
| Bug 7 (expired API keys) | Stops at scope: "authentication / authorization". |
| Bug 1 with `rogue:delete_test` | **Oracle passes, diff inspection rejects.** Show both side by side: the tests alone would have shipped it. |
| Bug 3 with `rogue:game_test` | Oracle and diff inspection both pass. **The Nemotron reviewer vetoes**: "hardcodes the exact test input". |
| Bug 1 with `rogue:slow_fix` (do this **before** the honest bug 1, on fresh production) | Every check passes; the canary at 10% shows p95 ~85 ms vs a ~16 ms limit and **rolls back automatically**. Stable never notices. |
| Kill switch | A human reverts the last fix in one click; production restarts without it. |
| Pause the line, start a run | It stops before the first station and lands in the queue. |
| Replay a shipped run | Every deterministic gate re-runs and matches; model calls shown with their prompt hashes. |
| Audit verify | Green: "all signed by key …". (Edit a line in `runs/events.jsonl` live to show it turn red, then restore it.) |
