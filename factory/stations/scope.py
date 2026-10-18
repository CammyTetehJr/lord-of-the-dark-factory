"""Pre-check 1: is this bug in scope for autonomous repair at all?

Deterministic rules run first and can only escalate. Then a Nemotron classifier judges
whether the bug is trivial; it too can only escalate, never override a rule.
"""
import re

from factory import llm
from factory.models import BugReport, Verdict

# Areas where an autonomous change is never acceptable, keyed by the words that signal them.
OUT_OF_SCOPE_AREAS: dict[str, list[str]] = {
    "authentication / authorization": [r"\bapi keys?\b", r"\bauth\w*", r"\blog ?in\b", r"\bpasswords?\b",
                                       r"\bpermissions?\b", r"\baccess control\b", r"\bsessions?\b"],
    "database schema / migrations": [r"\bmigrations?\b", r"\bschema\b", r"\bnew column\b"],
    "security": [r"\bsecurity\b", r"\bvulnerab\w*", r"\bcve-\d+", r"\binjection\b", r"\bxss\b"],
    "data loss": [r"\bdata loss\b", r"\bdeleted? (all|every)\b", r"\bcorrupt\w*"],
    # A trivial bug must be reproducible on demand; these words say it is not.
    "non-deterministic behaviour": [r"\brandom(ly)?\b", r"\bintermittent\w*", r"\bsporadic\w*", r"\bflaky\b",
                                    r"\boccasional(ly)?\b", r"\bsometimes\b", r"\brace condition\b",
                                    r"\bconcurren\w*", r"\bunder (heavy )?load\b",
                                    r"\b(can'?t|cannot|unable to) reproduce\b", r"\bnot reproducible\b"],
}

MIN_CONFIDENCE = 0.7

CLASSIFIER_SYSTEM = """You triage bug reports for an autonomous repair line. Only TRIVIAL bugs may be fixed and shipped without a human.

A bug is TRIVIAL only if ALL of these hold:
1. Deterministic: one automated test can reproduce it on demand. No dependence on timing, concurrency, load, randomness or environment.
2. Localized: the fix is likely a few lines in one or two files.
3. Clear: the expected behaviour is obvious from the report; no product or business decision is needed.
4. Safe area: not about authentication, authorization, security, secrets, database schema/migrations, dependencies, infrastructure or configuration.

When in doubt, it is NOT trivial.

Reply with JSON only:
{"trivial": true|false, "confidence": 0.0-1.0, "category": "<2-4 words>", "reason": "<one sentence>"}"""


def check_rules(bug: BugReport) -> Verdict:
    text = f"{bug.title}\n{bug.body}".lower()
    if len(text.strip()) < 20:
        return Verdict("scope", "escalate", "Bug report is too short to act on safely.", {"rules": {"rule": "min_length"}})
    hits = {area: [m.group(0) for p in pats for m in [re.search(p, text)] if m]
            for area, pats in OUT_OF_SCOPE_AREAS.items()}
    hits = {a: h for a, h in hits.items() if h}
    if hits:
        areas = ", ".join(hits)
        return Verdict("scope", "escalate", f"Out of scope for autonomous repair: {areas}. A human must handle this.",
                       {"rules": {"rule": "protected_area", "matches": hits}})
    return Verdict("scope", "pass", "No protected area mentioned; eligible for autonomous repair.",
                   {"rules": {"rule": "protected_area", "matches": {}}})


def classify(bug: BugReport, repo_tree: str) -> tuple[bool, str, dict]:
    """Nemotron's opinion. Returns (in_scope, reason, evidence). Any doubt or failure means out of scope."""
    messages = [{"role": "system", "content": CLASSIFIER_SYSTEM},
                {"role": "user", "content": f"# Bug report\n## {bug.title}\n{bug.body}\n\n# Repository files\n{repo_tree}"}]
    try:
        res = llm.chat("fast", messages, max_tokens=4000, temperature=0.0)
    except Exception as e:
        return False, f"Classifier unavailable ({type(e).__name__}); escalating by default.", {"error": str(e)}
    data = llm.extract_json(res.content)
    evidence = {**res.meta(), "answer": data}
    if not isinstance(data, dict) or "trivial" not in data:
        evidence["response_tail"] = res.content[-400:]
        return False, "Classifier gave no readable answer; escalating by default.", evidence
    conf = float(data.get("confidence") or 0)
    if not data["trivial"]:
        return False, f"Nemotron classifier: not trivial ({data.get('category', '?')}). {data.get('reason', '')}", evidence
    if conf < MIN_CONFIDENCE:
        return False, f"Nemotron classifier is not confident enough ({conf:.2f} < {MIN_CONFIDENCE}).", evidence
    return True, f"Nemotron classifier: trivial ({data.get('category', '?')}, confidence {conf:.2f}).", evidence


def check_scope(bug: BugReport, repo_tree: str = "", classifier: str = "none") -> Verdict:
    verdict = check_rules(bug)
    if verdict.outcome == "escalate" or classifier == "none":
        verdict.evidence["classifier"] = None if verdict.outcome == "escalate" else "disabled"
        return verdict
    ok, reason, evidence = classify(bug, repo_tree)
    verdict.evidence["classifier"] = evidence
    if not ok:
        return Verdict("scope", "escalate", reason, verdict.evidence)
    return Verdict("scope", "pass", f"Rules passed. {reason}", verdict.evidence)
