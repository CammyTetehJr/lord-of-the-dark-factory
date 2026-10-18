# Event stream (for the UI)

The factory writes every step of every run as it happens. The UI only needs to read files; there is no server yet.

| File | Contents |
|---|---|
| `runs/events.jsonl` | Every event from every run, in order. Tail this for the live view. |
| `runs/<run_id>/events.jsonl` | The same events, for one run only. |
| `runs/<run_id>/run.json` | Final summary of one run (written when the run finishes). |
| `runs/<run_id>/artifacts/fix.diff` | The diff the fixer returned. |
| `runs/<run_id>/artifacts/repro_test.py` | The reproducing test. |
| `runs/escalations.jsonl` | The human queue: one line per escalated bug. |

## Common fields (every event)

```json
{
  "seq": 42,                       // global order, starts at 1
  "ts": "2026-10-18T10:21:48.123+00:00",
  "run_id": "20261018T102148Z-bug1-99437b",
  "type": "station_finished",
  "prev_hash": "…64 hex…",         // hash of the previous event
  "hash": "…64 hex…",              // sha256 of this event (without "hash" and "sig")
  "key_id": "145c70a072c31622",    // which factory key signed it
  "sig": "…base64…"                // Ed25519 signature over "hash"; see `factory verify`
}
```

## Event types, in the order they occur

**`run_started`**: `bug` {id, title, body, source}, `fixer`, `reproducer`, `target` {repo, ref, commit}, `policy`, `stations` (ordered list of station names to draw the line).

**`station_started`**: `station`. Light the station up.

**`station_finished`**: `station`, `outcome` (`pass` | `escalate`), `reason` (one human-readable sentence, show it), `evidence` (station-specific detail, see below).

**`deploy_progress`** (canary deploys only, several per run): `station: "deploy"`, `phase` (`starting_canary` | `canary_step` | `canary_step_finished` | `rolled_back` | `promoted`), plus `canary_pct`, `ok`, `detail`, `canary` and `stable` metrics on `canary_step_finished`.

**`escalated`** (only if the run escalated): `station`, `reason`.

**`run_finished`**: `outcome` (`shipped` | `escalated`).

## Stations

`scope` → `baseline` → `reproduce` → `fix` → `oracle` → `diff_inspection` → `review` → `deploy`

The first `escalate` stops the line, except that `oracle` and `diff_inspection` always both run, so a rejected fix shows every reason. `review` (the Nemotron Ultra veto) only runs if both passed. A `factory` station with `escalate` means the pipeline itself crashed.

## Evidence worth showing

| Station | Useful evidence fields |
|---|---|
| `scope` | `rules.matches`: protected areas and the words that triggered them; `classifier`: Nemotron call (`model`, `seconds`, `answer.reason`) or `"disabled"` |
| `baseline` | `tests.counts` |
| `reproduce` | `attempts[]`: `runs` (e.g. `["red","green","green"]`), `reason`, `qualified`; `test_code` when found |
| `fix` | `fixer`, `seconds`, `diff` |
| `oracle` | `repro_test.runs` (expect all `green`), `suite.attempts[0].counts`, `suite.flaky` |
| `diff_inspection` | `checks[]`: `{check, ok, detail}`, ideal as a checklist; `files`, `lines_changed` |
| `review` | `answer.verdict`, `answer.concerns[]`, `answer.reason`, `model`, `seconds` (or `reviewer: "disabled"`) |
| `deploy` | `mode` (`canary`/`branch`); canary: `steps[]` (`canary_pct`, `ok`, `detail`, `canary`/`stable` metrics), `stable_reference`, `slo`, `promoted_commit` |
