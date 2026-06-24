-- Explee / external company directory (separate from crm_accounts Operators pipeline)

CREATE TABLE IF NOT EXISTS crm_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_domain text NOT NULL,
  name text NOT NULL,
  website text,
  linkedin_url text,
  linkedin_id bigint,
  industry text,
  description text,
  company_size text,
  employee_count_us int,
  employee_count_total int,
  geo_country text,
  geo_state text,
  geo_city text,
  hiring boolean NOT NULL DEFAULT false,
  primary_email text,
  all_emails text[] DEFAULT '{}',
  has_email boolean NOT NULL DEFAULT false,
  traffic text,
  traffic_growth text,
  domain_alive_score numeric,
  source text NOT NULL DEFAULT 'explee',
  imported_at timestamptz NOT NULL DEFAULT now(),
  source_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_domain)
);

CREATE INDEX IF NOT EXISTS crm_companies_domain_idx ON crm_companies (company_domain);
CREATE INDEX IF NOT EXISTS crm_companies_state_idx ON crm_companies (geo_state) WHERE geo_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_companies_hiring_idx ON crm_companies (hiring) WHERE hiring = true;
CREATE INDEX IF NOT EXISTS crm_companies_has_email_idx ON crm_companies (has_email) WHERE has_email = true;
CREATE INDEX IF NOT EXISTS crm_companies_industry_idx ON crm_companies (industry) WHERE industry IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_companies_name_idx ON crm_companies (name);
CREATE INDEX IF NOT EXISTS crm_companies_imported_idx ON crm_companies (imported_at DESC);

COMMENT ON TABLE crm_companies IS 'Imported company directory (Explee hospitality list), separate from Operators pipeline';
