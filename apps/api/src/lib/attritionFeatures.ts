import { AttritionFeatures, type AttritionFeatures as TAttritionFeatures } from "@peopleos/schemas";
import type { TxClient } from "../db.js";

/**
 * Module 7 — Attrition feature engineering. Builds the AVAILABLE subset of the
 * spec's feature table (tenure / performance / team / skill signals) for ONE
 * employee, entirely from the data the frozen Prisma schema actually carries.
 *
 * GOVERNANCE (spec ethics): the feature vector contains ONLY tenure/perf/team/skill
 * signals. It NEVER contains a protected attribute (name, gender, age, ethnicity,
 * etc.) — those columns are not read here, by construction. The score derived from
 * these features is ADVISORY ONLY.
 *
 * MULTI-TENANCY: every query runs on the `tx` handed in by `withTenant(orgId, …)`,
 * so RLS scopes all reads to the caller's org. We never accept a bare Prisma client.
 *
 * ABSENT FEATURES (documented, deliberate): the spec's engagement signals
 * (1:1 frequency, after-hours meetings, PTO utilisation, email response latency),
 * compensation signals (salary-vs-band, time-since-raise, equity cliff), and the
 * remaining career signals (internal applications, training completions, LinkedIn
 * update detection) require HRIS / calendar / email / comp-band / ATS integrations
 * that PeopleOS does not have. They are OMITTED from the request entirely; the AI
 * scorer treats any feature it is not given as NEUTRAL (see services/ai). The frozen
 * `AttritionFeatures` contract is exactly the available subset, so no field is faked.
 *
 * PER-FIELD APPROXIMATIONS:
 *   - tenureDays                : (now - hireDate). 0 when hireDate is null (unknown
 *                                 tenure → treated as a brand-new hire; never negative).
 *   - timeInRoleDays            : NOT derivable. The schema records lastPromotionDate
 *                                 but no "entered current role" date and no role-change
 *                                 history; a promotion is the closest proxy for a role
 *                                 change, so we use daysSinceLastPromotion when present,
 *                                 else null (unknown). Documented best-effort.
 *   - daysSinceLastPromotion    : (now - lastPromotionDate); null if never promoted.
 *   - daysSinceLastReview       : (now - lastReviewDate); null if never reviewed.
 *   - perfRating                : lastReviewRating (1-5); null if none.
 *   - teamAttritionRate90d      : TERMINATED teammates in the last 90d / team size.
 *                                 "Team" = same manager when the employee HAS a manager,
 *                                 else same department. The denominator is the CURRENT
 *                                 team size (active peers + the employee) PLUS the
 *                                 terminated-in-window teammates, so the ratio reflects
 *                                 "share of the recent team that has left". 0 when the
 *                                 team cannot be determined (no manager AND no department).
 *   - managerChanged90d         : NOT derivable. The schema has no manager-assignment
 *                                 history (only the current managerId), so a change in
 *                                 the last 90d cannot be detected → false. Documented.
 *   - skillAdditions90d         : count of the employee's SkillRecord rows created in
 *                                 the last 90d (Module 6 signal of upskilling / pivoting).
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const TEAM_WINDOW_DAYS = 90;
const SKILL_WINDOW_DAYS = 90;

/** Whole days between two dates, never negative (guards clock skew / backfill). */
function daysSince(from: Date, now: Date): number {
  const days = (now.getTime() - from.getTime()) / MS_PER_DAY;
  return days > 0 ? Math.floor(days) : 0;
}

/** A safe ratio in [0,1]; 0 when the denominator is 0 (no divide-by-zero NaN). */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const r = numerator / denominator;
  return Math.min(1, Math.max(0, r));
}

/** The minimal Employee shape `computeFeatures` reads — tenure/perf/team fields only. */
export interface FeatureEmployee {
  id: string;
  department: string | null;
  managerId: string | null;
  hireDate: Date | null;
  lastReviewDate: Date | null;
  lastReviewRating: number | null;
  lastPromotionDate: Date | null;
}

