#!/usr/bin/env node
/**
 * Gojiberry CSV → Concya CRM import + GetLeads enrichment
 * Usage: node getleads/gojiberry-import.mjs [--dry-run] [csv paths...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gl from "./lib/client.mjs";
import { dbQuery, dbExec, escSql, escJson } from "./lib/supabase-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DELAY_MS = Number(process.env.GETLEADS_DELAY_MS || 350);
const CREDIT_FLOOR = Number(process.env.GETLEADS_CREDIT_FLOOR || 100);
const STATE_FILE = path.join(__dirname, ".gojiberry-import-state.json");

const DEFAULT_CSVS = [
  "/Users/term_/Downloads/gojiberry-selected-contacts.csv",
  "/Users/term_/Downloads/gojiberry-selected-contacts (1).csv",
  "/Users/term_/Downloads/gojiberry-selected-contacts (2).csv",
  "/Users/term_/Downloads/gojiberry-selected-contacts (3).csv",
];

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

function normLi(url) {
  if (!url) return "";
  return url.trim().toLowerCase().replace(/\/$/, "").replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "in:");
}

function normCo(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slugify(s) {
  return (s || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function parseIntent(html) {
  const href = html?.match(/href=['"]([^'"]+)['"]/)?.[1] || null;
  const t = html || "";
  let intent_type = "unknown";
  if (/post written by/i.test(t)) intent_type = "author_post";
  else if (/Just engaged/i.test(t)) intent_type = "linkedin_post";
  else if (/Lookalike/i.test(t)) intent_type = "lookalike";
  else if (/Just hired/i.test(t)) intent_type = "just_hired";
  else if (/Top 5%/i.test(t)) intent_type = "top_active";
  return { intent_type, post_url: href };
}

function parseLocation(loc) {
  const parts = (loc || "").split(",").map((p) => p.trim());
  const country = parts.at(-1) || "";
  const region = parts.length >= 3 ? parts[1] : parts.length === 2 ? "" : "";
  const city = parts[0] || "";
  const nyc = /new york|nyc|manhattan|brooklyn|queens/i.test(loc || "");
  const canada = /canada/i.test(country);
  return {
    city,
    region,
    country,
    market_key: nyc ? "nyc" : canada ? "ca" : "us",
    market_name: nyc ? "NYC" : canada ? "Canada" : "US National",
  };
}

function apexDomain(website, company) {
  const w = (website || "").trim();
  if (w) {
    try {
      const host = new URL(w.startsWith("http") ? w : `https://${w}`).hostname.replace(/^www\./, "");
      if (host) return host;
    } catch {
      /* */
    }
  }
  const slug = (company || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.length >= 3 ? `${slug}.com` : null;
}

