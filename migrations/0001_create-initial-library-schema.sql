-- Migration number: 0001 	 2026-02-01T16:06:02.140Z

-- Document group table (created first as document references it)
CREATE TABLE document_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  group_type TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES document_group (id)
);

CREATE INDEX idx_document_group_parent_id ON document_group (parent_id);

-- Document table
CREATE TABLE document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_doc_location TEXT NOT NULL,
  original_doc_filename TEXT NOT NULL,
  original_doc_mimetype TEXT NOT NULL,
  original_doc_content_hash TEXT NOT NULL,
  date_uploaded TEXT NOT NULL,
  date_last_accessed TEXT DEFAULT NULL,
  date_last_modified TEXT DEFAULT NULL,
  extracted_doc_location TEXT NOT NULL,
  extracted_doc_char_count INTEGER NOT NULL,
  extracted_doc_unique_char_count INTEGER NOT NULL,
  parent_id INTEGER,
  FOREIGN KEY (parent_id) REFERENCES document_group (id)
);

CREATE INDEX idx_document_content_hash ON document (original_doc_content_hash);
CREATE INDEX idx_document_parent_id ON document (parent_id);

-- Text chunk table
CREATE TABLE text_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER NOT NULL,
  chunk_order INTEGER NOT NULL,
  extracted_doc_start_index INTEGER NOT NULL,
  extracted_doc_end_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  unique_char_count INTEGER NOT NULL,
  FOREIGN KEY (source_document_id) REFERENCES document (id)
);

CREATE INDEX idx_text_chunk_source_document ON text_chunk (source_document_id, chunk_order);

-- Translation chunk table
CREATE TABLE translation_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_chunk_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  translator TEXT NOT NULL,
  date_created TEXT NOT NULL,
  date_last_modified TEXT,
  FOREIGN KEY (text_chunk_id) REFERENCES text_chunk (id)
);

CREATE INDEX idx_translation_chunk_text_chunk ON translation_chunk (text_chunk_id, date_last_modified DESC);

-- Extracted entity table
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
  FOREIGN KEY (source_document_id) REFERENCES document (id),
  FOREIGN KEY (source_chunk_id) REFERENCES text_chunk (id)
);