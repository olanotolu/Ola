import { getSupabase } from "./supabase-client.mjs";

const cache = new Map();

function cached(key, fn, ttlMs = 12000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  return fn().then((data) => {
    if (data == null || (Array.isArray(data) && data.length === 0)) {
      cache.delete(key);
    } else {
      cache.set(key, { at: Date.now(), data });
    }
    return data;
  });
}

function tierOrder(tier) {
  if (tier === "P0") return 0;
  if (tier === "P1") return 1;
  return 2;
}

export async function crmStats() {
  return cached("stats", async () => {
    const sb = getSupabase();
    const [
      accounts,
      enriched,
      contacts,
      withEmail,
      withLinkedin,
      gojiberry,
      properties,
      runRes,
    ] = await Promise.all([
      sb.from("crm_accounts").select("*", { count: "exact", head: true }),
      sb.from("crm_accounts").select("*", { count: "exact", head: true }).not("getleads_enriched_at", "is", null),
      sb.from("crm_contacts").select("*", { count: "exact", head: true }),
      sb.from("crm_contacts").select("*", { count: "exact", head: true }).not("email", "is", null).neq("email", ""),
      sb.from("crm_contacts").select("*", { count: "exact", head: true }).not("linkedin_url", "is", null).neq("linkedin_url", ""),
      sb.from("crm_contacts").select("*", { count: "exact", head: true }).not("source_payload->gojiberry", "is", null),
      sb.from("crm_properties").select("*", { count: "exact", head: true }),
      sb
        .from("crm_enrichment_runs")
        .select("id, status, accounts_done, accounts_total, contacts_added, credits_used, credits_remaining, started_at")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    for (const res of [accounts, enriched, contacts, withEmail, withLinkedin, gojiberry, properties]) {
      if (res.error) throw res.error;
    }
    if (runRes.error && runRes.error.code !== "PGRST116") throw runRes.error;

    return {
      accounts_total: accounts.count ?? 0,
      accounts_enriched: enriched.count ?? 0,
      contacts_total: contacts.count ?? 0,
      contacts_with_email: withEmail.count ?? 0,
      contacts_with_linkedin: withLinkedin.count ?? 0,
      gojiberry_contacts: gojiberry.count ?? 0,
      properties_total: properties.count ?? 0,
      run: runRes.data ?? null,
    };
  }, 10000);
}

export async function crmAccounts({ q, tier, market, limit = 100, offset = 0 }) {
  const key = `accounts:${q}:${tier}:${market}:${limit}:${offset}`;
  return cached(key, async () => {
    const sb = getSupabase();
    const lim = Number(limit) || 100;
    const off = Number(offset) || 0;

    let query = sb
      .from("crm_accounts")
      .select(
        "id, group_name, market_name, market_key, tier, mix, stage, property_count_total, property_count_nyc, org_domain, org_industry, employee_count_range, getleads_enriched_at, crm_contacts(count), email_contacts:crm_contacts(count)",
        { count: "exact" },
      );

    if (q?.trim()) query = query.ilike("group_name", `%${q.trim()}%`);
    if (tier) query = query.eq("tier", tier);
    if (market) query = query.eq("market_key", market);

    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) throw error;

    const rows = (data ?? [])
      .map((row) => ({
        id: row.id,
        group_name: row.group_name,
        market_name: row.market_name,
        market_key: row.market_key,
        tier: row.tier,
        mix: row.mix,
        stage: row.stage,
        property_count_total: row.property_count_total,
        property_count_nyc: row.property_count_nyc,
        org_domain: row.org_domain,
        org_industry: row.org_industry,
        employee_count_range: row.employee_count_range,
        getleads_enriched_at: row.getleads_enriched_at,
        contact_count: row.crm_contacts?.[0]?.count ?? 0,
        email_count: row.email_contacts?.[0]?.count ?? 0,
      }))
      .sort((a, b) => {
        const td = tierOrder(a.tier) - tierOrder(b.tier);
        if (td !== 0) return td;
        const nyc = (b.property_count_nyc ?? 0) - (a.property_count_nyc ?? 0);
        if (nyc !== 0) return nyc;
        return String(a.group_name).localeCompare(String(b.group_name));
      });

    return { rows, total: count ?? rows.length };
  }, 12000);
}

export async function crmContacts({ q, hasEmail, hasLinkedIn, source, limit = 200, offset = 0 }) {
  const key = `contacts:${q}:${hasEmail}:${hasLinkedIn}:${source}:${limit}:${offset}`;
  return cached(key, async () => {
    const sb = getSupabase();
    const lim = Number(limit) || 200;
    const off = Number(offset) || 0;

    let query = sb
      .from("crm_contacts")
      .select(
        "id, name, title, email, phone, email_status, linkedin_url, job_level, enriched_at, enrichment_provider, account_id, crm_accounts(id, group_name, market_name, tier)",
        { count: "exact" },
      );

    if (q?.trim()) {
      const term = q.trim().replace(/,/g, "\\,");
      query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%`);
    }
    if (hasEmail === "1") query = query.not("email", "is", null).neq("email", "");
    if (hasLinkedIn === "1") query = query.not("linkedin_url", "is", null).neq("linkedin_url", "");
    if (source === "gojiberry") query = query.not("source_payload->gojiberry", "is", null);

    const { data, error, count } = await query
      .order("enriched_at", { ascending: false, nullsFirst: false })
      .order("name", { ascending: true })
      .range(off, off + lim - 1);

    if (error) throw error;

    const rows = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title,
      email: row.email,
      phone: row.phone,
      email_status: row.email_status,
      linkedin_url: row.linkedin_url,
      job_level: row.job_level,
      enriched_at: row.enriched_at,
      enrichment_provider: row.enrichment_provider,
      account_id: row.account_id,
      group_name: row.crm_accounts?.group_name ?? null,
      market_name: row.crm_accounts?.market_name ?? null,
      tier: row.crm_accounts?.tier ?? null,
    }));

    return { rows, total: count ?? rows.length };
  }, 12000);
}

export async function crmAccountDetail(id) {
  return cached(`account:${id}`, async () => {
    const sb = getSupabase();
    const { data: account, error: accountError } = await sb
      .from("crm_accounts")
      .select(
        "id, group_name, aka, legal_entity, market_name, market_key, tier, mix, stage, property_count_total, property_count_nyc, hq_address, org_domain, org_industry, employee_count_range, org_revenue_range, org_about_us, pos_stack, pms_stack, getleads_enriched_at, estimated_annual_revenue_usd, concya_arr_estimate_usd",
      )
      .eq("id", id)
      .maybeSingle();

    if (accountError) throw accountError;
    if (!account) return null;

    const [contactsRes, propertiesRes] = await Promise.all([
      sb
        .from("crm_contacts")
        .select("id, name, title, email, phone, email_status, linkedin_url, job_level, enriched_at")
        .eq("account_id", id)
        .order("name", { ascending: true }),
      sb
        .from("crm_properties")
        .select("id, name, address, property_type, cuisine_or_brand, neighborhood")
        .eq("account_id", id)
        .order("name", { ascending: true })
        .limit(50),
    ]);

    if (contactsRes.error) throw contactsRes.error;
    if (propertiesRes.error) throw propertiesRes.error;

    const contacts = (contactsRes.data ?? []).sort((a, b) => {
      const ae = a.email ? 0 : 1;
      const be = b.email ? 0 : 1;
      if (ae !== be) return ae - be;
      return String(a.name).localeCompare(String(b.name));
    });

    return { account, contacts, properties: propertiesRes.data ?? [] };
  }, 8000);
}

export async function crmMarkets() {
  return cached("markets", async () => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("crm_accounts")
      .select("market_key, market_name")
      .not("market_key", "is", null)
      .order("market_name", { ascending: true });

    if (error) throw error;

    const seen = new Set();
    return (data ?? []).filter((row) => {
      if (!row.market_key || seen.has(row.market_key)) return false;
      seen.add(row.market_key);
      return true;
    });
  });
}
