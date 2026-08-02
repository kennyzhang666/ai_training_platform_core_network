-- Initial relational contract for the production adapter.
-- Local development intentionally continues to use PlatformStore's file adapter.

CREATE TYPE "SubmissionSource" AS ENUM ('UPLOAD', 'GIT_REF');
CREATE TYPE "TriggerType" AS ENUM ('AUTO', 'MANUAL', 'IMPORT');
CREATE TYPE "RevealMode" AS ENUM ('IMMEDIATE', 'ON_RELEASE');
CREATE TYPE "EventStatus" AS ENUM ('OPEN', 'CLOSED', 'RELEASED');
CREATE TYPE "SubmissionState" AS ENUM ('RECEIVED', 'QUEUED', 'WAITING_TRIGGER', 'WAITING_IMPORT', 'IMPORT_VALIDATING', 'GRADED', 'SEALED', 'REVEALED');

CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrgUnit_path_key" ON "OrgUnit"("path");
CREATE INDEX "OrgUnit_parentId_idx" ON "OrgUnit"("parentId");
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "employeeNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "orgPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppUser_employeeNo_key" ON "AppUser"("employeeNo");
CREATE INDEX "AppUser_orgPath_idx" ON "AppUser"("orgPath");
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RoleBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopeOrgPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoleBinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoleBinding_userId_role_scopeOrgPath_key" ON "RoleBinding"("userId", "role", "scopeOrgPath");
CREATE INDEX "RoleBinding_scopeOrgPath_idx" ON "RoleBinding"("scopeOrgPath");
ALTER TABLE "RoleBinding" ADD CONSTRAINT "RoleBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "ownerOrgPath" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChallengeVersion" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "objectives" JSONB,
    "requirements" JSONB,
    "constraints" JSONB,
    "deliverables" JSONB,
    "tags" JSONB,
    "estimatedMinutes" INTEGER,
    "zone" TEXT NOT NULL,
    "languagePolicy" JSONB NOT NULL,
    "deliveryPolicy" JSONB NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "submissionContract" JSONB NOT NULL,
    "tests" JSONB,
    "resources" JSONB,
    "resourceLimits" JSONB,
    "changePackage" JSONB,
    "visibility" TEXT,
    "bounty" DECIMAL(8,2),
    "explore" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChallengeVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChallengeVersion_challengeId_version_key" ON "ChallengeVersion"("challengeId", "version");
ALTER TABLE "ChallengeVersion" ADD CONSTRAINT "ChallengeVersion_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "challengeVersionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "submissionSource" "SubmissionSource" NOT NULL,
    "deliveryConfig" JSONB NOT NULL,
    "trigger" "TriggerType" NOT NULL,
    "reveal" "RevealMode" NOT NULL,
    "participantMode" TEXT NOT NULL DEFAULT 'OPEN',
    "rubricVersion" TEXT NOT NULL DEFAULT '1.0',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" "EventStatus" NOT NULL DEFAULT 'OPEN',
    "localGrading" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Event" ADD CONSTRAINT "Event_challengeVersionId_fkey" FOREIGN KEY ("challengeVersionId") REFERENCES "ChallengeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeasonEvent" (
    "seasonId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "weight" DECIMAL(8,3) NOT NULL DEFAULT 1,
    CONSTRAINT "SeasonEvent_pkey" PRIMARY KEY ("seasonId", "eventId")
);
CREATE INDEX "SeasonEvent_eventId_idx" ON "SeasonEvent"("eventId");
ALTER TABLE "SeasonEvent" ADD CONSTRAINT "SeasonEvent_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeasonEvent" ADD CONSTRAINT "SeasonEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Participation" (
    "eventId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "orgPathSnapshot" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Participation_pkey" PRIMARY KEY ("eventId", "subjectId")
);
CREATE INDEX "Participation_subjectId_idx" ON "Participation"("subjectId");
ALTER TABLE "Participation" ADD CONSTRAINT "Participation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Participation" ADD CONSTRAINT "Participation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AppUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "orgPathSnapshot" TEXT,
    "sourceType" "SubmissionSource" NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "artifactUri" TEXT,
    "artifactHash" TEXT,
    "repository" TEXT,
    "branch" TEXT,
    "commitSha" TEXT,
    "workspacePath" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "state" "SubmissionState" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Submission_eventId_subjectId_snapshotHash_key" ON "Submission"("eventId", "subjectId", "snapshotHash");
CREATE INDEX "Submission_eventId_state_idx" ON "Submission"("eventId", "state");
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AppUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GradingRun" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "triggerType" "TriggerType" NOT NULL,
    "triggeredBy" TEXT,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "graderVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GradingRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GradingRun_submissionId_idempotencyKey_key" ON "GradingRun"("submissionId", "idempotencyKey");
ALTER TABLE "GradingRun" ADD CONSTRAINT "GradingRun_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "gradingRunId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "total" DECIMAL(6,2) NOT NULL,
    "status" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvaluationResult_gradingRunId_key" ON "EvaluationResult"("gradingRunId");
CREATE UNIQUE INDEX "EvaluationResult_submissionId_key" ON "EvaluationResult"("submissionId");
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_gradingRunId_fkey" FOREIGN KEY ("gradingRunId") REFERENCES "GradingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CriterionResult" (
    "id" TEXT NOT NULL,
    "evaluationResultId" TEXT NOT NULL,
    "criterionKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "score" DECIMAL(6,2) NOT NULL,
    "max" DECIMAL(6,2) NOT NULL,
    "source" TEXT NOT NULL,
    "evidenceJson" JSONB,
    CONSTRAINT "CriterionResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CriterionResult_evaluationResultId_criterionKey_key" ON "CriterionResult"("evaluationResultId", "criterionKey");
ALTER TABLE "CriterionResult" ADD CONSTRAINT "CriterionResult_evaluationResultId_fkey" FOREIGN KEY ("evaluationResultId") REFERENCES "EvaluationResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "evaluationResultId" TEXT NOT NULL,
    "criterionKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file" TEXT,
    "line" INTEGER,
    "detail" TEXT NOT NULL,
    "fix" TEXT,
    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_evaluationResultId_fkey" FOREIGN KEY ("evaluationResultId") REFERENCES "EvaluationResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_target_createdAt_idx" ON "AuditLog"("target", "createdAt");

CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
