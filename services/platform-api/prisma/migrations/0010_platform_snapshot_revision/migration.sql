-- v0.7 multi-instance safety for the transitional full-state writer.
-- A writer claims the next revision before replacing normalized projections;
-- stale API instances fail with a conflict instead of silently overwriting a
-- concurrent committed state.
ALTER TABLE "PlatformSnapshot"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
