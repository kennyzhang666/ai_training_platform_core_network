-- Bind an immutable upload capability to the intended submission subject.
-- Existing sessions predate delegated/admin uploads, so their actor is the
-- only safe subject that can be backfilled.

ALTER TABLE "UploadSession" ADD COLUMN "subjectId" TEXT;
UPDATE "UploadSession" SET "subjectId" = "actorId" WHERE "subjectId" IS NULL;
ALTER TABLE "UploadSession" ALTER COLUMN "subjectId" SET NOT NULL;

CREATE INDEX "UploadSession_actorId_eventId_subjectId_idx"
  ON "UploadSession"("actorId", "eventId", "subjectId");
