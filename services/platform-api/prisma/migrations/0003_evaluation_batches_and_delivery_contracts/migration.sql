-- Persist challenge-version delivery contracts and Code Agent batch leases.

ALTER TYPE "SubmissionState" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "AppUser"
ALTER COLUMN "orgUnitId" DROP NOT NULL,
ALTER COLUMN "orgPath" DROP NOT NULL;

ALTER TABLE "ChallengeVersion"
ADD COLUMN "submissionContractDefinition" JSONB,
ADD COLUMN "evaluationEngine" JSONB;

DROP INDEX "EvaluationResult_submissionId_key";
CREATE INDEX "EvaluationResult_submissionId_createdAt_idx" ON "EvaluationResult"("submissionId", "createdAt");

CREATE TABLE "EvaluationBatch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "challengeVersionId" TEXT NOT NULL,
    "runIds" JSONB NOT NULL,
    "submissionIds" JSONB NOT NULL,
    "engineIdentity" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "leaseId" TEXT,
    "completionLeaseId" TEXT,
    "leasedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "completedRunIds" JSONB,
    "failedRunIds" JSONB,
    "failureReason" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EvaluationBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GradingRun"
ADD COLUMN "evaluationBatchId" TEXT;

CREATE INDEX "EvaluationBatch_eventId_status_idx" ON "EvaluationBatch"("eventId", "status");
CREATE INDEX "EvaluationBatch_status_createdAt_idx" ON "EvaluationBatch"("status", "createdAt");
CREATE INDEX "GradingRun_evaluationBatchId_idx" ON "GradingRun"("evaluationBatchId");

ALTER TABLE "EvaluationBatch"
ADD CONSTRAINT "EvaluationBatch_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EvaluationBatch"
ADD CONSTRAINT "EvaluationBatch_challengeVersionId_fkey"
FOREIGN KEY ("challengeVersionId") REFERENCES "ChallengeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GradingRun"
ADD CONSTRAINT "GradingRun_evaluationBatchId_fkey"
FOREIGN KEY ("evaluationBatchId") REFERENCES "EvaluationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
