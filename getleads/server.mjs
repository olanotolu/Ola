import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gl from "./lib/client.mjs";
import * as crm from "./lib/crm-api-async.mjs";
import * as email from "./lib/email-api-async.mjs";
import { useSupabaseHttp } from "./lib/supabase-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.GETLEADS_UI_PORT || 3200);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  let filePath = path.join(PUBLIC, req.url === "/" ? "index.html" : req.url);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  try {
    if (route === "/api/local/status" && req.method === "GET") {
      const s = gl.status();
      const email = process.env.GETLEADS_EMAIL || "";
      return send(res, 200, { ...s, defaultEmail: email });
    }

    if (route === "/api/local/login" && req.method === "POST") {
      const { email, password } = await readBody(req);
      if (!email || !password) return send(res, 400, { ok: false, message: "Email and password required." });
      const result = await gl.login(email, password);
      return send(res, result.status, result.json ?? { ok: result.status < 300 });
    }

    if (route === "/api/local/logout" && req.method === "POST") {
      await gl.logout();
      return send(res, 200, { ok: true });
    }

    if (route === "/api/local/me" && req.method === "GET") {
      const result = await gl.request({ method: "GET", path: "/api/auth/me", useSession: true });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/api-key" && req.method === "POST") {
      const { apiKey } = await readBody(req);
      if (!apiKey?.startsWith("glb_")) {
        return send(res, 400, { ok: false, message: "API key must start with glb_" });
      }
      gl.setApiKey(apiKey.trim());
      return send(res, 200, { ok: true, ...gl.status() });
    }

    if (route === "/api/local/api-keys" && req.method === "GET") {
      const result = await gl.request({ method: "GET", path: "/api/api-keys", useSession: true });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/api-keys" && req.method === "POST") {
      const body = await readBody(req);
      const result = await gl.request({
        method: "POST",
        path: "/api/api-keys",
        body: { name: body.name || "Ola UI key" },
        useSession: true,
      });
      if (result.status < 300 && result.json?.key) {
        gl.setApiKey(result.json.key);
      }
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/dashboard/stats" && req.method === "GET") {
      const result = await gl.request({ method: "GET", path: "/api/dashboard/stats", useSession: true });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/dashboard/runs" && req.method === "GET") {
      const result = await gl.request({
        method: "GET",
        path: "/api/dashboard/runs",
        query: { limit: url.searchParams.get("limit") || "10" },
        useSession: true,
      });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/contacts/search" && req.method === "POST") {
      const body = await readBody(req);
      const result = await gl.request({
        method: "POST",
        path: "/api/v1/contacts/search",
        body,
        useSession: false,
      });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/funding/signals" && req.method === "GET") {
      const result = await gl.request({
        method: "GET",
        path: "/api/v1/funding/signals",
        query: { limit: url.searchParams.get("limit") || "20" },
        useSession: false,
      });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/local/health" && req.method === "GET") {
      const result = await gl.request({ method: "GET", path: "/api/health", useSession: false });
      return send(res, result.status, result.json ?? { ok: false });
    }

    if (route === "/api/crm/stats" && req.method === "GET") {
      return send(res, 200, { ok: true, ...(await crm.crmStats()) });
    }

    if (route === "/api/crm/markets" && req.method === "GET") {
      return send(res, 200, { ok: true, markets: await crm.crmMarkets() });
    }

    if (route === "/api/crm/accounts" && req.method === "GET") {
      const data = await crm.crmAccounts({
        q: url.searchParams.get("q") || "",
        tier: url.searchParams.get("tier") || "",
        market: url.searchParams.get("market") || "",
        limit: url.searchParams.get("limit") || 150,
        offset: url.searchParams.get("offset") || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/contacts" && req.method === "GET") {
      const data = await crm.crmContacts({
        q: url.searchParams.get("q") || "",
        hasEmail: url.searchParams.get("has_email") || "",
        hasLinkedIn: url.searchParams.get("has_linkedin") || "",
        source: url.searchParams.get("source") || "",
        limit: url.searchParams.get("limit") || 250,
        offset: url.searchParams.get("offset") || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/pipeline" && req.method === "GET") {
      const data = await crm.crmPipelineBoard({
        q: url.searchParams.get("q") || "",
        tier: url.searchParams.get("tier") || "",
        market: url.searchParams.get("market") || "",
        limit: url.searchParams.get("limit") || 600,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/company-states" && req.method === "GET") {
      return send(res, 200, { ok: true, states: await crm.crmCompanyStates() });
    }

    if (route === "/api/crm/companies" && req.method === "GET") {
      const data = await crm.crmCompanies({
        q: url.searchParams.get("q") || "",
        state: url.searchParams.get("state") || "",
        hiring: url.searchParams.get("hiring") || "",
        hasEmail: url.searchParams.get("has_email") || "",
        industry: url.searchParams.get("industry") || "",
        limit: url.searchParams.get("limit") || 200,
        offset: url.searchParams.get("offset") || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    const companyMatch = route.match(/^\/api\/crm\/companies\/([^/]+)$/);
    if (companyMatch && req.method === "GET") {
      const company = await crm.crmCompanyDetail(companyMatch[1]);
      if (!company) return send(res, 404, { ok: false, message: "Company not found" });
      return send(res, 200, { ok: true, company });
    }

    const stageMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)\/stage$/);
    if (stageMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const updated = await crm.crmUpdateAccountStage(stageMatch[1], body.stage);
      if (!updated) return send(res, 404, { ok: false, message: "Account not found" });
      return send(res, 200, { ok: true, account: updated });
    }

    const accountMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)$/);
    if (accountMatch && req.method === "GET") {
      const detail = await crm.crmAccountDetail(accountMatch[1]);
      if (!detail) return send(res, 404, { ok: false, message: "Account not found" });
      return send(res, 200, { ok: true, ...detail });
    }

    const openTrackMatch = route.match(/^\/api\/email\/track\/open\/([^/.]+)/);
    if (openTrackMatch && req.method === "GET") {
      const sendId = openTrackMatch[1].replace(/\.png$/i, "");
      await email.recordTrackingEvent(sendId, "opened", "pixel", {});
      const buf = email.trackingPixelBuffer();
      res.writeHead(200, {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store",
        "Content-Length": buf.length,
      });
      return res.end(buf);
    }

    const clickTrackMatch = route.match(/^\/api\/email\/track\/click\/([^/]+)$/);
    if (clickTrackMatch && req.method === "GET") {
      const target = url.searchParams.get("u");
      if (target) await email.recordTrackingEvent(clickTrackMatch[1], "clicked", "pixel", { url: target });
      res.writeHead(302, { Location: target || "/" });
      return res.end();
    }

    if (route === "/api/email/stats" && req.method === "GET") {
      const stats = await email.getEmailStats();
      return send(res, 200, { ok: true, ...stats });
    }

    if (route === "/api/email/queue/process" && req.method === "POST") {
      const result = await email.processSendQueue({ limit: Number(url.searchParams.get("limit")) || 8 });
      return send(res, 200, { ok: true, ...result });
    }

    if (route === "/api/email/contacts" && req.method === "GET") {
      const contacts = await email.listOutreachContacts({ limit: url.searchParams.get("limit") || 100 });
      return send(res, 200, { ok: true, contacts });
    }

    if (route === "/api/email/sequences/board" && req.method === "GET") {
      const board = await email.getSequencesBoard({
        tier: url.searchParams.get("tier") || "",
        intent: url.searchParams.get("intent") || "",
        dueOnly: url.searchParams.get("due") === "1",
      });
      return send(res, 200, { ok: true, ...board });
    }

    if (route === "/api/email/enroll" && req.method === "POST") {
      const body = await readBody(req);
      const enrollment = await email.enrollContact({
        contactId: body.contact_id,
        signalBrief: body.signal_brief,
      });
      return send(res, 200, { ok: true, enrollment });
    }

    if (route === "/api/email/send-step" && req.method === "POST") {
      const body = await readBody(req);
      const result = await email.sendSequenceStep({
        contactId: body.contact_id,
        step: body.step,
        previewOnly: body.preview_only === true,
        signalBrief: body.signal_brief,
      });
      return send(res, 200, { ok: true, ...result });
    }

    if (route === "/api/email/signal-brief" && req.method === "POST") {
      const body = await readBody(req);
      await email.saveContactSignalBrief(body.contact_id, body.signal_brief);
      return send(res, 200, { ok: true });
    }

    const enrollmentMatch = route.match(/^\/api\/email\/enrollments\/([^/]+)$/);
    if (enrollmentMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const updated = await email.updateEnrollmentStatus(enrollmentMatch[1], body.outreach_status);
      return send(res, 200, { ok: true, enrollment: updated });
    }

    if (route === "/api/email/send" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.contact_id || !body.subject || !body.body) {
        return send(res, 400, { ok: false, message: "contact_id, subject, and body required" });
      }
      const result = await email.sendContactEmail({
        contactId: body.contact_id,
        subject: body.subject,
        bodyText: body.body,
        bodyHtml: body.html,
        campaignId: body.campaign_id,
      });
      return send(res, 200, { ok: true, ...result });
    }

    if (route === "/api/email/webhook/resend" && req.method === "POST") {
      const raw = await readRawBody(req);
      const result = await email.handleResendWebhook(raw, {
        "svix-id": req.headers["svix-id"],
        "svix-timestamp": req.headers["svix-timestamp"],
        "svix-signature": req.headers["svix-signature"],
      });
      return send(res, 200, result);
    }

    const emailContactMatch = route.match(/^\/api\/email\/contact\/([^/]+)$/);
    if (emailContactMatch && req.method === "GET") {
      const data = await email.getContactEmailTimeline(emailContactMatch[1]);
      return send(res, 200, { ok: true, timeline: data.sends, enrollment: data.enrollment });
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, message: "Not found" }));
  } catch (err) {
    send(res, 500, { ok: false, message: err.message || "Server error" });
  }
}

loadEnvFile();
if (process.env.GETLEADS_API_KEY) gl.setApiKey(process.env.GETLEADS_API_KEY);

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Ola Leads + Concya CRM`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  GetLeads profile: ${gl.PROFILE}`);
  console.log(
    `  Concya CRM: ${useSupabaseHttp() ? "Supabase HTTP (live)" : "missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in getleads/.env.getleads"}\n`,
  );
});
