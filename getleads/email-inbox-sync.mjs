#!/usr/bin/env node
/**
 * Sync inbox replies via Himalaya CLI → Supabase crm_email_events.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as email from "./lib/email-api-async.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HIMALAYA_ACCOUNT = process.env.HIMALAYA_ACCOUNT || "concya";

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

loadEnvFile();

function listInbox() {
  const out = execFileSync(
    "himalaya",
    ["envelope", "list", "--account", HIMALAYA_ACCOUNT, "--folder", "INBOX", "--page-size", "50", "--output", "json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function normalizeSubject(s) {
  return (s || "").replace(/^re:\s*/i, "").trim().toLowerCase();
}

function extractFrom(envelope) {
  const from = envelope.from?.addr || envelope.from?.address || envelope.from;
  if (typeof from === "string") return from.toLowerCase();
  if (from?.address) return from.address.toLowerCase();
  if (Array.isArray(envelope.from) && envelope.from[0]?.addr) return envelope.from[0].addr.toLowerCase();
  return "";
}

async function main() {
  console.log("\n  Email inbox sync (Himalaya → CRM)\n");

  let envelopes;
  try {
    envelopes = listInbox();
  } catch (err) {
    console.error("  Himalaya failed:", err.message);
    console.error("  → brew install himalaya && configure ~/.config/himalaya/config.toml");
    console.error("  → see getleads/docs/himalaya-setup.md\n");
    process.exit(1);
  }

  const items = Array.isArray(envelopes) ? envelopes : envelopes.envelopes || envelopes.items || [];
  const sends = await email.getRecentSendsForSync(14);
  let matched = 0;

  for (const env of items) {
    const subject = env.subject || "";
    const from = extractFrom(env);
    if (!from || !subject) continue;

    const isReply = /^re:/i.test(subject);
    const normSubject = normalizeSubject(subject);

    for (const send of sends) {
      const sendNorm = normalizeSubject(send.subject);
      const toMatch = (send.to_email || "").toLowerCase();
      if (from !== toMatch) continue;
      if (!isReply && sendNorm !== normSubject) continue;
      if (isReply && !normSubject.includes(sendNorm) && !sendNorm.includes(normSubject)) continue;

      const result = await email.recordReplyFromInbox({
        sendId: send.id,
        payload: { subject, from, date: env.date || env.received_at },
      });
      if (!result.duplicate) {
        matched++;
        console.log(`  ✓ Reply: ${from} — "${subject.slice(0, 50)}"`);
      }
      break;
    }
  }

  console.log(`\n  Done. ${matched} new reply event(s).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
