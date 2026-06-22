import Link from "next/link";

import { MobilityBoard } from "./mobility-board";

export const dynamic = "force-dynamic";

/**
 * Module 8 — Internal Talent Marketplace, employee internal job board (8a).
 *
 * A thin Server Component wrapper. The board itself is a Client Component
 * (`MobilityBoard`) composing three live reads: "recommended for you" roles
 * (`api.getRecommendedRoles`, skill-graph matched with readiness + gap), the
 * org's open roles to browse (`api.listJobs`), and the employee's own internal
 * applications (`api.listInternalApplications`). Applying acts on the employee's
 * OWN behalf — the API resolves the acting employee from the session. In this
 * Phase-1 foundation the employee is read from `?employee=` for dev; in
 * production it comes from the authenticated Clerk session. All wire shapes are
 * from `@peopleos/schemas`.
 */
export default function MobilityPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Internal opportunities
          </h1>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/mobility/gigs" className="hover:text-foreground">
              Gigs &amp; stretch
            </Link>
            <Link href="/mobility/analytics" className="hover:text-foreground">
              Analytics
            </Link>
          </nav>
        </div>
        <p className="text-sm text-muted-foreground">
          Discover roles inside the company matched to your skills before you look
          outside. Each suggestion shows your skill match, your readiness, and the
          skills you would grow into. Suggestions are advisory.
        </p>
      </section>

      <MobilityBoard />
    </div>
  );
}
