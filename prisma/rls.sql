-- ─────────────────────────────────────────────────────────────────────────────
-- PeopleOS Row-Level Security — multi-tenant isolation backstop.
--
-- Apply AFTER `prisma migrate` creates the tables:
--   psql "$DATABASE_URL" -f prisma/rls.sql
--
-- Model: the API connects as `peopleos_app` and, per request, runs
--   SET LOCAL app.current_org_id = '<org-uuid>';
-- inside a transaction. Every policy checks org_id against that setting.
-- `current_setting(..., true)` returns NULL when unset → the predicate is false
-- → ZERO rows are visible. This FAILS CLOSED: a query that forgets to set the
-- tenant context sees nothing, rather than leaking another org's data.
--
-- Idempotent: safe to re-run. We use FORCE ROW LEVEL SECURITY so policies apply
-- even to a table's OWNER — true defence-in-depth: a connection that is accidentally
-- made as the owner role does NOT silently bypass tenant isolation (fail-open). Only
-- a SUPERUSER or a role with BYPASSRLS bypasses FORCE. Migrations/seed still work
-- because they run as a superuser (the local `peopleos` POSTGRES_USER). If you run
-- migrate/seed as a NON-superuser owner, run them as a BYPASSRLS role, or set
-- app.current_org_id per org in the seed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Tenant tables keyed by org_id.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users', 'job_openings', 'candidates', 'applications', 'interviews',
    'scorecards', 'offers', 'candidate_rankings', 'audit_logs', 'human_review_jobs',
    -- Module 4 — company knowledge base + HR chatbot
    'policy_documents', 'document_chunks', 'chat_sessions', 'chat_messages', 'hr_tickets',
    -- Module 5 / HRMS — employee records
    'employees',
    -- Module 6 — employee skill graph
    'skills', 'skill_records',
    -- Module 7 — attrition prediction
    'attrition_scores',
    -- Module 8 — internal talent marketplace
    'internal_applications', 'gigs', 'gig_interests',
    -- Module 9 — workflow automation engine
    'workflow_definitions', 'workflow_instances', 'workflow_tasks',
    -- Module 10 — agentic HR assistant
    'assistant_sessions', 'assistant_messages'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (org_id = current_setting(''app.current_org_id'', true)::uuid) '
      || 'WITH CHECK (org_id = current_setting(''app.current_org_id'', true)::uuid);',
      t
    );
    -- Belt-and-braces grant in case default privileges were not in effect.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO peopleos_app;', t);
  END LOOP;
END
$$;

-- The organisations table is keyed by its own id (a tenant may read only its row).
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organisations;
CREATE POLICY tenant_isolation ON organisations
  USING (id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON organisations TO peopleos_app;

-- prompt_versions is global (versioned in Git, per-org A/B via feature flags):
-- readable by the app role, no tenant policy.
GRANT SELECT ON prompt_versions TO peopleos_app;

-- Order-independent privileges (belt-and-braces with init's ALTER DEFAULT
-- PRIVILEGES): grant on everything that exists now, so the app role is never left
-- without a grant regardless of which role or order created the tables. RLS — not
-- table privileges — is what enforces tenant isolation, so a broad grant here is safe.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO peopleos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO peopleos_app;
