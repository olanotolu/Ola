#!/usr/bin/env node
/**
 * Export prioritized LinkedIn connection queue from Concya CRM.
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node getleads/export-connection-queue.mjs [--limit 200]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase } from "./lib/supabase-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const limitArg = process.argv.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? Number(limitArg.split("=")[1] || process.argv[process.argv.indexOf("--limit") + 1]) : 200;

const INTENT_SCORE = {
  just_hired: 100,
  top_active: 80,
  linkedin_post: 70,
  author_post: 65,
  lookalike: 40,
};

function escCsv(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function connectionNote(row) {
  const first = row.name?.split(/\s+/)[0] || "there";
  if (row.intent_type === "just_hired") {
    return `Hi ${first} — congrats on the new role at ${row.company}. I work on voice AI for restaurants/hospitality (Concya). Would love to connect.`;
  }
  if (row.intent_type === "top_active") {
    return `Hi ${first} — saw you're active in hospitality ops. I'm building Concya (voice AI for restaurants). Would love to connect and learn from your perspective.`;
  }
  if (row.intent_type === "linkedin_post" || row.intent_type === "author_post") {
    return `Hi ${first} — enjoyed your LinkedIn activity in hospitality. I'm at Concya (voice AI for restaurants). Would love to connect.`;
  }
  return `Hi ${first} — I'm building Concya (voice AI for restaurants/hospitality). Would love to connect given your work at ${row.company}.`;
}

const sb = getSupabase();
const PAGE = 1000;
const all = [];
let from = 0;

while (true) {
  const { data, error } = await sb
    .from("crm_contacts")
    .select(
      "id, name, title, email, phone, linkedin_url, job_level, enriched_at, source_payload, crm_accounts(group_name, market_name, tier, org_domain, org_industry)",
    )
    .not("linkedin_url", "is", null)
    .neq("linkedin_url", "")
    .range(from, from + PAGE - 1);

  if (error) throw error;
  if (!data?.length) break;
  all.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}

const rows = all.map((c) => {
  const a = c.crm_accounts || {};
  const g = c.source_payload?.gojiberry || null;
  const hasEmail = Boolean(c.email?.trim());
  const intentType = g?.intent_type || "";
  const score = Number(g?.gojiberry_score || 0);
  const priority =
    (INTENT_SCORE[intentType] || 0) +
    score * 5 +
    (g ? 30 : 0) +
    (hasEmail ? 0 : 20) +
    (a.tier === "P0" ? 25 : a.tier === "P1" ? 15 : 0);

  const row = {
    priority: Math.round(priority),
    name: c.name,
    title: c.title || "",
    company: a.group_name || "",
    market: a.market_name || "",
    tier: a.tier || "",
    industry: a.org_industry || "",
    domain: a.org_domain || "",
    linkedin_url: c.linkedin_url,
    has_email: hasEmail ? "yes" : "no",
    email: c.email || "",
    phone: c.phone || "",
    source: g ? "gojiberry" : "crm",
    intent_type: intentType,
    intent_raw: g?.intent_raw || "",
    gojiberry_score: g?.gojiberry_score || "",
    location: g?.location || "",
    status: "pending",
    connected_at: "",
    notes: "",
    suggested_note: "",
  };
  row.suggested_note = connectionNote(row);
  return row;
});

rows.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

const top = rows.slice(0, LIMIT);
const gojiberryLinkedinOnly = rows.filter((r) => r.source === "gojiberry" && r.has_email === "no");

mkdirSync(OUT, { recursive: true });

const headers = Object.keys(top[0] || rows[0]);
const csv = [headers.join(",")].concat(top.map((r) => headers.map((h) => escCsv(r[h])).join(","))).join("\n");

const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(OUT, `connection-queue-top${LIMIT}.csv`), csv);
writeFileSync(
  path.join(OUT, `connection-queue-top${LIMIT}.json`),
  JSON.stringify({ generated_at: new Date().toISOString(), total_with_linkedin: rows.length, queue: top }, null, 2),
);
writeFileSync(
  path.join(OUT, "connection-queue-gojiberry-linkedin-only.json"),
  JSON.stringify(
    { generated_at: new Date().toISOString(), total: gojiberryLinkedinOnly.length, queue: gojiberryLinkedinOnly },
    null,
    2,
  ),
);

const byIntent = {};
for (const r of rows.filter((x) => x.source === "gojiberry")) {
  byIntent[r.intent_type || "unknown"] = (byIntent[r.intent_type || "unknown"] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      files: [
        `getleads/output/connection-queue-top${LIMIT}.csv`,
        `getleads/output/connection-queue-top${LIMIT}.json`,
        "getleads/output/connection-queue-gojiberry-linkedin-only.json",
      ],
      total_with_linkedin: rows.length,
      gojiberry_total: rows.filter((r) => r.source === "gojiberry").length,
      gojiberry_linkedin_only: gojiberryLinkedinOnly.length,
      gojiberry_by_intent: byIntent,
      exported: top.length,
      top5: top.slice(0, 5).map((r) => ({
        name: r.name,
        company: r.company,
        priority: r.priority,
        intent_type: r.intent_type,
        linkedin_url: r.linkedin_url,
      })),
    },
    null,
    2,
  ),
);