function tierFor(intent, title) {
  const t = (title || "").toLowerCase();
  const hot = ["just_hired", "linkedin_post", "author_post"].includes(intent);
  const senior = /general manager|director|vp|vice president|chief|head of|owner/.test(t);
  if (hot && senior) return "P1";
  if (hot) return "P1";
  return "P2";
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = vals[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCsvs(paths) {
  const byKey = new Map();
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.warn(`Skip missing: ${p}`);
      continue;
    }
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    for (const row of rows) {
      const li = normLi(row["Profile URL"]);
      const fn = (row["First Name"] || "").trim().toLowerCase();
      const ln = (row["Last Name"] || "").split(",")[0].trim().toLowerCase();
      const co = normCo(row.Company);
      const key = li && !/^in:aco/i.test(li) ? `li:${li}` : `nc:${fn}|${ln}|${co}`;
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function loadCrmIndex() {
  const accounts = dbQuery(`SELECT id, group_name, org_domain, source_key FROM crm_accounts;`);
  const byName = new Map();
  const byDomain = new Map();
  for (const a of accounts) {
    byName.set(normCo(a.group_name), a);
    if (a.org_domain) byDomain.set(a.org_domain.toLowerCase(), a);
  }
  const contacts = dbQuery(`
    SELECT c.id, c.account_id, c.linkedin_url, c.email, c.name
    FROM crm_contacts c;
  `);
  const byLi = new Map();
  for (const c of contacts) {
    const k = normLi(c.linkedin_url);
    if (k) byLi.set(k, c);
  }
  const [{ max_rank }] = dbQuery(`SELECT COALESCE(MAX(rank), 0)::int AS max_rank FROM crm_accounts;`);
  const sourceKeys = new Set(accounts.map((a) => a.source_key));
  return { byName, byDomain, byLi, maxRank: max_rank, sourceKeys };
}

function extractHit(result) {
  const items = result.json?.results || result.json?.items || [];
  const hit = items[0];
  if (!hit) return null;
  const inner = hit.data || hit;
  return {
    email: hit.email || inner.email_address || inner.email || null,
    phone: inner.cellphone || inner.phone || null,
    email_status: inner.email_status || hit.email_status || null,
    raw: hit,
  };
}

async function enrichLinkedIn(url, dryRun) {
  if (dryRun) return { email: null, phone: null, email_status: null, dry_run: true };
  const result = await gl.request({
    method: "POST",
    path: "/api/v1/enrich/from-linkedin",
    body: { items: [{ linkedin_url: url }], limit_per_item: 1 },
    useSession: false,
  });
  return extractHit(result);
}

async function enrichPerson(first, last, company, domain, dryRun) {
  if (dryRun) return null;
  const result = await gl.request({
    method: "POST",
    path: "/api/v1/enrich/from-person",
    body: {
      items: [{ first_name: first, last_name: last, company_name: company, company_domain: domain }],
    },
    useSession: false,
  });
  return extractHit(result);
}

function findAccount(row, idx, rankRef, dryRun) {
  const company = (row.Company || "").trim();
  const domain = apexDomain(row.Website, company);
  let account = idx.byName.get(normCo(company));
  if (!account && domain) account = idx.byDomain.get(domain.toLowerCase());
  if (account) return { account, created: false };

  if (dryRun) {
    return {
      account: { id: "dry-run", group_name: company, org_domain: domain, source_key: `gojiberry:${slugify(company)}` },
      created: true,
    };
  }

  let sk = `gojiberry:${slugify(company)}`;
  let n = 1;
  while (idx.sourceKeys.has(sk)) {
    sk = `gojiberry:${slugify(company)}-${n++}`;
  }
  idx.sourceKeys.add(sk);
  rankRef.value += 1;
  const loc = parseLocation(row.Location);
  const intent = parseIntent(row.Intent);
  const mix = /restaurant|food/i.test(row.Industry || "") ? "F&B" : "Lodging";

  const [inserted] = dbQuery(`
    INSERT INTO crm_accounts (
      source_key, rank, group_name, market_key, market_name, mix, tier, stage,
      discovery_vector, org_domain, property_count_total, property_count_nyc
    ) VALUES (
      ${escSql(sk)},
      ${rankRef.value},
      ${escSql(company)},
      ${escSql(loc.market_key)},
      ${escSql(loc.market_name)},
      ${escSql(mix)},
      ${escSql(tierFor(intent.intent_type, row["Job Title"]))},
      'research',
      'gojiberry',
      ${escSql(domain)},
      1,
      ${loc.market_key === "nyc" ? 1 : 0}
    )
    RETURNING id, group_name, org_domain, source_key;
  `);
  idx.byName.set(normCo(company), inserted);
  if (domain) idx.byDomain.set(domain.toLowerCase(), inserted);
  return { account: inserted, created: true };
}

async function main() {
  loadEnv();
  if (process.env.GETLEADS_API_KEY) gl.setApiKey(process.env.GETLEADS_API_KEY);

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const csvPaths = args.filter((a) => !a.startsWith("--"));
  const paths = csvPaths.length ? csvPaths : DEFAULT_CSVS;

  let state = { processedKeys: [] };
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      /* */
    }
  }
  const done = new Set(state.processedKeys || []);

  const leads = loadCsvs(paths);
  const idx = loadCrmIndex();
  const rankRef = { value: idx.maxRank };

  const report = {
    total_unique: leads.length,
    already_in_crm: 0,
    accounts_created: 0,
    contacts_added: 0,
    contacts_updated: 0,
    enriched: 0,
    skipped_done: 0,
    no_contactability: 0,
    credits_used: 0,
    errors: [],
  };

  console.log(`\nGojiberry → CRM import (${leads.length} unique leads, dry_run=${dryRun})\n`);

  for (const row of leads) {
    const li = (row["Profile URL"] || "").trim();
    const liKey = normLi(li);
    const fn = (row["First Name"] || "").trim();
    const lnRaw = row["Last Name"] || "";
    const ln = lnRaw.split(",")[0].trim();
    const name = `${fn} ${ln}`.trim();
    const intent = parseIntent(row.Intent);
    const rowKey = liKey || `${normCo(row.Company)}|${fn}|${ln}`.toLowerCase();

    if (done.has(rowKey)) {
      report.skipped_done++;
      continue;
    }

    try {
      const existingContact = liKey ? idx.byLi.get(liKey) : null;
      if (existingContact) report.already_in_crm++;

      const { account, created } = findAccount(row, idx, rankRef, dryRun);
      if (created) report.accounts_created++;

      let email = (row.Email || "").trim() || null;
      let phone = (row.Phone || "").trim() || null;
      let email_status = null;
      const vanity = li && !/\/in\/(ACo|ACW)/i.test(li);

      if (dryRun) {
        if (existingContact) {
          /* counted */
        } else {
          report.contacts_added++;
          if (!email && !vanity) report.no_contactability++;
        }
        done.add(rowKey);
        continue;
      }

      if (!email && vanity) {
        const hit = await enrichLinkedIn(li, false);
        await sleep(DELAY_MS);
        if (hit?.email) {
          email = hit.email;
          phone = phone || hit.phone;
          email_status = hit.email_status;
          report.enriched++;
          report.credits_used++;
        }
      } else if (!email) {
        const domain = apexDomain(row.Website, row.Company);
        const hit = await enrichPerson(fn, ln, row.Company, domain, false);
        await sleep(DELAY_MS);
        if (hit?.email) {
          email = hit.email;
          phone = phone || hit.phone;
          email_status = hit.email_status;
          report.enriched++;
          report.credits_used++;
        }
      }

      const payload = {
        source: "gojiberry",
        intent_type: intent.intent_type,
        intent_raw: row.Intent,
        post_url: intent.post_url,
        intent_keyword: (row["Intent Keyword"] || "").replace(/"/g, "").trim(),
        gojiberry_score: row["Total Score"],
        import_date: row["Import Date"],
        location: row.Location,
      };

      if (existingContact) {
        dbExec(`
          UPDATE crm_contacts SET
            title = COALESCE(NULLIF(${escSql(row["Job Title"])}, ''), title),
            email = COALESCE(email, ${escSql(email)}),
            phone = COALESCE(phone, ${escSql(phone)}),
            email_status = COALESCE(email_status, ${escSql(email_status)}),
            linkedin_url = COALESCE(linkedin_url, ${escSql(li || null)}),
            enrichment_provider = COALESCE(enrichment_provider, 'getleads'),
            enriched_at = COALESCE(enriched_at, now()),
            source_payload = source_payload || ${escJson({ gojiberry: payload })}::jsonb,
            updated_at = now()
          WHERE id = ${escSql(existingContact.id)}::uuid;
        `);
        report.contacts_updated++;
      } else {
        dbExec(`
          INSERT INTO crm_contacts (
            account_id, name, title, linkedin_url, email, phone, email_status,
            contact_type, enrichment_provider, enriched_at, source_payload
          ) VALUES (
            ${escSql(account.id)}::uuid,
            ${escSql(name)},
            ${escSql(row["Job Title"] || null)},
            ${escSql(li || null)},
            ${escSql(email)},
            ${escSql(phone)},
            ${escSql(email_status)},
            'executive',
            ${email ? "'getleads'" : "NULL"},
            ${email ? "now()" : "NULL"},
            ${escJson({ gojiberry: payload })}::jsonb
          );
        `);
        if (liKey) idx.byLi.set(liKey, { account_id: account.id, linkedin_url: li });
        report.contacts_added++;
        if (!email && !vanity) report.no_contactability++;
      }

      done.add(rowKey);
    } catch (err) {
      report.errors.push({ name, error: err.message });
    }
  }

  state.processedKeys = [...done];
  if (!dryRun) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const outPath = path.join(__dirname, ".gojiberry-import-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("─── Report ───");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
