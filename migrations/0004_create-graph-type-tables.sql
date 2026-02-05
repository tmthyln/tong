-- Migration number: 0004 	 2026-02-04

-- Node and edge type definitions for the knowledge graph

CREATE TABLE node_type (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL
);

CREATE TABLE edge_type (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  reverse_name TEXT,
  definition TEXT NOT NULL
);

CREATE TABLE node_type_example (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type_id INTEGER NOT NULL,
  example TEXT NOT NULL,
  FOREIGN KEY (node_type_id) REFERENCES node_type (id) ON DELETE CASCADE
);

CREATE INDEX idx_node_type_example_type ON node_type_example (node_type_id);

CREATE TABLE edge_type_example (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_type_id INTEGER NOT NULL,
  example TEXT NOT NULL,
  FOREIGN KEY (edge_type_id) REFERENCES edge_type (id) ON DELETE CASCADE
);

CREATE INDEX idx_edge_type_example_type ON edge_type_example (edge_type_id);