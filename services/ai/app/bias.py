"""Bias mitigation layer (Module 1 step 6 / prompt standard #4).

``mask_profile`` returns a COPY of a CandidateProfile with bias-correlated
identity signals removed BEFORE the profile is shown to the holistic LLM step.

Exactly what is masked (and why):
  - name           -> None            (direct identity; gender/ethnicity proxy)
  - email          -> None            (often contains the name)
  - phone          -> None            (identity)
  - linkedinUrl    -> None            (resolves to name/photo/demographics)
  - githubUrl      -> None            (resolves to identity)
  - location       -> None            (geographic/origin proxy)
  - education[].school   -> "[REDACTED SCHOOL]"  (institution prestige is NOT a
                                                   ranking factor — spec step 6)
  - education[].startYear / endYear -> None       (graduation year is an AGE proxy)
  - certifications[].year           -> None       (age proxy)

What is intentionally KEPT (it is what the model should judge on):
  - degree, field, work experience (company/title/dates/description), skills,
    languages, gaps, totalYoe.

Publications are CLEARED: they routinely embed the candidate's name (author lists)
and institution, re-introducing the very identity/school signals this layer removes.
Their merit signal is not worth the de-anonymisation risk at the holistic step.

Note on company names: employer names are retained because relevance of prior
work is a legitimate evaluation signal and the spec masks "name/gender/grad-year/
school", not employers. The holistic prompt additionally instructs the model not
to weight institution prestige.
"""

from __future__ import annotations

from .schemas import (
    Certification,
    Education,
    CandidateProfile,
)

_REDACTED_SCHOOL = "[REDACTED SCHOOL]"


def mask_profile(profile: CandidateProfile) -> CandidateProfile:
    """Return a deep copy of ``profile`` with identity/age/school signals removed.

    The original profile is never mutated.
    """
    masked = profile.model_copy(deep=True)

    # Direct identity + contact/social handles (resolve to demographics).
    masked.name = None
    masked.email = None
    masked.phone = None
    masked.linkedinUrl = None
    masked.githubUrl = None
    masked.location = None

    # School name redacted; graduation years stripped (age proxy).
    masked.education = [
        Education(
            school=_REDACTED_SCHOOL,
            degree=edu.degree,
            field=edu.field,
            startYear=None,
            endYear=None,
        )
        for edu in masked.education
    ]

    # Certification years stripped (age proxy); names/issuers kept (relevant signal).
    masked.certifications = [
        Certification(name=cert.name, issuer=cert.issuer, year=None)
        for cert in masked.certifications
    ]

    # Publications cleared: author lists de-anonymise (candidate name + institution).
    masked.publications = []

    return masked
