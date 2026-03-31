-- Migration number: 0014   2026-03-30

-- One row per (character × decomposition variant).
-- Atomic chars: one row with ids_string=NULL, root_node_id points to a 'char' node.
-- Non-atomic chars: one row per IDS variant; root_node_id points to the root 'op' node.
-- Obsolete variants (obsolete=1): stored for reference, excluded from structural graph.
CREATE TABLE char_ids (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codepoint    TEXT NOT NULL,    -- e.g. "U+4E01" (not unique: multiple variants per char)
  character    TEXT NOT NULL,
  ids_string   TEXT,             -- NULL for atomic chars
  tags         TEXT,             -- e.g. "GTKV", null = untagged/all regions
  obsolete     INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER           -- NULL for obsolete entries; otherwise set
);
CREATE INDEX char_ids_character ON char_ids(character) WHERE obsolete = 0;
CREATE INDEX char_ids_root_node ON char_ids(root_node_id);

-- Shared DAG node pool. No FK constraints: nodes are shared and can't cascade cleanly.
CREATE TABLE char_ids_node (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type    TEXT NOT NULL CHECK(node_type IN ('op', 'char', 'unencoded')),
  operator     TEXT,         -- if type='op': IDS operator character
  character    TEXT,         -- if type='char': the character value (atomic chars only)
  stroke_count INTEGER       -- if type='unencoded': 1–20
);
CREATE INDEX char_ids_node_char ON char_ids_node(character);

-- DAG edges. Multiple edges at the same (parent, position) are allowed:
-- one per decomposition variant when a referenced component has multiple variants.
CREATE TABLE char_ids_node_link (
  parent_id INTEGER NOT NULL,
  child_id  INTEGER NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (parent_id, child_id, position)
);
CREATE INDEX char_ids_node_link_parent ON char_ids_node_link(parent_id, position);
CREATE INDEX char_ids_node_link_child  ON char_ids_node_link(child_id);

CREATE TABLE char_ids_refresh_job (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'running',
  total_chars     INTEGER,
  processed_chars INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error           TEXT
);
