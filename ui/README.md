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
- **Production controls.** Hold **Roll back** for one second to revert the named promoted fix. Hold **Reset** beside it to remove all fixes and restart from the original code (usually 5–10 seconds). A click or an early release does nothing; keyboard holds work too. Progress and errors appear beside the controls, and production changes cannot overlap in the same page. Click the PROD pill for what is running and its history.
- **Judge guide (#9).** **Try to make it fail** opens on first visit and remembers when collapsed. Five scenarios explain what to watch: easy fixes, out-of-scope bugs, rogue fixers, a slow canary, and human controls. Runs always use Live/Nemotron regardless of the manual launcher's previous mode. Scenarios that may reset production require a hold; they check shared production and finish any necessary reset before starting runs. A failed reset starts no runs. The slow scenario always resets; the rogue scenario also resets when bug1 or bug3 is already fixed so both guards can be demonstrated.
- **Fresh visits.** Old lanes and escalations start hidden, using the first server audit count as a fixed boundary. **Show earlier runs** reveals history; **Clear board** hides it again. The audit record and event stream remain complete. Launching waits for that initial snapshot, so a new run cannot be mistaken for old history.
- **Public mode (one link).** `scripts/serve-public.sh` builds the UI and `factory serve` serves it on the same origin as the API, so a production build calls its own origin (dev still calls `:8100`). With `FACTORY_ACCESS_CODE` set, a link without the code shows "This link needs an access code". Runs beyond the server's active limit wait their turn: the UI says how many, and shows the server's reason if a run is refused (429).
- **Mock mode** (`?source=mock`) mirrors `factory/pipeline.py`: same stations, stop rules, reason strings and evidence shapes. In the browser console, `__factoryMock.tamper()` breaks the audit chain and `__factoryMock.restore()` repairs it.

## End-to-end tests

First time only: `npx playwright install chromium`.

- `e2e/mock/`: demo beats, all five judge scenarios, reset cancellation/progress/errors, and responsive layout against the in-browser mock. HTTP fixtures also cover first-visit history, the reset request, rate limits and access-code expiry. Tests run in parallel; each page gets a fresh simulated factory.
- `e2e/real/`: the same beats against the real server, in Dev mode (no API key). It catches the backend changing shape under the UI. Runs serially because tests share the server's line, log and production. About 2 minutes. Start `.venv/bin/factory serve` first.
  - The audit test edits `runs/events.jsonl` and restores it byte for byte (`E2E_RUNS_DIR` to point elsewhere).
  - The canary test rolls production back until it no longer has the bug1 fix, then leaves it that way.
  - The reset test resets production, ships bug1, resets through the UI, and proves bug1 can ship again. Use an isolated server with separate `FACTORY_RUNS_DIR` and `FACTORY_DEPLOY_DIR` when preserving an existing demo matters.
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
