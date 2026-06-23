-- Pipeline stages on crm_accounts.stage (text)
-- Values: research, targeted, contacted, connected, meeting, pilot, customer, lost
-- Default for new accounts: research

COMMENT ON COLUMN crm_accounts.stage IS 'Sales pipeline stage for Kanban board';