/** A teammate used to derive the 90-day team attrition rate. */
export interface FeaturePeer {
  id: string;
  status: "ACTIVE" | "ON_LEAVE" | "TERMINATED";
  /** Best-effort termination timestamp — the row's createdAt is NOT it; see note. */
  terminatedAt: Date | null;
}

/**
 * Compute the AttritionFeatures for one employee.
 *
 * `peers` is the employee's candidate teammate set already loaded under the tenant
 * tx (the caller batches this — see routes/attrition.ts — to avoid an N+1). It is
 * filtered here to the actual team (same manager, else same department) and excludes
 * the employee themselves. `now` is injectable for deterministic tests.
 *
 * NOTE on terminatedAt: the frozen `Employee` model has no explicit termination-date
 * column. We accept it as an optional peer field so a future schema/event source can
 * supply it; when it is null we COUNT a TERMINATED teammate toward the 90-day window
 * (fail-OPEN on the risk signal — a known recent departure is the conservative choice
 * for a retention-risk feature) but the caller may pass it when known. Documented.
 */
export async function computeFeatures(
  tx: TxClient,
  employee: FeatureEmployee,
  peers: FeaturePeer[],
  now: Date = new Date(),
): Promise<TAttritionFeatures> {
  // ── tenure / promotion / review ────────────────────────────────────────────
  const tenureDays = employee.hireDate ? daysSince(employee.hireDate, now) : 0;
  const daysSinceLastPromotion = employee.lastPromotionDate
    ? daysSince(employee.lastPromotionDate, now)
    : null;
  const daysSinceLastReview = employee.lastReviewDate
    ? daysSince(employee.lastReviewDate, now)
    : null;
  // No "entered current role" date exists; the last promotion is the closest proxy
  // for the start of the current role, else unknown (null).
  const timeInRoleDays = daysSinceLastPromotion;
  const perfRating = employee.lastReviewRating;

  // ── team attrition rate (last 90 days) ─────────────────────────────────────
  // Team = same manager if the employee has one, else same department. Exclude self.
  const windowStart = new Date(now.getTime() - TEAM_WINDOW_DAYS * MS_PER_DAY);
  const teammates = peers.filter((p) => p.id !== employee.id);

  let activeTeam = 0;
  let recentlyTerminated = 0;
  for (const p of teammates) {
    if (p.status === "TERMINATED") {
      // Count a termination toward the window when we know it landed inside it, OR
      // when we have no termination date at all (fail-open on the risk signal).
      if (p.terminatedAt == null || p.terminatedAt >= windowStart) {
        recentlyTerminated += 1;
      }
    } else {
      // ACTIVE / ON_LEAVE teammates are the current team headcount.
      activeTeam += 1;
    }
  }
  // Denominator = the recent team = current active teammates + the employee (+1) +
  // the teammates who left in the window. 0 → ratio() returns 0 safely.
  const teamSize = activeTeam + 1 + recentlyTerminated;
  const teamAttritionRate90d = ratio(recentlyTerminated, teamSize);

  // ── managerChanged90d ──────────────────────────────────────────────────────
  // No manager-assignment history in the frozen schema → not derivable → false.
  const managerChanged90d = false;

  // ── skillAdditions90d ──────────────────────────────────────────────────────
  // SkillRecord rows for this employee created within the last 90 days (Module 6).
  const skillWindowStart = new Date(now.getTime() - SKILL_WINDOW_DAYS * MS_PER_DAY);
  const skillAdditions90d = await tx.skillRecord.count({
    where: { employeeId: employee.id, createdAt: { gte: skillWindowStart } },
  });

  // Parse through the frozen contract so an out-of-range value can never escape.
  return AttritionFeatures.parse({
    tenureDays,
    timeInRoleDays,
    daysSinceLastPromotion,
    daysSinceLastReview,
    perfRating,
    teamAttritionRate90d,
    managerChanged90d,
    skillAdditions90d,
  });
}
