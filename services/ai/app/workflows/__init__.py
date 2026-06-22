"""Module 9 — Workflow Automation Engine AI surface.

The durable workflow EXECUTION engine is a DB-persisted state machine in the Node API (the
WorkflowDefinition / Instance / Task rows ARE the durable state; Temporal is the documented
prod substrate). This stateless AI service provides the single AI-authoring surface on top
of it:

  draft — turn a free-text description of an HR process into a runnable WORKFLOW draft: a
          name + trigger (+ eventType) + an ORDERED sequence of typed WorkflowStep objects
          (TASK / APPROVAL / NOTIFICATION / AI_TASK / TIMER / BRANCH) with realistic
          assigneeRole + slaHours on the human steps and a linear next-chain. GROUNDED in
          the allowed StepType / role vocabularies and REPAIRED in code so the draft is
          always runnable (valid types/roles, unique ids, well-formed chain). Degrades to a
          clearly-marked deterministic offline template when ANTHROPIC_API_KEY is absent.

The draft is a starting point a human reviews + saves; it is never auto-deployed.
camelCase end-to-end (mirroring @peopleos/schemas workflow.ts).
"""

from .draft import draft_workflow

__all__ = ["draft_workflow"]
