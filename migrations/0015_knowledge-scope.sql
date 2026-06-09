-- Migration number: 0015   2026-05-25

-- Knowledge scope hierarchy: defines the "universe" an entity/relationship is
-- valid in. Independent of document_group (folders), which only organizes docs.
-- Scope ladder: chunk > document > scope (nestable) > global.
-- parent_id NULL means top-level (the global ceiling); there is no dedicated
-- global row. A document has no knowledge scope by default.
CREATE TABLE knowledge_scope (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  FOREIGN KEY (parent_id) REFERENCES knowledge_scope (id) ON DELETE CASCADE
);
CREATE INDEX idx_knowledge_scope_parent_id ON knowledge_scope (parent_id);

-- A document optionally belongs to ONE knowledge scope; NULL by default.
-- Deleting a scope detaches its documents (keeps the documents).
ALTER TABLE document
  ADD COLUMN knowledge_scope_id INTEGER DEFAULT NULL
  REFERENCES knowledge_scope (id) ON DELETE SET NULL;
CREATE INDEX idx_document_knowledge_scope_id ON document (knowledge_scope_id);

-- Scope-level entities live in a knowledge scope (scope = 'scope'), not a
-- document/chunk. NULL for chunk/document-scoped rows. Produced by a future
-- upward-resolution step; the column exists now so queries can target it.
ALTER TABLE extracted_entity
  ADD COLUMN knowledge_scope_id INTEGER DEFAULT NULL
  REFERENCES knowledge_scope (id) ON DELETE CASCADE;
CREATE INDEX idx_extracted_entity_knowledge_scope
  ON extracted_entity (knowledge_scope_id, scope);

ALTER TABLE extracted_relationship
  ADD COLUMN knowledge_scope_id INTEGER DEFAULT NULL
  REFERENCES knowledge_scope (id) ON DELETE CASCADE;
CREATE INDEX idx_extracted_relationship_knowledge_scope
  ON extracted_relationship (knowledge_scope_id, scope);
