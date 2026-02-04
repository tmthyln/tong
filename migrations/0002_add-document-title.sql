-- Migration number: 0002 	 2026-02-03

-- Add optional title column to document table
ALTER TABLE document ADD COLUMN title TEXT DEFAULT NULL;