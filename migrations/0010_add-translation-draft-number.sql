-- Migration number: 0010 	 2026-03-15

ALTER TABLE translation_chunk ADD COLUMN draft_number INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_translation_chunk_draft ON translation_chunk (text_chunk_id, draft_number);
