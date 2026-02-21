-- Migration number: 0006 	 2026-02-04

-- Allow parent_id to be NULL on extracted_entity

CREATE TABLE _temp_extracted_entity AS SELECT * FROM extracted_entity;
DROP TABLE extracted_entity;

CREATE TABLE extracted_entity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER,
  source_chunk_id INTEGER,
  entity_type TEXT NOT NULL,
  extracted_text TEXT,
  chunk_start_index INTEGER,
  chunk_end_index INTEGER,
  label TEXT DEFAULT NULL,
  scope TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id) ON DELETE CASCADE,
  FOREIGN KEY (source_chunk_id) REFERENCES text_chunk (id) ON DELETE CASCADE
);

INSERT INTO extracted_entity SELECT * FROM _temp_extracted_entity;
DROP TABLE _temp_extracted_entity;