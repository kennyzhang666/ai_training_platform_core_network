-- v0.7 announcement organization scope.

ALTER TABLE "Announcement"
ADD COLUMN "orgPath" TEXT;

CREATE INDEX "Announcement_orgPath_idx" ON "Announcement"("orgPath");
