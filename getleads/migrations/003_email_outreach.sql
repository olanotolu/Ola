-- Email outreach tracking (Resend + Himalaya sync)

CREATE TABLE IF NOT EXISTS crm_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  account_id uuid REFERENCES crm_accounts(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES crm_email_campaigns(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  from_email text,
  subject text NOT NULL,
  body_text text,
  resend_message_id text,
  status text NOT NULL DEFAULT 'queued',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid REFERENCES crm_email_sends(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'resend',
  payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_email_sends_contact_idx ON crm_email_sends (contact_id);
CREATE INDEX IF NOT EXISTS crm_email_sends_account_idx ON crm_email_sends (account_id);
CREATE INDEX IF NOT EXISTS crm_email_sends_resend_id_idx ON crm_email_sends (resend_message_id) WHERE resend_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_email_sends_status_idx ON crm_email_sends (status);
CREATE INDEX IF NOT EXISTS crm_email_events_send_idx ON crm_email_events (send_id);
CREATE INDEX IF NOT EXISTS crm_email_events_type_idx ON crm_email_events (event_type);
CREATE INDEX IF NOT EXISTS crm_email_events_occurred_idx ON crm_email_events (occurred_at DESC);

COMMENT ON TABLE crm_email_sends IS 'Outbound emails via Resend';
COMMENT ON TABLE crm_email_events IS 'Delivery, open, click, bounce, reply events';
