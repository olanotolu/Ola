#!/usr/bin/env node
/**
 * GetLeads → Concya CRM enrichment worker
 * Burns API credits on decision-makers per account, writes contacts back to Supabase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gl from "./lib/client.mjs";
import { dbQuery, dbExec, escSql, escJson } from "./lib/supabase-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREDIT_FLOOR = Number(process.env.GETLEADS_CREDIT_FLOOR || 50);
const MAX_CONTACTS_P0 = Number(process.env.GETLEADS_LIMIT_P0 || 9);
const MAX_CONTACTS_P1 = Number(process.env.GETLEADS_LIMIT_P1 || 8);
const MAX_CONTACTS_P2 = Number(process.env.GETLEADS_LIMIT_P2 || 6);
const DELAY_MS = Number(process.env.GETLEADS_DELAY_MS || 400);
const STATE_FILE = path.join(__dirname, ".enrich-state.json");

function loadEnv() {
  const envPath = path.join(__dirname, ".env.getleads");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashRequest(endpoint, body) {
  const raw = endpoint + JSON.stringify(body);
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return `gl-${(h >>> 0).toString(16)}`;
}

function limitForTier(tier, remaining, accountsLeft) {
  const cap = tier === "P0" ? MAX_CONTACTS_P0 : tier === "P1" ? MAX_CONTACTS_P1 : MAX_CONTACTS_P2;
  const budget = Math.max(1, Math.floor((remaining - CREDIT_FLOOR) / Math.max(accountsLeft, 1)));
  return Math.min(cap, budget, 10);
}

function contactName(c) {
  const parts = [c.first_name, c.last_name].filter(Boolean);
  return parts.join(" ").trim() || c.full_name || "Unknown";
}

function loadProcessedHashes() {
  const rows = dbQuery(`SELECT request_hash FROM crm_enrichment_events WHERE request_hash IS NOT NULL;`);
  return new Set(rows.map((r) => r.request_hash));
}

function loadExistingContactKeys() {
  const rows = dbQuery(`
    SELECT account_id::text AS account_id, email, linkedin_url
    FROM crm_contacts
    WHERE email IS NOT NULL OR linkedin_url IS NOT NULL;
  `);
  const emails = new Set();
  const linkedins = new Set();
  for (const r of rows) {
    if (r.email) emails.add(`${r.account_id}|${r.email.toLowerCase()}`);
    if (r.linkedin_url) linkedins.add(`${r.account_id}|${r.linkedin_url}`);
  }
  return { emails, linkedins };
}

function persistAccountBatch({
  runId,
  account,
  contacts,
  creditsUsed,
  creditsRemaining,
  ok,
  hash,
  error,
  contactKeys,
}) {
  const stmts = [];
  let added = 0;
  const valueRows = [];
  for (const c of contacts) {
    const name = contactName(c);
    const email = c.email_address || c.email || null;
    const phone = c.cellphone || c.phone || null;
    const linkedin = c.person_linkedin_url || c.linkedin_url || null;
    const title = c.job_title || c.title || null;
    const emailKey = email ? `${account.id}|${email.toLowerCase()}` : null;
    const liKey = linkedin ? `${account.id}|${linkedin}` : null;
    if (emailKey && contactKeys.emails.has(emailKey)) continue;
    if (liKey && contactKeys.linkedins.has(liKey)) continue;
    if (emailKey) contactKeys.emails.add(emailKey);
    if (liKey) contactKeys.linkedins.add(liKey);

    valueRows.push(`(
      ${escSql(account.id)}::uuid,
      ${escSql(name)},
      ${escSql(title)},
      ${escSql(linkedin)},
      ${escSql(email)},
      ${escSql(phone)},
      ${escSql(c.email_status || null)},
      ${escSql(c.job_function || null)},
      ${escSql(c.job_level || null)},
      'executive',
      'getleads',
      now(),
      ${escJson(c)}::jsonb
    )`);
    added++;
  }

  if (valueRows.length) {
    stmts.push(`
      DELETE FROM crm_contacts
      WHERE account_id = ${escSql(account.id)}::uuid
        AND (name ILIKE '%leadership%' OR name ILIKE '%team%');
    `);
    stmts.push(`
      INSERT INTO crm_contacts (
        account_id, name, title, linkedin_url, email, phone, email_status,
        job_function, job_level, contact_type, enrichment_provider, enriched_at, source_payload
      ) VALUES ${valueRows.join(",\n")};
    `);
  }

  const first = contacts[0];
  if (first) {
    const domain = first.org_domain || first.email_domain || null;
    stmts.push(`
      UPDATE crm_accounts SET
        org_domain = COALESCE(org_domain, ${escSql(domain)}),
        org_industry = COALESCE(org_industry, ${escSql(first.org_industry_linkedin || null)}),
        employee_count_range = COALESCE(employee_count_range, ${escSql(first.employee_count_range || null)}),
        org_revenue_range = COALESCE(org_revenue_range, ${escSql(first.org_revenue_range || null)}),
        org_about_us = COALESCE(org_about_us, ${escSql(first.org_about_us || null)}),
        getleads_enriched_at = now(),
        updated_at = now()
      WHERE id = ${escSql(account.id)}::uuid;
    `);
  }

  stmts.push(`
    INSERT INTO crm_enrichment_events (run_id, account_id, endpoint, credits_used, contacts_returned, ok, request_hash, error)
    VALUES (
      ${escSql(runId)}::uuid,
      ${escSql(account.id)}::uuid,
      'decision-makers',
      ${creditsUsed},
      ${contacts.length},
      ${ok},
      ${escSql(hash)},
      ${error ? escSql(error) : "NULL"}
    );
  `);

  dbExec(stmts.join("\n"));
  return added;
}

async function fetchDecisionMakers(companyName, limit) {
  return gl.request({
    method: "POST",
    path: "/api/v1/contacts/lookup/decision-makers",
    body: { company_name: companyName, limit },
    useSession: false,
  });
}

async function enrichLinkedInContacts(runId, credits) {
  const rows = dbQuery(`
    SELECT c.id, c.linkedin_url, c.account_id
    FROM crm_contacts c
    WHERE c.linkedin_url IS NOT NULL AND c.linkedin_url <> ''
      AND (c.email IS NULL OR c.phone IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM crm_enrichment_events e
        WHERE e.request_hash = ${escSql("li-enrich")} || c.id::text
      )
    ORDER BY c.enriched_at NULLS FIRST
    LIMIT 500;
  `);

  let used = 0;
  for (const row of rows) {
    if (credits.remaining - used <= CREDIT_FLOOR) break;
    const hash = `li-enrich${row.id}`;
    const result = await gl.request({
      method: "POST",
      path: "/api/v1/enrich/from-linkedin",
      body: { items: [{ linkedin_url: row.linkedin_url }], limit_per_item: 1 },
      useSession: false,
    });
    const creditUsed = result.json?.query_credits_used ?? result.json?.queryCreditsUsed ?? 1;
    used += creditUsed;
    const items = result.json?.results || result.json?.items || result.json?.data || [];
    const hit = Array.isArray(items) ? items[0] : null;
    if (hit && result.status < 300) {
      const email = hit.email_address || hit.email;
      const phone = hit.cellphone || hit.phone;
      dbExec(`
        UPDATE crm_contacts SET
          email = COALESCE(email, ${escSql(email || null)}),
          phone = COALESCE(phone, ${escSql(phone || null)}),
          email_status = COALESCE(email_status, ${escSql(hit.email_status || null)}),
          enrichment_provider = 'getleads',
          enriched_at = now(),
          source_payload = COALESCE(source_payload, '{}'::jsonb) || ${escJson(hit)}::jsonb,
          updated_at = now()
        WHERE id = ${escSql(row.id)}::uuid;
      `);
    }
    dbExec(`
      INSERT INTO crm_enrichment_events (run_id, account_id, endpoint, credits_used, contacts_returned, ok, request_hash, error)
      VALUES (${escSql(runId)}::uuid, ${escSql(row.account_id)}::uuid, 'enrich/from-linkedin', ${creditUsed}, ${hit ? 1 : 0}, ${result.status < 300}, ${escSql(hash)}, ${escSql(result.status >= 300 ? result.json?.message : null)});
    `);
    await sleep(DELAY_MS);
  }
  return used;
}

async function main() {
  loadEnv();
  if (process.env.GETLEADS_API_KEY) gl.setApiKey(process.env.GETLEADS_API_KEY);

  let state = { doneAccountIds: [] };
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      /* fresh */
    }
  }
  const doneSet = new Set(state.doneAccountIds || []);
  const processedHashes = loadProcessedHashes();
  const contactKeys = loadExistingContactKeys();

  const accounts = dbQuery(`
    SELECT id, group_name, tier, market_key, property_count_nyc, property_count_total
    FROM crm_accounts
    ORDER BY
      CASE tier WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
      property_count_nyc DESC NULLS LAST,
      property_count_total DESC NULLS LAST;
  `);

  const runRows = dbExec(`
    INSERT INTO crm_enrichment_runs (provider, status, scope, accounts_total)
    VALUES ('getleads', 'running', '{"mode":"decision-makers-full-crm"}'::jsonb, ${accounts.length})
    RETURNING id;
  `);
  const runId = runRows[0]?.id;
  if (!runId) throw new Error("Failed to create enrichment run");

  console.log(`\n  GetLeads CRM Enrichment`);
  console.log(`  Run: ${runId}`);
  console.log(`  Accounts: ${accounts.length} (${doneSet.size} already done)\n`);

  let totalCredits = 0;
  let totalContacts = 0;
  let accountsDone = doneSet.size;

  const pending = accounts.filter((a) => !doneSet.has(a.id));
  let creditsRemaining = 4977;

  for (let i = 0; i < pending.length; i++) {
    const account = pending[i];
    const accountsLeft = pending.length - i;

  // refresh credits from last response if possible - check health
    if (creditsRemaining <= CREDIT_FLOOR) {
      console.log(`\n  Credit floor reached (${creditsRemaining}). Stopping account pass.`);
      break;
    }

    const limit = limitForTier(account.tier, creditsRemaining, accountsLeft);
    const body = { company_name: account.group_name, limit };
    const hash = hashRequest("decision-makers", body);

    if (processedHashes.has(hash)) {
      doneSet.add(account.id);
      accountsDone++;
      continue;
    }

    process.stdout.write(`  [${accountsDone + 1}/${accounts.length}] ${account.group_name} (limit ${limit})… `);

    let result;
    try {
      result = await fetchDecisionMakers(account.group_name, limit);
    } catch (err) {
      console.log(`ERR ${err.message}`);
      dbExec(`
        INSERT INTO crm_enrichment_events (run_id, account_id, endpoint, credits_used, ok, request_hash, error)
        VALUES (${escSql(runId)}::uuid, ${escSql(account.id)}::uuid, 'decision-makers', 0, false, ${escSql(hash)}, ${escSql(err.message)});
      `);
      await sleep(DELAY_MS * 2);
      continue;
    }

    const creditsUsed = result.json?.query_credits_used ?? result.json?.queryCreditsUsed ?? 0;
    const contacts = result.json?.contacts || [];
    creditsRemaining = result.json?.creditsRemaining ?? creditsRemaining - creditsUsed;
    totalCredits += creditsUsed;

    if (result.status < 300 && contacts.length > 0) {
      const added = persistAccountBatch({
        runId,
        account,
        contacts,
        creditsUsed,
        creditsRemaining,
        ok: true,
        hash,
        error: null,
        contactKeys,
      });
      totalContacts += added;
      console.log(`+${added} contacts (${creditsUsed} cr, ${creditsRemaining} left)`);
    } else {
      const msg = result.json?.message || `HTTP ${result.status}`;
      persistAccountBatch({
        runId,
        account,
        contacts: [],
        creditsUsed,
        creditsRemaining,
        ok: false,
        hash,
        error: msg,
        contactKeys,
      });
      console.log(`skip: ${msg}`);
    }

    processedHashes.add(hash);

    doneSet.add(account.id);
    accountsDone++;
    state.doneAccountIds = [...doneSet];
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    if (accountsDone % 25 === 0 || i === pending.length - 1) {
      dbExec(`
        UPDATE crm_enrichment_runs SET
          accounts_done = ${accountsDone},
          contacts_added = ${totalContacts},
          credits_used = ${totalCredits},
          credits_remaining = ${creditsRemaining}
        WHERE id = ${escSql(runId)}::uuid;
      `);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n  Phase 2: LinkedIn backfill for contacts missing email/phone…`);
  const liCredits = await enrichLinkedInContacts(runId, { remaining: creditsRemaining });
  totalCredits += liCredits;
  creditsRemaining -= liCredits;

  dbExec(`
    UPDATE crm_enrichment_runs SET
      status = 'completed',
      accounts_done = ${accountsDone},
      contacts_added = ${totalContacts},
      credits_used = ${totalCredits},
      credits_remaining = ${creditsRemaining},
      completed_at = now()
    WHERE id = ${escSql(runId)}::uuid;
  `);

  const stats = dbQuery(`
    SELECT
      (SELECT COUNT(*)::int FROM crm_contacts WHERE email IS NOT NULL) AS with_email,
      (SELECT COUNT(*)::int FROM crm_contacts WHERE phone IS NOT NULL) AS with_phone,
      (SELECT COUNT(*)::int FROM crm_contacts) AS total_contacts,
      (SELECT COUNT(*)::int FROM crm_accounts WHERE getleads_enriched_at IS NOT NULL) AS enriched_accounts;
  `);

  console.log(`\n  Done.`);
  console.log(`  Credits used: ~${totalCredits}`);
  console.log(`  Contacts added/updated: ${totalContacts}`);
  console.log(`  Stats:`, stats[0]);
  console.log(`  Run id: ${runId}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
