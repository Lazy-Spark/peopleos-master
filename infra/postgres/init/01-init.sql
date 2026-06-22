-- Runs once on first container init (as the superuser POSTGRES_USER=peopleos).
-- 1) pgvector extension (used later for local embedding dev).
-- 2) The request-time application role `peopleos_app`. It is a plain LOGIN role
--    (NOT a superuser, NOT the table owner), so it is SUBJECT to Row-Level
--    Security. The API connects with this role via DATABASE_URL_APP. Prisma
--    migrate/seed/studio use `peopleos` (owner) which BYPASSES RLS.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'peopleos_app') THEN
    CREATE ROLE peopleos_app LOGIN PASSWORD 'peopleos_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE peopleos TO peopleos_app;
GRANT USAGE ON SCHEMA public TO peopleos_app;

-- Tables created later by `peopleos` (Prisma migrate) become usable by the app
-- role automatically via default privileges.
ALTER DEFAULT PRIVILEGES FOR ROLE peopleos IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO peopleos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE peopleos IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO peopleos_app;
