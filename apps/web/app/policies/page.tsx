import { PoliciesManager } from "./policies-manager";

/**
 * Module 4 / Layer 2C — Policy knowledge base (HRBP/ADMIN).
 *
 * A thin shell; the upload form + live policy list + archive action live in the
 * `PoliciesManager` client component (it owns the `ingestPolicy` / `listPolicies`
 * / `deletePolicy` calls and the shared TanStack Query cache). The API enforces
 * the HRBP/ADMIN authorisation and tenant scoping server-side.
 */
export default function PoliciesPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <p className="text-sm text-muted-foreground">
          Manage the company policy documents that power the Employee HR
          Assistant. Uploads are chunked, embedded, and indexed; the assistant
          answers only from these documents and cites them. HRBP / Admin only.
        </p>
      </div>

      <PoliciesManager />
    </div>
  );
}
