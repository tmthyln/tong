-- Migration number: 0003 	 2026-02-03

-- Add ON DELETE CASCADE to foreign keys for text_chunk, translation_chunk, and extracted_entity
-- SQLite requires recreating tables to modify foreign key constraints

-- Step 1: Backup data to temporary tables (no foreign keys)
CREATE TABLE _temp_text_chunk AS SELECT * FROM text_chunk;
CREATE TABLE _temp_translation_chunk AS SELECT * FROM translation_chunk;
CREATE TABLE _temp_extracted_entity AS SELECT * FROM extracted_entity;

-- Step 2: Drop tables in reverse dependency order
DROP INDEX IF EXISTS idx_translation_chunk_text_chunk;
DROP INDEX IF EXISTS idx_text_chunk_source_document;
DROP TABLE extracted_entity;
DROP TABLE translation_chunk;
DROP TABLE text_chunk;

-- Step 3: Recreate tables with CASCADE in dependency order
CREATE TABLE text_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER NOT NULL,
  chunk_order INTEGER NOT NULL,
  extracted_doc_start_index INTEGER NOT NULL,
  extracted_doc_end_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  unique_char_count INTEGER NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id) ON DELETE CASCADE
);
CREATE INDEX idx_text_chunk_source_document ON text_chunk (source_document_id, chunk_order);

CREATE TABLE translation_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_chunk_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  translator TEXT NOT NULL,
  date_created TEXT NOT NULL,
  date_last_modified TEXT,
  FOREIGN KEY (text_chunk_id) REFERENCES text_chunk (id) ON DELETE CASCADE
);
CREATE INDEX idx_translation_chunk_text_chunk ON translation_chunk (text_chunk_id, date_last_modified DESC);

CREATE TABLE extracted_entity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER,
  source_chunk_id INTEGER,
  entity_type TEXT NOT NULL,
  extracted_text TEXT,
  chunk_start_index INTEGER,
  chunk_end_index INTEGER,
  label TEXT,
  scope TEXT NOT NULL,
  parent_id INTEGER NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id) ON DELETE CASCADE,
  FOREIGN KEY (source_chunk_id) REFERENCES text_chunk (id) ON DELETE CASCADE
);

-- Step 4: Restore data in dependency order
INSERT INTO text_chunk SELECT * FROM _temp_text_chunk;
INSERT INTO translation_chunk SELECT * FROM _temp_translation_chunk;
INSERT INTO extracted_entity SELECT * FROM _temp_extracted_entity;

-- Step 5: Drop temporary tables
DROP TABLE _temp_text_chunk;
DROP TABLE _temp_translation_chunk;
DROP TABLE _temp_extracted_entity;