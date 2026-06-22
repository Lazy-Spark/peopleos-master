"""Skill alias / synonym table — the dev-stage canonicalisation layer.

Spec Layer 2A step 3 maps raw skills onto a canonical ontology (ESCO + org layer)
in production. That ontology is out of scope for this offline slice, so this module
provides a small, clearly-marked alias map covering the common cases the spec calls
out (e.g. "React.js"/"ReactJS" -> "React"). It is shared by:
  - the resume pipeline's skill normalisation step (pipelines/resume_parse.py)
  - skill match scoring (scoring/skill_match.py)
so normalisation is consistent end-to-end.

STUB NOTE: replace ``_ALIASES`` with a real ESCO-backed lookup in production.
"""

from __future__ import annotations

# raw (lowercased) -> canonical display name.
_ALIASES: dict[str, str] = {
    "react.js": "React",
    "reactjs": "React",
    "react js": "React",
    "node.js": "Node.js",
    "nodejs": "Node.js",
    "node js": "Node.js",
    "js": "JavaScript",
    "javascript": "JavaScript",
    "ts": "TypeScript",
    "typescript": "TypeScript",
    "py": "Python",
    "python3": "Python",
    "golang": "Go",
    "postgres": "PostgreSQL",
    "postgresql": "PostgreSQL",
    "psql": "PostgreSQL",
    "k8s": "Kubernetes",
    "kubernetes": "Kubernetes",
    "gcp": "Google Cloud Platform",
    "aws": "AWS",
    "amazon web services": "AWS",
    "ml": "Machine Learning",
    "machine learning": "Machine Learning",
    "tf": "TensorFlow",
    "tensorflow": "TensorFlow",
    "pytorch": "PyTorch",
    "torch": "PyTorch",
    "ci/cd": "CI/CD",
    "cicd": "CI/CD",
    "rest": "REST APIs",
    "restful apis": "REST APIs",
    "restful": "REST APIs",
}

# Canonical -> additional accepted aliases (for matching breadth).
_REVERSE_ALIASES: dict[str, list[str]] = {}
for _raw, _canon in _ALIASES.items():
    _REVERSE_ALIASES.setdefault(_canon.lower(), []).append(_raw)


def canonical_skill(raw: str) -> str:
    """Map a raw skill string to its canonical display name (or a tidied original).

    Unknown skills are returned trimmed with original casing preserved.
    """
    key = raw.strip().lower()
    if key in _ALIASES:
        return _ALIASES[key]
    return raw.strip()


def canonical_key(name: str) -> str:
    """Normalisation key used for equality comparison (case/space-insensitive)."""
    return canonical_skill(name).strip().lower()


def expand_aliases(name: str) -> set[str]:
    """All accepted spellings for a skill (the canonical + known aliases)."""
    canon = canonical_skill(name)
    out = {canon, name.strip()}
    out.update(_REVERSE_ALIASES.get(canon.lower(), []))
    return out
