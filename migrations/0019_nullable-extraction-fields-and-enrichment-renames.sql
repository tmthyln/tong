-- Migration number: 0019   2026-07-08

-- Document processing status tracking (#21): a document row must exist at
-- upload time, before extraction has produced markdown/char counts, so those
-- columns need to become nullable.

CREATE TABLE _temp_document AS SELECT * FROM document;
DROP INDEX IF EXISTS idx_document_content_hash;
DROP INDEX IF EXISTS idx_document_parent_id;
DROP INDEX IF EXISTS idx_document_knowledge_scope_id;
DROP TABLE document;

CREATE TABLE document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_doc_location TEXT NOT NULL,
  original_doc_filename TEXT NOT NULL,
  original_doc_mimetype TEXT NOT NULL,
  original_doc_content_hash TEXT NOT NULL,
  date_uploaded TEXT NOT NULL,
  date_last_accessed TEXT DEFAULT NULL,
  date_last_modified TEXT DEFAULT NULL,
  extracted_doc_location TEXT DEFAULT NULL,
  extracted_doc_char_count INTEGER DEFAULT NULL,
  extracted_doc_unique_char_count INTEGER DEFAULT NULL,
  parent_id INTEGER,
  title TEXT DEFAULT NULL,
  knowledge_scope_id INTEGER DEFAULT NULL,
  FOREIGN KEY (parent_id) REFERENCES document_group (id),
  FOREIGN KEY (knowledge_scope_id) REFERENCES knowledge_scope (id) ON DELETE SET NULL
);

CREATE INDEX idx_document_content_hash ON document (original_doc_content_hash);
CREATE INDEX idx_document_parent_id ON document (parent_id);
CREATE INDEX idx_document_knowledge_scope_id ON document (knowledge_scope_id);

INSERT INTO document SELECT * FROM _temp_document;
DROP TABLE _temp_document;

-- Rename enrichment kinds to match the tracked-enrichment vocabulary (#21).
UPDATE document_enrichment_run SET kind = 'coreference_resolution' WHERE kind = 'document_coreference';
UPDATE document_enrichment_run SET kind = 'entity_resolution' WHERE kind = 'scope_promotion';
UPDATE document_enrichment_run SET kind = 'entity_resolution_retroactive' WHERE kind = 'scope_promotion_retroactive';

-- Backfill: documents ingested before this feature existed have no runs at
-- all for document_stored/chunk_embedding/translation, and possibly none for
-- entity_extraction/coreference_resolution/relationship_extraction either
-- (e.g. if no node types were configured at the time). Record synthetic
-- completed runs for any preprocessing kind a document is missing, so they
-- read as "ready" instead of stuck at pending/processing forever.

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'document_stored',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'document_stored'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'chunk_embedding',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'chunk_embedding'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'entity_extraction',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'entity_extraction'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'coreference_resolution',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'coreference_resolution'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'relationship_extraction',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'relationship_extraction'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'initial_translation',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'initial_translation'
);

INSERT INTO document_enrichment_run
  (document_id, kind, status, model, params_json, ontology_json, started_at, completed_at)
SELECT
  d.id,
  'initial_translation_refinement',
  'completed',
  NULL,
  '{"backfilled":true}',
  '[]',
  COALESCE(d.date_uploaded, datetime('now')),
  COALESCE(d.date_uploaded, datetime('now'))
FROM document d
WHERE NOT EXISTS (
  SELECT 1 FROM document_enrichment_run r
  WHERE r.document_id = d.id AND r.kind = 'initial_translation_refinement'
);
