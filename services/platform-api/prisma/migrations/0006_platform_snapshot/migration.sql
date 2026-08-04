-- v0.7 adapter boundary: persist the complete domain envelope in PostgreSQL
-- while normalized repositories are migrated one vertical slice at a time.
-- The singleton key makes startup selection and replacement deterministic.

CREATE TABLE "PlatformSnapshot" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSnapshot_pkey" PRIMARY KEY ("id")
);
