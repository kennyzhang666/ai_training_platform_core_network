-- Separate compact card copy from the full challenge statement. Existing
-- descriptions were authored by the legacy rich-text editor and therefore
-- remain HTML; newly created versions default to Markdown.

ALTER TABLE "ChallengeVersion" ADD COLUMN "summary" TEXT;
ALTER TABLE "ChallengeVersion" ADD COLUMN "descriptionFormat" TEXT NOT NULL DEFAULT 'MARKDOWN';
UPDATE "ChallengeVersion"
SET "descriptionFormat" = 'HTML'
WHERE "description" IS NOT NULL;
