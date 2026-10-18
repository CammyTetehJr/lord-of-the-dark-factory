# eval: the answer key

Ground truth for the seeded bugs in [dark-factory-target](https://github.com/CammyTetehJr/dark-factory-target). The factory must never read anything in this folder during a run.

| Path | Purpose |
|---|---|
| `bugs/` | Bug reports written the way a user would: symptoms only, no hints about the cause |
| `bugs.json` | Manifest: expected outcome (ship or escalate) and the gate that should fire |
| `hidden_tests/` | Ground-truth tests, used after a run to prove fixes are actually correct |
| `reference_fixes/` | Known-good patches. Also usable as a scripted fixer while the real agent is not wired up |

Every hidden test fails on `demo-baseline`, and every reference fix makes the full suite plus its hidden test pass.

To run a hidden test against the target, copy it into the target's `tests/` folder (it relies on the target's `conftest.py`).
