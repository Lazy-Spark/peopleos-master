import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

/**
 * Dashboard stub. The full Workforce Analytics / Recruiter Workspace surfaces
 * (spec Layer 5) are not built in this skeleton — this is just an entry point
 * that links into the ATS jobs list.
 */
export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          AI-native HR operating system. This is the Phase 1 web foundation — the
          recruiting pipeline is wired through to Module 1 candidate ranking.
        </p>
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="text-lg font-medium">PeopleOS Assistant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One role-aware agent across every module — recruiting, skills,
          attrition, internal mobility, analytics, and workflows. Ask in plain
          language; it orchestrates each capability as a tool, acting only within
          your role&apos;s permissions and confirming before any write (Module 10).
        </p>
        <div className="mt-4">
          <Link href="/assistant" className={buttonVariants()}>
            Open assistant
          </Link>
        </div>
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="text-lg font-medium">Recruiting</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review open roles and rank candidates against each job description.
        </p>
        <div className="mt-4">
          <Link href="/jobs" className={buttonVariants({ variant: "outline" })}>
            View jobs
          </Link>
        </div>
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="text-lg font-medium">Workforce Analytics</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A real-time view of workforce health — recruiting funnel, composition,
          engagement &amp; skills — with AI narrative insights and an
          &ldquo;Ask your data&rdquo; query interface (Module 5).
        </p>
        <div className="mt-4">
          <Link href="/analytics" className={buttonVariants({ variant: "outline" })}>
            Open analytics
          </Link>
        </div>
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="text-lg font-medium">Attrition Prediction</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Retention-risk insight to help support employees before they leave — a
          department/level risk heatmap, a flight-risk roster with drivers,
          narrative and recommended actions, and a monthly bias audit (Module 7).
          Scores are <span className="font-medium">advisory only</span> and are
          never shown to the employee.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/attrition" className={buttonVariants({ variant: "outline" })}>
            People-ops view
          </Link>
          <Link
            href="/attrition/team"
            className={buttonVariants({ variant: "outline" })}
          >
            Manager view
          </Link>
        </div>
      </section>
    </div>
  );
}
