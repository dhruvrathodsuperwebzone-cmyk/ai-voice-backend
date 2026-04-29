-- Optional: run on existing databases that still have hotel_id columns.
-- Constraint names may differ; check with:
--   SHOW CREATE TABLE leads;
--   SHOW CREATE TABLE campaigns;

-- Example for leads (replace fk_leads_hotel_id with your actual FK name):
-- ALTER TABLE leads DROP FOREIGN KEY fk_leads_hotel_id;
-- ALTER TABLE leads DROP COLUMN hotel_id;

-- Example for campaigns:
-- ALTER TABLE campaigns DROP FOREIGN KEY fk_campaigns_hotel_id;
-- ALTER TABLE campaigns DROP COLUMN hotel_id;
