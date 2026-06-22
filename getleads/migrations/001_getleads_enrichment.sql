-- GetLeads CRM enrichment support
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS email_status text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS job_function text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS job_level text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS enrichment_provider text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS org_domain text;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS org_industry text;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS employee_count_range text;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS org_revenue_range text;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS org_about_us text;
ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS getleads_enriched_at timestamptz;

CREATE TABLE IF NOT EXISTS crm_enrichment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'getleads',
  status text NOT NULL DEFAULT 'running',
  scope jsonb,
  accounts_total int,
  accounts_done int DEFAULT 0,
  contacts_added int DEFAULT 0,
  credits_used int DEFAULT 0,
  credits_remaining int,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_enrichment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES crm_enrichment_runs(id) ON DELETE CASCADE,
  account_id uuid REFERENCES crm_accounts(id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  credits_used int DEFAULT 0,
  contacts_returned int DEFAULT 0,
  ok boolean NOT NULL DEFAULT true,
  request_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_enrichment_events_request_hash_idx
  ON crm_enrichment_events (request_hash) WHERE request_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_contacts_email_idx ON crm_contacts (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_contacts_account_email_idx ON crm_contacts (account_id, email);
