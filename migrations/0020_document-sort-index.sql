-- Migration number: 0020   2026-11-11

-- Explicit reading order for documents within a folder (e.g. the chapters of
-- a book imported from Project Gutenberg, whose titles — 第一回, 第十回, … — do
-- not sort correctly as text). NULL means "no explicit order": such documents
-- sort after ordered ones, by title.
ALTER TABLE document ADD COLUMN sort_index INTEGER DEFAULT NULL;
