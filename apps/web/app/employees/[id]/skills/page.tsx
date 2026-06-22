import Link from "next/link";

import { EmployeeSkillProfile } from "./employee-skill-profile";
import { api } from "@/lib/api";
import type { JobOpening } from "@peopleos/schemas";

export const dynamic = "force-dynamic";

/**
 * Module 6a — Employee skill profile route shell.
 *
 * Server Component. It pre-fetches the org's open roles server-side (for the
 * growth-path target picker — each role's `jdStructured.requiredSkills` is the
 * bar) and hands them to the client `EmployeeSkillProfile`, which composes the
 * live profile read, the self-report "add skill" control, the per-record manager
 * Verify control (6d), and the AI growth-path panel.
 *
 * `canVerify` decides whether the manager Verify control is shown (spec 6d:
 * ADMIN / HRBP / MANAGER). The API is the real authorisation boundary; in this
 * Phase-1 web foundation it's defaulted on and can be toggled in dev with
 * `?role=EMPLOYEE` (any non-privileged role hides the control).
 */
const PRIVILEGED_ROLES = new Set(["ADMIN", "HRBP", "MANAGER"]);

export default async function EmployeeSkillsPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { role?: string };
}) {
  // Roles power the growth-path picker; a failure here shouldn't break the page.
  let roles: JobOpening[] = [];
  try {
    roles = await api.listJobs({ limit: 100 });
  } catch {
    roles = [];
  }

  // Dev role hint only; the API enforces verification authorisation server-side.
  const role = searchParams.role?.toUpperCase();
  const canVerify = role ? PRIVILEGED_ROLES.has(role) : true;

  return (
    <div className="space-y-6">
      <Link
        href="/skills/team"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Team skill map
      </Link>
      <EmployeeSkillProfile
        employeeId={params.id}
        roles={roles}
        canVerify={canVerify}
      />
    </div>
  );
}
