-- Migration number: 0011	2026-03-15

-- Recreate extracted_entity with self-referential FK on parent_id
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
  FOREIGN KEY (source_chunk_id) REFERENCES text_chunk (id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES extracted_entity (id) ON DELETE CASCADE
);

INSERT INTO extracted_entity SELECT * FROM _temp_extracted_entity;
DROP TABLE _temp_extracted_entity;

-- Indexes
CREATE INDEX idx_extracted_entity_document ON extracted_entity (source_document_id, scope);
CREATE INDEX idx_extracted_entity_parent ON extracted_entity (parent_id);

-- Trigger: delete parent when its last child is deleted
CREATE TRIGGER cleanup_orphan_parent_entity
AFTER DELETE ON extracted_entity
WHEN OLD.parent_id IS NOT NULL
BEGIN
  DELETE FROM extracted_entity
  WHERE id = OLD.parent_id
    AND NOT EXISTS (
      SELECT 1 FROM extracted_entity WHERE parent_id = OLD.parent_id
    );
END;
