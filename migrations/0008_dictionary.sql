-- Migration number: 0008 	 2026-03-14

-- Dictionary entries and definitions

CREATE TABLE dictionary_entry (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  traditional       TEXT NOT NULL,
  simplified        TEXT NOT NULL,
  pinyin            TEXT NOT NULL,
  source            TEXT NOT NULL,
  -- Updated to the current refresh epoch for every entry seen, even if content is unchanged.
  -- Used by the finalize step to identify entries that disappeared from the source.
  last_seen_epoch   INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (traditional, simplified, pinyin, source)
);

CREATE INDEX idx_dictionary_entry_simplified  ON dictionary_entry (simplified);
CREATE INDEX idx_dictionary_entry_traditional ON dictionary_entry (traditional);
CREATE INDEX idx_dictionary_entry_source      ON dictionary_entry (source);

-- Definitions are stored as ordered rows rather than a JSON array
-- to allow individual querying and future annotation
CREATE TABLE dictionary_definition (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL,
  definition TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (entry_id) REFERENCES dictionary_entry (id) ON DELETE CASCADE
);

CREATE INDEX idx_dictionary_definition_entry ON dictionary_definition (entry_id);

-- FTS5 index for searching headwords and definitions.
-- Maintained by client code in parallel with the above tables.
-- unicode61 tokenizer handles CJK characters correctly.
CREATE VIRTUAL TABLE dictionary_fts USING fts5(
  simplified,
  traditional,
  pinyin,
  definitions_text,
  tokenize='unicode61'
);

-- Tracks CEDICT refresh jobs for progress reporting
CREATE TABLE dictionary_refresh_job (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
  total_entries     INTEGER,
  processed_entries INTEGER NOT NULL DEFAULT 0,
  epoch             INTEGER,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  error             TEXT
);
