# Dark Factory Control Room

The governance UI for Lord of the Dark Factory: the line as an andon board, the escalation queue, the andon cord, audit status and run replay. See `../docs/ui-handoff.md` for the API it reads.

```bash
npm install
npm run dev:mock      # simulated factory in the browser, no backend needed
npm run dev           # against `factory serve` on http://127.0.0.1:8100 (override with VITE_API_URL)
npm test              # reducer tests
npm run build
```

- **Dev / Live toggle.** Dev sends `fixer: reference, reproducer: dev, classifier: none, reviewer: none` (about 2 s per bug, no model calls). Live leaves the roles out, so the server uses Nemotron everywhere (30 to 60 s per bug).
- **Mock mode** (`?source=mock`) mirrors `factory/pipeline.py`: same stations, stop rules, reason strings and evidence shapes. In the browser console, `__factoryMock.tamper()` breaks the audit chain and `__factoryMock.restore()` repairs it.

## How it fits together

- `src/state/reducer.ts`: one reducer folds the event stream into board state. Live mode feeds it from SSE; it ignores events it has already seen, so reconnects are safe.
- `src/api/source.ts`: the `FactorySource` interface, with the HTTP implementation. `src/api/mock.ts` is the in-browser one.
- `src/components/`: `Board` (lanes × stations), `Inspector` (why a lamp lit), `RunDrawer` (run detail, Nemotron calls, Replay), `Rail` (queue, event stream), `Andon`, `Launcher`.

## Colour rules

Grey at rest. Colour only for state: sodium = running, green = a gate passed, red = escalated, hazard stripes = a human stopped the line. Violet is reserved for model stations (the fixer's black box and the review veto). A disabled reviewer shows **off**, never green.
