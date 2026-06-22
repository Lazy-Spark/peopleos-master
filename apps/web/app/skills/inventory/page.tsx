import { SkillInventoryView } from "./skill-inventory";

export const dynamic = "force-dynamic";

/**
 * Module 6c — Org-wide skill inventory route shell (HRBP / leadership-facing).
 *
 * A thin Server Component wrapper. The inventory itself is a Client Component
 * (`SkillInventoryView`) composing the live `api.getSkillInventory` read with the
 * per-gapped-skill AI "Build vs buy" action (`api.recommendBuildVsBuy`). All wire
 * shapes come from `@peopleos/schemas`; authorisation + tenant scoping are
 * enforced server-side.
 */
export default function SkillInventoryPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Skill inventory</h1>
        <p className="text-sm text-muted-foreground">
          Org-wide skill supply vs demand, with the talent-density index and a
          build-vs-buy recommendation for each gapped skill. Computed server-side
          from the tenant-scoped skill graph. HRBP / leadership view.
        </p>
      </section>

      <SkillInventoryView />
    </div>
  );
}
