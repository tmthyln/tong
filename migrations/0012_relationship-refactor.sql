-- Migration number: 0012   2026-03-16

DROP TABLE IF EXISTS extracted_relationship;

CREATE TABLE extracted_relationship (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER,
  from_entity_id INTEGER NOT NULL,
  to_entity_id INTEGER NOT NULL,
  edge_type TEXT NOT NULL,
  explanation TEXT,
  scope TEXT NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id) ON DELETE CASCADE,
  FOREIGN KEY (from_entity_id) REFERENCES extracted_entity (id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity_id) REFERENCES extracted_entity (id) ON DELETE CASCADE
);

CREATE INDEX idx_extracted_relationship_document ON extracted_relationship (source_document_id, scope);
CREATE INDEX idx_extracted_relationship_from ON extracted_relationship (from_entity_id);
CREATE INDEX idx_extracted_relationship_to ON extracted_relationship (to_entity_id);
