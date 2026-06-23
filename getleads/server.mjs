import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gl from "./lib/client.mjs";
import * as crm from "./lib/crm-api.mjs";

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
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
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
      return send(res, 200, { ok: true, ...crm.crmStats() });
    }

    if (route === "/api/crm/markets" && req.method === "GET") {
      return send(res, 200, { ok: true, markets: crm.crmMarkets() });
    }

    if (route === "/api/crm/accounts" && req.method === "GET") {
      const data = crm.crmAccounts({
        q: url.searchParams.get("q") || "",
        tier: url.searchParams.get("tier") || "",
        market: url.searchParams.get("market") || "",
        limit: url.searchParams.get("limit") || 150,
        offset: url.searchParams.get("offset") || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/contacts" && req.method === "GET") {
      const data = crm.crmContacts({
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
      const data = crm.crmPipelineBoard({
        q: url.searchParams.get("q") || "",
        tier: url.searchParams.get("tier") || "",
        market: url.searchParams.get("market") || "",
        limit: url.searchParams.get("limit") || 600,
      });
      return send(res, 200, { ok: true, ...data });
    }

    const stageMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)\/stage$/);
    if (stageMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const updated = crm.crmUpdateAccountStage(stageMatch[1], body.stage);
      if (!updated) return send(res, 404, { ok: false, message: "Account not found" });
      return send(res, 200, { ok: true, account: updated });
    }

    const accountMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)$/);
    if (accountMatch && req.method === "GET") {
      const detail = crm.crmAccountDetail(accountMatch[1]);
      if (!detail) return send(res, 404, { ok: false, message: "Account not found" });
      return send(res, 200, { ok: true, ...detail });
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
  console.log(`  Concya CRM: live from Supabase\n`);
});
