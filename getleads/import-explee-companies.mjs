#!/usr/bin/env node
/**
 * Import Explee companies CSV → crm_companies
 * Usage: node import-explee-companies.mjs [path/to/explee_companies.csv]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase } from "./lib/supabase-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT =
  process.argv[2] || path.join(process.env.HOME, "Downloads/explee_companies_2026-06-24.csv");
const BATCH = 150;

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env.getleads");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseCsvText(text) {
  const rows = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQ = !inQ;
      cur += ch;
      continue;
    }
    if (ch === "\n" && !inQ) {
      if (cur.trim()) rows.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) rows.push(cur);
  return rows;
}

function parseRow(line) {
  const out = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      q = !q;
      f += ch;
      continue;
    }
    if (ch === "," && !q) {
      out.push(f);
      f = "";
      continue;
    }
    f += ch;
  }
  out.push(f);
  return out.map((x) => x.replace(/^"|"$/g, "").replace(/""/g, '"'));
}

function stateName(code) {
  if (!code) return "";
  const m = String(code).match(/^US-([A-Z]{2})$/i);
  return m ? m[1].toUpperCase() : String(code).toUpperCase();
}

function titleCaseCity(s) {
  if (!s) return "";
  return s
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function normalizeWebsite(url, domain) {
  if (url && /^https?:\/\//i.test(url)) return url.replace(/\/$/, "");
  if (domain) return `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return null;
}

function firstLinkedIn(raw) {
  if (!raw) return null;
  const url = raw.split(";")[0].trim();
  return /linkedin\.com/i.test(url) ? url : null;
}

function parseEmails(allEmails, primary) {
  const list = (allEmails || "")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  if (primary && !list.includes(primary)) list.unshift(primary);
  return [...new Set(list)];
}

function toInt(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function rowToRecord(cols, header) {
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (k) => cols[idx[k]] ?? "";

  const domain = get("company_domain").trim().toLowerCase();
  if (!domain) return null;

  const name = get("company_name").trim();
  if (!name) return null;

  const primaryEmail = get("primary_email").trim() || null;
  const allEmails = parseEmails(get("all_emails"), primaryEmail);
  const linkedin = firstLinkedIn(get("linkedin_social"));

  const structured = {
    company_domain: domain,
    name,
    website: normalizeWebsite(get("company_url"), domain),
    linkedin_url: linkedin,
    linkedin_id: toInt(get("company_linkedin_id")),
    industry: get("industry").trim() || null,
    description: get("description").trim() || null,
    company_size: get("company_size").trim() || null,
    employee_count_us: toInt(get("employee_count_us")),
    employee_count_total: toInt(get("employee_count_total")),
    geo_country: get("geo_country").trim() || "US",
    geo_state: stateName(get("geo_state")),
    geo_city: titleCaseCity(get("geo_city")),
    hiring: get("hiring") === "yes",
    primary_email: primaryEmail,
    all_emails: allEmails,
    has_email: allEmails.length > 0,
    traffic: get("traffic").trim() || null,
    traffic_growth: get("traffic_growth").trim() || null,
    domain_alive_score: toNum(get("domain_alive_score")),
    source: "explee",
    imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const source_payload = {};
  for (const h of header) {
    if (h === "company_name") source_payload.company_name = get(h);
    else source_payload[h] = get(h);
  }

  return { ...structured, source_payload };
}

loadEnvFile();

if (!fs.existsSync(INPUT)) {
  console.error(`File not found: ${INPUT}`);
  process.exit(1);
}

console.log(`Reading ${INPUT}...`);
const lines = parseCsvText(fs.readFileSync(INPUT, "utf8"));
const header = parseRow(lines[0]);
const records = [];
let skipped = 0;

for (const line of lines.slice(1)) {
  const rec = rowToRecord(parseRow(line), header);
  if (!rec) {
    skipped++;
    continue;
  }
  records.push(rec);
}

console.log(`Parsed ${records.length} companies (${skipped} skipped)`);

const sb = getSupabase();
let inserted = 0;
let updated = 0;
let errors = 0;

for (let i = 0; i < records.length; i += BATCH) {
  const batch = records.slice(i, i + BATCH);
  const { data, error } = await sb
    .from("crm_companies")
    .upsert(batch, { onConflict: "company_domain" })
    .select("id, created_at, updated_at");

  if (error) {
    console.error(`Batch ${i / BATCH + 1} failed:`, error.message);
    errors += batch.length;
    continue;
  }

  for (const row of data || []) {
    if (row.created_at === row.updated_at) inserted++;
    else updated++;
  }
  process.stdout.write(`\r  ${Math.min(i + BATCH, records.length)} / ${records.length}`);
}

console.log(`\n\nDone. Upserted: ${records.length - errors} | Errors: ${errors}`);
const { count } = await sb.from("crm_companies").select("*", { count: "exact", head: true });
console.log(`crm_companies total: ${count}`);
