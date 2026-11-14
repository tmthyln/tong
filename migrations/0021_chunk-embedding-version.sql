-- Migration number: 0021   2026-11-13

-- Which embedding (model : dimensions : prompt scheme) the chunk's vector in
-- CHUNK_VECTORS was produced with. NULL = unknown / pre-tracking, i.e. stale.
-- The scheduled re-embed sweep picks up every chunk whose version differs from
-- the current EMBEDDING_VERSION.
ALTER TABLE text_chunk ADD COLUMN embedding_version TEXT DEFAULT NULL;
CREATE INDEX idx_text_chunk_embedding_version ON text_chunk (embedding_version);
