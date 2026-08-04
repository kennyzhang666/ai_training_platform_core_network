-- v0.7 durable object-upload capabilities.  The bearer token remains only
-- with the caller; PostgreSQL stores its digest and CAS lifecycle state.

CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "uploadedSize" INTEGER,
    "uploadedSha256" TEXT,
    "completedUri" TEXT,
    "completedSize" INTEGER,
    "completedSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UploadSession_expiresAt_status_idx" ON "UploadSession"("expiresAt", "status");
CREATE INDEX "UploadSession_actorId_eventId_idx" ON "UploadSession"("actorId", "eventId");
