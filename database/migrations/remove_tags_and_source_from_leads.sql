-- Optional: run on existing databases that still have `tags` / `source` on `leads`.
-- New installs from schema.sql do not create these columns.

ALTER TABLE leads DROP COLUMN tags;
ALTER TABLE leads DROP COLUMN source;
