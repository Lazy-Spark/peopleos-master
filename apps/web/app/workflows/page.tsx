import Link from "next/link";

import { WorkflowTemplates } from "./workflow-templates";

export const dynamic = "force-dynamic";

/**
 * Module 9 — Workflow Automation Engine, the templates / definitions surface.
 *
 * A thin Server Component wrapper. The client `WorkflowTemplates` lists the org's
 * `WorkflowDefinition`s (each with its step DAG), starts an instance of one
 * (routing to the monitor), and offers an AI "draft from description" box that
 * proposes a step DAG for review. The engine is a durable, DB-persisted state
 * machine over Postgres (Temporal is the documented prod substrate); all wire
 * shapes come from `@peopleos/schemas`.
 */
export default function WorkflowsPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Workflow templates
          </h1>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/workflows/tasks" className="hover:text-foreground">
              My tasks
            </Link>
            <Link href="/workflows/monitor" className="hover:text-foreground">
              Monitor
            </Link>
          </nav>
        </div>
        <p className="text-sm text-muted-foreground">
          Pre-built and custom HR processes — onboarding, offboarding, offer
          routing — modelled as a durable, resumable state machine. Each template
          is a DAG of steps; starting one walks the automatic steps inline and
          creates a task for each human step (approvals, checklists). Branches,
          SLAs, and escalation are evaluated by the engine, never the browser.
        </p>
      </section>

      <WorkflowTemplates />
    </div>
  );
}
