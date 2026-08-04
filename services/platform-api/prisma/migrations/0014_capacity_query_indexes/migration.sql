-- High-cardinality administration pages must not sort the complete table for
-- every request.  Keep the deterministic id tie-breaker in each index so
-- page boundaries remain stable when values are equal.
CREATE INDEX "AppUser_name_id_idx" ON "AppUser"("name", "id");
CREATE INDEX "AppUser_orgPath_id_idx" ON "AppUser"("orgPath", "id");
CREATE INDEX "AppUser_status_employeeNo_id_idx" ON "AppUser"("status", "employeeNo", "id");
CREATE INDEX "AppUser_status_name_id_idx" ON "AppUser"("status", "name", "id");
CREATE INDEX "AppUser_status_orgPath_id_idx" ON "AppUser"("status", "orgPath", "id");
CREATE INDEX "Submission_event_state_createdAt_id_idx" ON "Submission"("eventId", "state", "createdAt", "id");
CREATE INDEX "Submission_subject_createdAt_id_idx" ON "Submission"("subjectId", "createdAt", "id");
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");
