CREATE TABLE document_enrichment_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  params_json TEXT NOT NULL,
  ontology_json TEXT NOT NULL,
  result_summary_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_enrichment_doc_kind
  ON document_enrichment_run (document_id, kind, started_at DESC);
