"""Pre-check 1: is this bug in scope for autonomous repair at all?

Deterministic rules run first and can only escalate. The Nemotron classifier (added later)
also only gets to escalate, never to override a rule.
"""
import re

from factory.models import BugReport, Verdict

# Areas where an autonomous change is never acceptable, keyed by the words that signal them.
OUT_OF_SCOPE_AREAS: dict[str, list[str]] = {
    "authentication / authorization": [r"\bapi keys?\b", r"\bauth\w*", r"\blog ?in\b", r"\bpasswords?\b",
                                       r"\bpermissions?\b", r"\baccess control\b", r"\bsessions?\b"],
    "database schema / migrations": [r"\bmigrations?\b", r"\bschema\b", r"\bnew column\b"],
    "security": [r"\bsecurity\b", r"\bvulnerab\w*", r"\bcve-\d+", r"\binjection\b", r"\bxss\b"],
    "data loss": [r"\bdata loss\b", r"\bdeleted? (all|every)\b", r"\bcorrupt\w*"],
}


def check_scope(bug: BugReport) -> Verdict:
    text = f"{bug.title}\n{bug.body}".lower()
    if len(text.strip()) < 20:
        return Verdict("scope", "escalate", "Bug report is too short to act on safely.",
                       {"rule": "min_length"})
    hits = {area: [m.group(0) for p in pats for m in [re.search(p, text)] if m]
            for area, pats in OUT_OF_SCOPE_AREAS.items()}
    hits = {a: h for a, h in hits.items() if h}
    if hits:
        areas = ", ".join(hits)
        return Verdict("scope", "escalate",
                       f"Touches a protected area ({areas}). Autonomous changes are not allowed here.",
                       {"rule": "protected_area", "matches": hits})
    return Verdict("scope", "pass", "No protected area mentioned; eligible for autonomous repair.",
                   {"rule": "protected_area", "matches": {}})
