ALTER TABLE "Submission"
  ADD COLUMN "currentGradingRunId" TEXT,
  ADD COLUMN "currentResultId" TEXT;

CREATE INDEX "Submission_currentGradingRunId_idx" ON "Submission"("currentGradingRunId");
CREATE INDEX "Submission_currentResultId_idx" ON "Submission"("currentResultId");
