#!/usr/bin/env node
/**
 * Health check for local CRM + Supabase connection.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useSupabaseHttp } from "./lib/supabase-client.mjs";
import * as crm from "./lib/crm-api-async.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env.getleads");

function loadEnvFile() {
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

loadEnvFile();

const checks = [];

function fail(msg, fix) {
  checks.push({ ok: false, msg, fix });
}

function pass(msg) {
  checks.push({ ok: true, msg });
}

if (!fs.existsSync(envPath)) {
  fail("Missing getleads/.env.getleads", "cp getleads/.env.getleads.example getleads/.env.getleads and fill in values");
} else {
  pass("Found getleads/.env.getleads");
}

if (!useSupabaseHttp()) {
  fail(
    "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set",
    "Add both to getleads/.env.getleads (see .env.getleads.example). Get keys: supabase projects api-keys --project-ref azixopwjtkhkvbnslygd",
  );
} else {
  pass("Supabase env vars present");
}

if (useSupabaseHttp()) {
  try {
    const stats = await crm.crmStats();
    if ((stats.contacts_total ?? 0) > 0) {
      pass(`Supabase connected — ${stats.contacts_total} contacts, ${stats.accounts_total} accounts`);
    } else {
      fail("Supabase connected but no contacts returned", "Check project ref and service role key");
    }
  } catch (err) {
    fail(`Supabase query failed: ${err.message}`, "Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
}

if (!process.env.RESEND_API_KEY) {
  checks.push({
    ok: null,
    msg: "RESEND_API_KEY not set (optional until sending email)",
    fix: "Add RESEND_API_KEY to getleads/.env.getleads when ready",
  });
} else {
  pass("RESEND_API_KEY present");
}

try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("himalaya", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  pass("Himalaya CLI installed");
} catch {
  checks.push({
    ok: null,
    msg: "Himalaya CLI not installed (optional until inbox sync)",
    fix: "brew install himalaya",
  });
}

console.log("\n  Ola CRM Doctor\n");
for (const c of checks) {
  const icon = c.ok === true ? "✓" : c.ok === false ? "✗" : "○";
  console.log(`  ${icon} ${c.msg}`);
  if (c.fix && c.ok !== true) console.log(`    → ${c.fix}`);
}
console.log("");

const failed = checks.some((c) => c.ok === false);
process.exit(failed ? 1 : 0);
