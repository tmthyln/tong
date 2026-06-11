-- Versioned node_type and edge_type definitions.
-- Each edit becomes a new row with the same name and an incremented version;
-- the current row is identified by is_current = 1. Examples move inline as JSON
-- so the entire definition state for a version lives in a single row.
-- Names are immutable across versions.

CREATE TABLE node_type_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  examples_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1,
  date_created TEXT NOT NULL,
  UNIQUE (name, version)
);

INSERT INTO node_type_new (id, name, definition, examples_json, version, is_current, date_created)
SELECT
  nt.id, nt.name, nt.definition,
  COALESCE(
    (SELECT json_group_array(example) FROM node_type_example WHERE node_type_id = nt.id),
    '[]'
  ),
  1, 1, datetime('now')
FROM node_type nt;

DROP TABLE node_type_example;
DROP TABLE node_type;
ALTER TABLE node_type_new RENAME TO node_type;

CREATE INDEX idx_node_type_current ON node_type(name) WHERE is_current = 1;

CREATE TABLE edge_type_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  reverse_name TEXT,
  definition TEXT NOT NULL,
  examples_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1,
  date_created TEXT NOT NULL,
  UNIQUE (name, version)
);

INSERT INTO edge_type_new (id, name, reverse_name, definition, examples_json, version, is_current, date_created)
SELECT
  et.id, et.name, et.reverse_name, et.definition,
  COALESCE(
    (SELECT json_group_array(example) FROM edge_type_example WHERE edge_type_id = et.id),
    '[]'
  ),
  1, 1, datetime('now')
FROM edge_type et;

DROP TABLE edge_type_example;
DROP TABLE edge_type;
ALTER TABLE edge_type_new RENAME TO edge_type;

CREATE INDEX idx_edge_type_current ON edge_type(name) WHERE is_current = 1;
