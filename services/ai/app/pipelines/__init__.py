"""Layer 2 ETL pipelines for the AI engine.

  - resume_parse : spec Layer 2A (format detect -> entity extraction -> skill
                   normalisation -> gap detection + total YoE -> CandidateProfile)
  - jd_parse     : Module 1 step 1 (free-text JD -> JDStructured via LLM)
"""

from .jd_parse import parse_job_description
from .resume_parse import parse_resume

__all__ = ["parse_job_description", "parse_resume"]
