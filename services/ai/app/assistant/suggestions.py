"""Module 10 — role-aware suggested next actions for the assistant UI.

``suggested_actions_for_role(role)`` returns a small list of natural-language next-step
prompts appropriate to the user's role (AssistantChatResponse.suggestedActions). These are
purely UI affordances — they map to capabilities the role's TOOLS actually expose, so the
suggestions never imply an action the role cannot take. They are static (no data, no PII),
so they are safe to derive from the role alone and require no tool call.
"""

from __future__ import annotations

# Self-service suggestions every role can act on (all roles have these tools).
_SELF_SERVICE: tuple[str, ...] = (
    "Ask an HR policy question (e.g. how much PTO do I have left?)",
    "See my skill profile and where I'm growing",
    "Explore internal roles recommended for me",
)

# Role-specific suggestions, layered on top of the self-service set. Each entry maps to a
# tool the role is permitted to use, so the UI never suggests a forbidden action.
_BY_ROLE: dict[str, tuple[str, ...]] = {
    "ADMIN": (
        "Show the workforce analytics dashboard",
        "Summarise attrition risk for a department",
        "Rank candidates for an open role",
        "Draft an HR workflow",
    ),
    "HRBP": (
        "Show the workforce analytics dashboard",
        "Summarise attrition risk for a department",
        "Review succession candidates for a critical role",
        "Check the org-wide skill inventory",
    ),
    "RECRUITER": (
        "Rank candidates for one of my open roles",
        "Draft a job description for a new role",
        "Find internal candidates for a role",
    ),
    "MANAGER": (
        "Check the attrition read for one of my reports",
        "Show my team's skill map",
    ),
    "EMPLOYEE": (
        "Raise an HR ticket",
        "Check my skill gap toward a target role",
    ),
}


def suggested_actions_for_role(role: str, *, limit: int = 4) -> list[str]:
    """Return up to ``limit`` role-appropriate next-step suggestions for the UI."""
    role_specific = _BY_ROLE.get(role, ())
    # Role-specific first (most useful), then self-service to fill out the list.
    ordered: list[str] = []
    for item in (*role_specific, *_SELF_SERVICE):
        if item not in ordered:
            ordered.append(item)
        if len(ordered) >= limit:
            break
    return ordered
