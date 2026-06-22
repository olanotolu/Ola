import { dbQuery, escSql } from "./supabase-cli.mjs";

const cache = new Map();

function cached(key, fn, ttlMs = 12000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = fn();
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    cache.delete(key);
  } else {
    cache.set(key, { at: Date.now(), data });
  }
  return data;
}

function likeFilter(column, q) {
  if (!q?.trim()) return "";
  const safe = q.trim().replace(/'/g, "''");
  return ` AND ${column} ILIKE '%${safe}%' `;
}

export function crmStats() {
  return cached("stats", () => {
    const [row] = dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM crm_accounts) AS accounts_total,
        (SELECT COUNT(*)::int FROM crm_accounts WHERE getleads_enriched_at IS NOT NULL) AS accounts_enriched,
        (SELECT COUNT(*)::int FROM crm_contacts) AS contacts_total,
        (SELECT COUNT(*)::int FROM crm_contacts WHERE email IS NOT NULL AND email <> '') AS contacts_with_email,
        (SELECT COUNT(*)::int FROM crm_contacts WHERE linkedin_url IS NOT NULL AND linkedin_url <> '') AS contacts_with_linkedin,
        (SELECT COUNT(*)::int FROM crm_contacts WHERE source_payload::text LIKE '%gojiberry%') AS gojiberry_contacts,
        (SELECT COUNT(*)::int FROM crm_properties) AS properties_total;
    `);
    const [run] = dbQuery(`
      SELECT id, status, accounts_done, accounts_total, contacts_added, credits_used, credits_remaining, started_at
      FROM crm_enrichment_runs ORDER BY started_at DESC LIMIT 1;
    `);
    return { ...row, run: run || null };
  }, 10000);
}

export function crmAccounts({ q, tier, market, limit = 100, offset = 0 }) {
  const key = `accounts:${q}:${tier}:${market}:${limit}:${offset}`;
  return cached(key, () => {
    let where = "WHERE 1=1";
    where += likeFilter("group_name", q);
    if (tier) where += ` AND tier = ${escSql(tier)} `;
    if (market) where += ` AND market_key = ${escSql(market)} `;
    const rows = dbQuery(`
      SELECT id, group_name, market_name, market_key, tier, mix, stage,
        property_count_total, property_count_nyc, org_domain, org_industry,
        employee_count_range, getleads_enriched_at,
        (SELECT COUNT(*)::int FROM crm_contacts c WHERE c.account_id = crm_accounts.id) AS contact_count,
        (SELECT COUNT(*)::int FROM crm_contacts c WHERE c.account_id = crm_accounts.id AND c.email IS NOT NULL) AS email_count
      FROM crm_accounts
      ${where}
      ORDER BY
        CASE tier WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
        property_count_nyc DESC NULLS LAST,
        group_name
      LIMIT ${Number(limit) || 100} OFFSET ${Number(offset) || 0};
    `);
    const countRows = dbQuery(`SELECT COUNT(*)::int AS total FROM crm_accounts ${where};`);
    const total = countRows[0]?.total ?? rows.length;
    return { rows, total };
  }, 12000);
}

export function crmContacts({ q, hasEmail, hasLinkedIn, source, limit = 200, offset = 0 }) {
  const key = `contacts:${q}:${hasEmail}:${hasLinkedIn}:${source}:${limit}:${offset}`;
  return cached(key, () => {
    let where = "WHERE 1=1";
    if (q?.trim()) {
      const safe = q.trim().replace(/'/g, "''");
      where += ` AND (c.name ILIKE '%${safe}%' OR c.email ILIKE '%${safe}%' OR a.group_name ILIKE '%${safe}%') `;
    }
    if (hasEmail === "1") where += ` AND c.email IS NOT NULL AND c.email <> '' `;
    if (hasLinkedIn === "1") where += ` AND c.linkedin_url IS NOT NULL AND c.linkedin_url <> '' `;
    if (source === "gojiberry") where += ` AND c.source_payload::text LIKE '%gojiberry%' `;
    const rows = dbQuery(`
      SELECT c.id, c.name, c.title, c.email, c.phone, c.email_status, c.linkedin_url,
        c.job_level, c.enriched_at, c.enrichment_provider,
        a.id AS account_id, a.group_name, a.market_name, a.tier
      FROM crm_contacts c
      JOIN crm_accounts a ON a.id = c.account_id
      ${where}
      ORDER BY c.enriched_at DESC NULLS LAST, c.name
      LIMIT ${Number(limit) || 200} OFFSET ${Number(offset) || 0};
    `);
    const countRows = dbQuery(`
      SELECT COUNT(*)::int AS total FROM crm_contacts c
      JOIN crm_accounts a ON a.id = c.account_id ${where};
    `);
    const total = countRows[0]?.total ?? rows.length;
    return { rows, total };
  }, 12000);
}

export function crmAccountDetail(id) {
  return cached(`account:${id}`, () => {
    const [account] = dbQuery(`
      SELECT id, group_name, aka, legal_entity, market_name, market_key, tier, mix, stage,
        property_count_total, property_count_nyc, hq_address, org_domain, org_industry,
        employee_count_range, org_revenue_range, org_about_us, pos_stack, pms_stack,
        getleads_enriched_at, estimated_annual_revenue_usd, concya_arr_estimate_usd
      FROM crm_accounts WHERE id = ${escSql(id)}::uuid;
    `);
    if (!account) return null;
    const contacts = dbQuery(`
      SELECT id, name, title, email, phone, email_status, linkedin_url, job_level, enriched_at
      FROM crm_contacts WHERE account_id = ${escSql(id)}::uuid
      ORDER BY CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END, name;
    `);
    const properties = dbQuery(`
      SELECT id, name, address, property_type, cuisine_or_brand, neighborhood
      FROM crm_properties WHERE account_id = ${escSql(id)}::uuid
      ORDER BY name LIMIT 50;
    `);
    return { account, contacts, properties };
  }, 8000);
}

export function crmMarkets() {
  return cached("markets", () =>
    dbQuery(`SELECT DISTINCT market_key, market_name FROM crm_accounts ORDER BY market_name;`),
  );
}
