# Lord of the Dark Factory

The confidence layer that lets a repo fix its own trivial bugs and ship them to production with no human approving the change.

The fixer is a black box. Trust comes from what surrounds it:

```
bug report
  → scope          is this bug allowed to be fixed autonomously?           (pre-check)
  → baseline       is the regression suite green before we start?          (pre-check)
  → reproduce      is there a test that fails deterministically, for the right reason?   (pre-check)
  → fix            black box: bug + failing test in, diff out
  → oracle         repro test red to green on every rerun, full suite green              (post-check)
  → diff_inspection small, no protected paths, no deps, no secrets, no test tampering    (post-check)
  → deploy         gated release
```

Anything that does not clearly pass goes to a human (`runs/escalations.jsonl`). Every step is written to a hash-chained event log.

Principle: **models can write and can veto, but only deterministic checks can approve.**

## Quick start

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/factory setup                       # test env for the target repo (expects ../dark-factory-target)
.venv/bin/factory eval                        # all seeded bugs, graded against the answer key
.venv/bin/factory run bug1                    # one bug, station by station
.venv/bin/factory run bug1 --fixer rogue:delete_test   # a misbehaving fixer; the gates must catch it
.venv/bin/factory verify                      # check the audit log has not been tampered with
.venv/bin/pytest -q                           # the factory's own tests
```

Rogue modes: `delete_test`, `touch_auth`, `add_dependency`, `leak_secret`, `phone_home`, `big_rewrite`.

## Layout

| Path | |
|---|---|
| `factory/pipeline.py` | The line: runs stations in order, logs every verdict |
| `factory/stations/` | One file per station |
| `factory/fixers/` | Black-box implementations: `reference` (dev stand-in), `rogue` (adversarial) |
| `factory/reproducers.py` | Sources of reproducing tests: `dev` (hand-written stand-ins) |
| `factory/events.py` | Hash-chained event log and verifier |
| `eval/` | Answer key: bug reports, hidden tests, reference fixes. The factory never reads it during a run (except the `reference` dev fixer). |
| `docs/events.md` | Event schema for the UI |

## Status

- [x] Pipeline, oracle, diff inspection, event log, eval harness
- [ ] Nemotron: scope classifier, reproducing-test generator, fixer, veto reviewer
- [ ] Signed audit entries and `replay`
- [ ] Gated canary deploy with automatic rollback
- [ ] UI

Team: Lord of the Dark Factory, AI Hackathon with Nebius & NVIDIA.
