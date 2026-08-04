-- v0.7 domain lifecycle fields. Existing migrations remain immutable.

ALTER TABLE "Challenge"
ADD COLUMN "archivedFrom" TEXT,
ADD COLUMN "board" JSONB;

ALTER TABLE "Event"
ADD COLUMN "purpose" TEXT,
ADD COLUMN "accessPolicy" JSONB;

ALTER TABLE "Submission"
ADD COLUMN "artifactName" TEXT,
ADD COLUMN "challengeVersionSnapshot" TEXT,
ADD COLUMN "rubricVersionSnapshot" TEXT,
ADD COLUMN "gradingStatus" TEXT,
ADD COLUMN "gradingAttempt" INTEGER,
ADD COLUMN "previousResultIds" JSONB,
ADD COLUMN "failureReason" TEXT;

CREATE INDEX "Submission_eventId_gradingStatus_idx" ON "Submission"("eventId", "gradingStatus");

ALTER TABLE "GradingRun"
ADD COLUMN "attempt" INTEGER,
ADD COLUMN "failureReason" TEXT,
ADD COLUMN "leaseId" TEXT,
ADD COLUMN "leasedBy" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "GradingRun_leaseExpiresAt_idx" ON "GradingRun"("leaseExpiresAt");
