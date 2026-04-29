-- Optional cleanup for existing DBs:
-- remove columns from `calls` that are no longer stored.

ALTER TABLE calls DROP COLUMN duration_seconds;
ALTER TABLE calls DROP COLUMN provider_call_id;
ALTER TABLE calls DROP COLUMN direction;
ALTER TABLE calls DROP COLUMN recording_url;
ALTER TABLE calls DROP COLUMN transcript;
