-- SQL-only safeguards Prisma cannot express in schema.prisma.
-- Runs after the initial schema migration on an empty database.

-- ---------------------------------------------------------------------------
-- AuditLog.scope <-> organisationId invariant
-- ORG requires organisationId; PLATFORM requires organisationId IS NULL
-- ---------------------------------------------------------------------------
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_scope_organisation_check";
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_scope_organisation_check" CHECK (
    ("scope" = 'ORG' AND "organisationId" IS NOT NULL)
    OR ("scope" = 'PLATFORM' AND "organisationId" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Protect the platform organisation from hard-delete and soft-delete
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_platform_org_hard_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."isPlatform" IS TRUE THEN
    RAISE EXCEPTION 'Cannot delete platform organisation (%)', OLD."slug";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_platform_org_hard_delete ON "Organisation";
CREATE TRIGGER trg_prevent_platform_org_hard_delete
  BEFORE DELETE ON "Organisation"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_platform_org_hard_delete();

CREATE OR REPLACE FUNCTION prevent_platform_org_soft_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."isPlatform" IS TRUE
     AND NEW."deletedAt" IS NOT NULL
     AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION 'Cannot soft-delete platform organisation (%)', OLD."slug";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_platform_org_soft_delete ON "Organisation";
CREATE TRIGGER trg_prevent_platform_org_soft_delete
  BEFORE UPDATE OF "deletedAt" ON "Organisation"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_platform_org_soft_delete();
