"""Versioned system prompts for the AI engine (prompt standard #6).

Each prompt module exposes a ``PROMPT_VERSION`` constant of the form
``"<module>.<task>@<semver>"`` (e.g. ``"module1.holistic_assessment@1.0.0"``)
mirroring the ``PromptVersion { module, task, version }`` registry in
prisma/schema.prisma. The API persists this id on each AI output.
"""

from .analytics_ask import (
    PROMPT_VERSION as ANALYTICS_ASK_PROMPT_VERSION,
)
from .analytics_ask import (
    build_ask_system_prompt,
    build_ask_user_prompt,
)
from .analytics_narrative import (
    PROMPT_VERSION as ANALYTICS_NARRATIVE_PROMPT_VERSION,
)
from .analytics_narrative import (
    build_narrative_system_prompt,
    build_narrative_user_prompt,
)
from .assistant import (
    PROMPT_VERSION as ASSISTANT_PROMPT_VERSION,
)
from .assistant import (
    build_assistant_system_prompt,
)
from .attrition_explain import (
    PROMPT_VERSION as ATTRITION_EXPLAIN_PROMPT_VERSION,
)
from .attrition_explain import (
    build_attrition_explain_system_prompt,
    build_attrition_explain_user_prompt,
)
from .build_vs_buy import (
    PROMPT_VERSION as BUILD_VS_BUY_PROMPT_VERSION,
)
from .build_vs_buy import (
    build_build_vs_buy_system_prompt,
    build_build_vs_buy_user_prompt,
)
from .growth_path import (
    PROMPT_VERSION as GROWTH_PATH_PROMPT_VERSION,
)
from .growth_path import (
    build_growth_path_system_prompt,
    build_growth_path_user_prompt,
)
from .holistic_assessment import (
    PROMPT_VERSION as HOLISTIC_PROMPT_VERSION,
)
from .holistic_assessment import (
    build_holistic_system_prompt,
    build_holistic_user_prompt,
)
from .hr_chat import (
    PROMPT_VERSION as HR_CHAT_PROMPT_VERSION,
)
from .hr_chat import (
    build_hr_chat_system_prompt,
    build_hr_chat_user_prompt,
)
from .interview_analyze import (
    PROMPT_VERSION as INTERVIEW_ANALYZE_PROMPT_VERSION,
)
from .interview_analyze import (
    build_analyze_system_prompt,
    build_analyze_user_prompt,
)
from .jd_parse import (
    PROMPT_VERSION as JD_PARSE_PROMPT_VERSION,
)
from .jd_parse import (
    build_jd_parse_system_prompt,
    build_jd_parse_user_prompt,
)
from .mobility_recommend import (
    PROMPT_VERSION as MOBILITY_RECOMMEND_PROMPT_VERSION,
)
from .mobility_recommend import (
    build_mobility_recommend_system_prompt,
    build_mobility_recommend_user_prompt,
)
from .workflow_draft import (
    PROMPT_VERSION as WORKFLOW_DRAFT_PROMPT_VERSION,
)
from .workflow_draft import (
    build_workflow_draft_system_prompt,
    build_workflow_draft_user_prompt,
)

__all__ = [
    "ANALYTICS_ASK_PROMPT_VERSION",
    "ANALYTICS_NARRATIVE_PROMPT_VERSION",
    "ASSISTANT_PROMPT_VERSION",
    "ATTRITION_EXPLAIN_PROMPT_VERSION",
    "BUILD_VS_BUY_PROMPT_VERSION",
    "GROWTH_PATH_PROMPT_VERSION",
    "HOLISTIC_PROMPT_VERSION",
    "HR_CHAT_PROMPT_VERSION",
    "INTERVIEW_ANALYZE_PROMPT_VERSION",
    "JD_PARSE_PROMPT_VERSION",
    "MOBILITY_RECOMMEND_PROMPT_VERSION",
    "WORKFLOW_DRAFT_PROMPT_VERSION",
    "build_analyze_system_prompt",
    "build_analyze_user_prompt",
    "build_ask_system_prompt",
    "build_ask_user_prompt",
    "build_assistant_system_prompt",
    "build_attrition_explain_system_prompt",
    "build_attrition_explain_user_prompt",
    "build_build_vs_buy_system_prompt",
    "build_build_vs_buy_user_prompt",
    "build_growth_path_system_prompt",
    "build_growth_path_user_prompt",
    "build_holistic_system_prompt",
    "build_holistic_user_prompt",
    "build_hr_chat_system_prompt",
    "build_hr_chat_user_prompt",
    "build_jd_parse_system_prompt",
    "build_jd_parse_user_prompt",
    "build_mobility_recommend_system_prompt",
    "build_mobility_recommend_user_prompt",
    "build_narrative_system_prompt",
    "build_narrative_user_prompt",
    "build_workflow_draft_system_prompt",
    "build_workflow_draft_user_prompt",
]
