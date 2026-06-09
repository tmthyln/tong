-- A folder (document_group) may carry a "knowledge scope affinity": the scope
-- assigned to any document added to the folder that has no scope of its own.
-- Inheritance is nearest-ancestor (walk up parent_id to the closest folder with
-- an affinity). NULL = no affinity. Detaching the scope clears the affinity.
ALTER TABLE document_group
  ADD COLUMN knowledge_scope_id INTEGER DEFAULT NULL
  REFERENCES knowledge_scope (id) ON DELETE SET NULL;
CREATE INDEX idx_document_group_knowledge_scope_id
  ON document_group (knowledge_scope_id);
