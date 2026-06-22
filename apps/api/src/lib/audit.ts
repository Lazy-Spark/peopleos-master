import type { Prisma } from "@prisma/client";
import type { TxClient } from "../db.js";

/**
 * An audit log entry. `actorId` is the user who triggered the action (may be null
 * for system actions). `payload` captures a structured, non-sensitive snapshot of
 * what happened — enough for governance/SOC2 review without storing raw PII.
 *
 * IMPORTANT: never put chain-of-thought, raw resume text, or secrets in `payload`.
 * CoT lives only in CandidateRanking.reasoning (prompt standard #3).
 */
export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Insert an AuditLog row WITHIN the caller's tenant transaction.
 *
 * Must be called with the same `tx` used for the business write so the audit
 * entry (a) is covered by the same RLS org context (org_id is set on the GUC),
 * and (b) commits or rolls back atomically with the action it records — you can
 * never have an action without its audit trail, or vice versa.
 *
 * `orgId` is intentionally NOT a parameter: RLS's WITH CHECK derives org_id from
 * the transaction's `app.current_org_id`, and we set it explicitly below to match
 * so the insert satisfies the policy. We read it back from the GUC to avoid the
 * caller having to thread it through.
 */
export async function writeAudit(tx: TxClient, entry: AuditEntry): Promise<void> {
  // The org context is already pinned on this transaction by withTenant(); reuse it.
  const rows = await tx.$queryRaw<Array<{ org_id: string | null }>>`
    SELECT current_setting('app.current_org_id', true)::uuid AS org_id
  `;
  const orgId = rows[0]?.org_id ?? null;
  if (!orgId) {
    // Defensive: writeAudit must always run inside withTenant.
    throw new Error("writeAudit called outside a tenant transaction (app.current_org_id unset)");
  }

  await tx.auditLog.create({
    data: {
      orgId,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      payload: entry.payload ?? {},
      ipAddress: entry.ip ?? null,
    },
  });
}
