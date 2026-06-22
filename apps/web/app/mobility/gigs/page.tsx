import Link from "next/link";

import { GigMarketplace } from "./gig-marketplace";

export const dynamic = "force-dynamic";

/**
 * Module 8c — the gig / stretch marketplace (employee-facing).
 *
 * A thin Server Component wrapper. The marketplace is a Client Component
 * (`GigMarketplace`) composing recommended gigs (`api.getRecommendedGigs`,
 * skill-graph matched), the browse listing (`api.listGigs`), and a post-a-gig
 * form (`api.createGig`, manager / HRBP). Expressing interest acts on the
 * employee's OWN behalf — the API resolves the acting employee from the session.
 * Wire shapes from `@peopleos/schemas`.
 */
export default function GigsPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Gigs &amp; stretch assignments
          </h1>
          <Link
            href="/mobility"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Internal roles
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Short, skill-building assignments across the company. Recommended gigs
          are matched to your skills; expressing interest notifies HR without
          alerting your manager.
        </p>
      </section>

      <GigMarketplace />
    </div>
  );
}
