-- Run if leads table already exists. Adds columns for Phase 4 Lead Management.
USE ai_agent_voice;

ALTER TABLE leads ADD COLUMN hotel_name VARCHAR(255) AFTER name;
ALTER TABLE leads ADD COLUMN owner_name VARCHAR(255) AFTER hotel_name;
ALTER TABLE leads ADD COLUMN rooms INT AFTER phone;
ALTER TABLE leads ADD COLUMN location VARCHAR(255) AFTER rooms;
