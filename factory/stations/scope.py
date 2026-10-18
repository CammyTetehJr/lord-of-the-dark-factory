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
    # A trivial bug must be reproducible on demand; these words say it is not.
    "non-deterministic behaviour": [r"\brandom(ly)?\b", r"\bintermittent\w*", r"\bsporadic\w*", r"\bflaky\b",
                                    r"\boccasional(ly)?\b", r"\bsometimes\b", r"\brace condition\b",
                                    r"\bconcurren\w*", r"\bunder (heavy )?load\b",
                                    r"\b(can'?t|cannot|unable to) reproduce\b", r"\bnot reproducible\b"],
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
                       f"Out of scope for autonomous repair: {areas}. A human must handle this.",
                       {"rule": "protected_area", "matches": hits})
    return Verdict("scope", "pass", "No protected area mentioned; eligible for autonomous repair.",
                   {"rule": "protected_area", "matches": {}})
