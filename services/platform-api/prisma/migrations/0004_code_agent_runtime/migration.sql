-- Global Code Agent invocation settings and the immutable snapshot used by a batch.

ALTER TABLE "EvaluationBatch"
ADD COLUMN "codeAgentRuntime" JSONB;

CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);
