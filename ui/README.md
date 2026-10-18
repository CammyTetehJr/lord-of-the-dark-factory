# Dark Factory Control Room

The governance UI for Lord of the Dark Factory: the line as an andon board, the escalation queue, the andon cord, audit status and run replay. See `../docs/ui-handoff.md` for the API it reads.

```bash
npm install
npm run dev:mock      # simulated factory in the browser, no backend needed
npm run dev           # against `factory serve` on http://127.0.0.1:8100 (override with VITE_API_URL)
npm test              # unit tests (reducer, request building)
npm run build
npm run test:e2e:mock # end-to-end, every demo beat against the mock (no backend; runs in CI)
npm run test:e2e      # end-to-end contract test against a running `factory serve` (Dev mode, free)
```

- **Dev / Live toggle.** Dev sends `fixer: reference, reproducer: dev, classifier: none, reviewer: none` (about 2 s per bug, no model calls). Live leaves the roles out, so the server uses Nemotron everywhere (30 to 60 s per bug).
- **Deploy.** Dev uses a plain branch deploy; Live uses the canary against local production (10% → 50% → 100%, rolled back on an SLO breach or the andon cord). "Run one" can override either way. `rogue:slow_fix` on bug1 only shows its point with the canary.
- **Who works where.** Open any run (click its outcome or name). **Crew** lists every agent on the run: model agents with their model, calls, tokens and time; stand-ins and adversarial fixers marked as such; deterministic gates counted. **Steps** are the stations in order; each header names its agents, model and power (proposes, decides, can only escalate, can only veto), with duration and outcome. Expand a step for each agent's role, result and model calls, then the evidence. Escalated, running and closed steps open by default. The inspector shows the same agent chips for the selected lamp. Agent definitions live in `src/lib/agents.ts`.
- **Closed runs.** A canary run whose bug is already fixed in production ends as `closed` at reproduce (blue "=" lamp), naming the production commit. No human is needed, so it never enters the queue.
- **Kill switch.** "Roll back last fix" in the top bar reverts the last fix promoted to production (with a confirmation naming it) and restarts production without it. Click the PROD pill for what is running and its history.
- **Mock mode** (`?source=mock`) mirrors `factory/pipeline.py`: same stations, stop rules, reason strings and evidence shapes. In the browser console, `__factoryMock.tamper()` breaks the audit chain and `__factoryMock.restore()` repairs it.

## End-to-end tests

First time only: `npx playwright install chromium`.

- `e2e/mock/`: each demo beat from `docs/ui-handoff.md` against the in-browser mock at `?source=mock&speed=5`. Tests run in parallel; each page gets a fresh simulated factory. About 15 s.
- `e2e/real/`: the same beats against the real server, in Dev mode (no API key). It catches the backend changing shape under the UI. Runs serially because tests share the server's line, log and production. About 2 minutes. Start `.venv/bin/factory serve` first.
  - The audit test edits `runs/events.jsonl` and restores it byte for byte (`E2E_RUNS_DIR` to point elsewhere).
  - The canary test rolls production back until it no longer has the bug1 fix, then leaves it that way.
  - Every test ends by resuming the line, so a failure can't leave it stopped.
- Failures keep a trace and screenshot: `npx playwright show-report`.
- `FACTORY_URL` points the contract suite at another server; `E2E_PORT` changes the UI port (default 5180).

Live mode (Nemotron) isn't automated: it costs tokens and the model's answers vary. Rehearse it by hand.

## How it fits together

- `src/state/reducer.ts`: one reducer folds the event stream into board state. Live mode feeds it from SSE; it ignores events it has already seen, so reconnects are safe.
- `src/api/source.ts`: the `FactorySource` interface, with the HTTP implementation. `src/api/mock.ts` is the in-browser one.
- `src/components/`: `Board` (lanes × stations), `Inspector` (why a lamp lit), `CanaryPanel` (traffic split and p95 per step), `RunDrawer` (run detail, Nemotron calls, Replay), `Rail` (queue, event stream), `ProdControl` (production + kill switch), `Andon`, `Launcher`.

## Colour rules

Grey at rest. Colour only for state: sodium = running, green = a gate passed, red = escalated, hazard stripes = a human stopped the line. Violet is reserved for model stations (the fixer's black box and the review veto). A disabled reviewer shows **off**, never green.
