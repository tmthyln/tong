-- Migration number: 0009 	 2026-03-14

CREATE TABLE extracted_relationship (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER,
  source_chunk_id INTEGER,
  edge_type TEXT NOT NULL,
  from_entity_text TEXT NOT NULL,
  to_entity_text TEXT NOT NULL,
  scope TEXT NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id) ON DELETE CASCADE,
  FOREIGN KEY (source_chunk_id) REFERENCES text_chunk (id) ON DELETE CASCADE
);

CREATE INDEX idx_extracted_relationship_chunk ON extracted_relationship (source_chunk_id);
CREATE INDEX idx_extracted_relationship_document ON extracted_relationship (source_document_id);
