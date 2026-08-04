-- v0.7 identity persistence: preserve local SSO hints and unscoped roles.
-- Existing migrations are immutable; this migration only adds nullable/JSON
-- fields needed to represent the current AppUser domain without loss.

ALTER TABLE "AppUser"
ADD COLUMN "departmentHint" TEXT,
ADD COLUMN "departmentSource" TEXT,
ADD COLUMN "roles" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX "AppUser_status_idx" ON "AppUser"("status");
