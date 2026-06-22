"""Output validation with retry-then-human-review (prompt standard #5).

Every LLM output is parsed with its Pydantic model BEFORE it is used. On a parse
failure we retry the LLM up to 2 times with an explicit "your previous output was
invalid" correction message; after that we raise ``HumanReviewNeeded`` carrying the
raw payload + error so the API can persist a ``HumanReviewJob`` (prisma model
``human_review_jobs``) and route to the human review queue.

This module is LLM-shaped but provider-agnostic at the call site: the caller passes
an ``llm_call`` coroutine that takes the (possibly augmented) user prompt and returns
text. That keeps validation testable offline (the test injects a fake ``llm_call``).
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

import structlog
from pydantic import BaseModel, ValidationError

log = structlog.get_logger(__name__)

ModelT = TypeVar("ModelT", bound=BaseModel)

# A coroutine that, given a user-turn string, returns the model's text answer.
LlmCall = Callable[[str], Awaitable[str]]

_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)
# First balanced-looking JSON object in a blob (greedy from first { to last }).
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)

# Max number of corrective retries AFTER the initial attempt (spec: "up to 2 retries").
DEFAULT_MAX_RETRIES = 2


@dataclass(slots=True)
class HumanReviewNeeded(Exception):
    """Raised after retries are exhausted; the API persists a HumanReviewJob.

    The fields map onto prisma ``human_review_jobs`` columns so the API can persist
    directly: module/task/reason/payload.
    """

    module: str
    task: str
    reason: str
    payload: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"HumanReviewNeeded(module={self.module}, task={self.task}, reason={self.reason})"


def extract_json(text: str) -> str:
    """Best-effort extraction of a JSON object from raw model text.

    Strips markdown code fences and isolates the first ``{...}`` block. We never
    trust this blindly — the result is fed straight into Pydantic validation.
    """
    cleaned = _JSON_FENCE_RE.sub("", text).strip()
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return cleaned
    match = _JSON_OBJECT_RE.search(cleaned)
    return match.group(0) if match else cleaned


def parse_model(model_cls: type[ModelT], raw_text: str) -> ModelT:
    """Parse ``raw_text`` (model output) into ``model_cls`` or raise ValidationError."""
    payload = extract_json(raw_text)
    data = json.loads(payload)  # raises json.JSONDecodeError on malformed JSON
    return model_cls.model_validate(data)


def _correction_prompt(original_user_prompt: str, error: str) -> str:
    """Prompt standard #5 corrective message."""
    return (
        f"{original_user_prompt}\n\n"
        "<correction>\n"
        f"Your previous output was invalid. Error: {error}\n"
        "Please re-output following the EXACT schema. Return ONLY the JSON object "
        "with no markdown fences and no commentary.\n"
        "</correction>"
    )


async def validate_or_review(
    model_cls: type[ModelT],
    *,
    llm_call: LlmCall,
    user_prompt: str,
    ctx: dict[str, Any],
    module: str,
    task: str,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> ModelT:
    """Call ``llm_call``, validate against ``model_cls``, retry, then human-review.

    Flow (prompt standard #5):
      1. attempt: call the LLM with ``user_prompt``; parse + validate
      2. on failure: up to ``max_retries`` corrective re-calls with the error attached
      3. after exhaustion: raise ``HumanReviewNeeded`` with the last raw output + error

    ``ctx`` is attached to the HumanReviewNeeded payload for the reviewer (e.g.
    orgId, candidateId, jobId). ``llm_call`` already strips <thinking> when relevant.
    """
    last_error = ""
    last_raw = ""
    prompt = user_prompt

    for attempt in range(max_retries + 1):
        last_raw = await llm_call(prompt)
        try:
            return parse_model(model_cls, last_raw)
        except (ValidationError, json.JSONDecodeError, ValueError) as exc:
            last_error = str(exc)
            log.warning(
                "ai_output_invalid",
                module=module,
                task=task,
                attempt=attempt,
                error=last_error,
            )
            prompt = _correction_prompt(user_prompt, last_error)

    # Retries exhausted — route to human review (spec: HumanReviewJob in queue).
    raise HumanReviewNeeded(
        module=module,
        task=task,
        reason=f"Validation failed after {max_retries + 1} attempts: {last_error}",
        payload={"rawOutput": last_raw, "validationError": last_error, **ctx},
    )
