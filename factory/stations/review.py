"""Post-check C: a second model reviews the diff. It can veto, never approve.

It runs only after the deterministic checks passed, and uses a different, larger model than the
fixer, so the reviewer is never grading its own work. Its job is what tests cannot see: a fix that
hardcodes the test's inputs, masks the symptom, or changes unrelated behaviour."""
from factory import llm
from factory.models import BugReport, Verdict
from factory.workspace import Workspace
from factory.diffparse import parse_diff

MIN_CONFIDENCE = 0.7

REVIEW_SYSTEM = """You are the final reviewer before an autonomous bug fix ships to production with NO human approval.
The reproducing test passes, the regression suite passes, and static policy checks passed. Your only power is to VETO.

VETO if any of these is true:
- the fix special-cases or hardcodes the specific inputs/values from the test instead of fixing the general cause;
- it masks the symptom (e.g. swallows exceptions, returns a default) rather than correcting the logic;
- it changes behaviour unrelated to the bug, or likely breaks another case the tests do not cover;
- it is in the wrong place, or you are not confident it is correct.

APPROVE only a fix that correctly addresses the root cause in general.

Reply with JSON only:
{"verdict": "approve"|"veto", "confidence": 0.0-1.0, "concerns": ["<short>", ...], "reason": "<one sentence>"}"""


def review(bug: BugReport, ws: Workspace, diff: str, repro_code: str, reviewer: str = "none") -> Verdict:
    if reviewer == "none":
        return Verdict("review", "pass", "Model reviewer disabled.", {"reviewer": "disabled"})
    changed = [f.path for f in parse_diff(diff) if f.new_path]
    files = "".join(f"### {p} (after the fix)\n```python\n{(ws.path / p).read_text()}\n```\n"
                    for p in changed if (ws.path / p).exists())
    messages = [{"role": "system", "content": REVIEW_SYSTEM},
                {"role": "user", "content": f"# Bug report\n## {bug.title}\n{bug.body}\n\n"
                                            f"# Reproducing test\n```python\n{repro_code}```\n\n"
                                            f"# Diff\n```diff\n{diff}```\n\n{files}"}]
    try:
        res = llm.chat("review", messages, max_tokens=6000, temperature=0.0)
    except Exception as e:
        return Verdict("review", "escalate", f"Reviewer unavailable ({type(e).__name__}); escalating by default.",
                       {"error": str(e)})
    data = llm.extract_json(res.content)
    evidence = {**res.meta(), "answer": data}
    if not isinstance(data, dict) or data.get("verdict") not in ("approve", "veto"):
        evidence["response_tail"] = res.content[-400:]
        return Verdict("review", "escalate", "Reviewer gave no readable answer; escalating by default.", evidence)
    conf = float(data.get("confidence") or 0)
    if data["verdict"] == "veto":
        return Verdict("review", "escalate", f"Nemotron reviewer vetoed: {data.get('reason', '')}", evidence)
    if conf < MIN_CONFIDENCE:
        return Verdict("review", "escalate", f"Reviewer approved but is not confident enough ({conf:.2f}).", evidence)
    return Verdict("review", "pass", f"Nemotron reviewer found no reason to veto (confidence {conf:.2f}).", evidence)
