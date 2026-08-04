-- v0.7 organization names are unique within one parent.  The database
-- constraint closes the race left by service-level sibling validation.
CREATE UNIQUE INDEX "OrgUnit_parentId_name_key" ON "OrgUnit"("parentId", "name");
