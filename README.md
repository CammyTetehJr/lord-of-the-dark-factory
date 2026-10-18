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
  → review         Nemotron Ultra reviews the diff; can veto, never approve              (post-check)
  → deploy         gated release
```

Anything that does not clearly pass goes to a human (`runs/escalations.jsonl`). Every step is written to an append-only event log: hash-chained and Ed25519-signed, so any edit, deletion or forgery is detectable, and any run can be replayed.

## Nemotron roles (Nebius Token Factory)

| Role | Model | Power |
|---|---|---|
| Scope classifier | `nvidia/Nemotron-3_5-Lightning` | Escalate only |
| Reproducing-test generator (3 in parallel) | `nvidia/nemotron-3-super-120b-a12b` | Proposes; the reproduce gate decides |
| Fixer (search/replace edits, test feedback, 3 attempts) | `nvidia/nemotron-3-super-120b-a12b` | Proposes; oracle and diff inspection decide |
| Veto reviewer | `nvidia/Nemotron-3-Ultra-550b-a55b` | Veto only |

Principle: **models can write and can veto, but only deterministic checks can approve.**

## Quick start

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/factory setup                       # test env for the target repo (expects ../dark-factory-target)
.venv/bin/factory eval                        # all seeded bugs, graded against the answer key
.venv/bin/factory run bug1                    # one bug, station by station
.venv/bin/factory run bug1 --fixer rogue:delete_test   # a misbehaving fixer; the gates must catch it
.venv/bin/factory run bug1 --live             # the real thing: Nemotron in every role
.venv/bin/factory eval --live                 # all bugs, real thing, graded
.venv/bin/factory replay <run_id>             # re-verify a past run from its signed record
.venv/bin/factory pubkey                      # public key for verifying the audit log
.venv/bin/factory verify                      # check the audit log has not been tampered with
.venv/bin/factory serve                       # HTTP API for the UI (see docs/ui-handoff.md)
.venv/bin/factory line pause|resume           # andon cord
.venv/bin/pytest -q                           # the factory's own tests
```

Rogue modes: `delete_test`, `touch_auth`, `add_dependency`, `leak_secret`, `phone_home`, `big_rewrite`, `game_test` (bug3 only: hardcodes the test's inputs; only the reviewer catches it).

## Layout

| Path | |
|---|---|
| `factory/pipeline.py` | The line: runs stations in order, logs every verdict |
| `factory/stations/` | One file per station |
| `factory/fixers/` | Black-box implementations: `reference` (dev stand-in), `rogue` (adversarial) |
| `factory/reproducers.py` | Sources of reproducing tests: `dev` (hand-written stand-ins) |
| `factory/events.py` | Hash-chained event log and verifier |
| `eval/` | Answer key: bug reports, hidden tests, reference fixes. The factory never reads it during a run (except the `reference` dev fixer). |
| `factory/fixers/nemotron.py` | The real fixer: Nemotron search/replace edits with test feedback, up to 3 attempts |
| `factory/server.py` | HTTP API and live event stream for the UI |
| `docs/ui-handoff.md` | **Start here if you are building the UI** |
| `docs/events.md` | Event schema for the UI |

## Status

- [x] Pipeline, oracle, diff inspection, event log, eval harness
- [x] Nemotron reproducing-test generator (Super, 3 candidates in parallel)
- [x] Nemotron fixer (Super, search/replace edits, test feedback loop)
- [x] HTTP API, live event stream, andon cord
- [x] Nemotron scope classifier (Lightning) and veto reviewer (Ultra)
- [x] Signed audit entries and `replay`
- [ ] Gated canary deploy with automatic rollback
- [ ] UI (in progress, see docs/ui-handoff.md)

Team: Lord of the Dark Factory, AI Hackathon with Nebius & NVIDIA.
