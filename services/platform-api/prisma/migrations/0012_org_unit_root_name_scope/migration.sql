-- PostgreSQL treats NULLs as distinct in a regular unique index.  Keep the
-- parent/name invariant for both non-root siblings and the single root level.
DROP INDEX IF EXISTS "OrgUnit_parentId_name_key";

CREATE UNIQUE INDEX "OrgUnit_parentId_name_key"
ON "OrgUnit"("parentId", "name")
WHERE "parentId" IS NOT NULL;

CREATE UNIQUE INDEX "OrgUnit_root_name_key"
ON "OrgUnit"("name")
WHERE "parentId" IS NULL;
