import * as crm from "../../getleads/lib/crm-api-async.mjs";

function send(res, status, data) {
  res.status(status).json(data);
}

function routeFromRequest(req) {
  if (req.url) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/crm")) return pathname;
  }
  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : req.query.path
      ? [req.query.path]
      : [];
  return `/api/crm/${segments.join("/")}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
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

export default async function handler(req, res) {
  const route = routeFromRequest(req);

  try {
    if (route === "/api/crm/stats" && req.method === "GET") {
      const stats = await crm.crmStats();
      return send(res, 200, { ok: true, ...stats });
    }

    if (route === "/api/crm/markets" && req.method === "GET") {
      const markets = await crm.crmMarkets();
      return send(res, 200, { ok: true, markets });
    }

    if (route === "/api/crm/accounts" && req.method === "GET") {
      const data = await crm.crmAccounts({
        q: req.query.q || "",
        tier: req.query.tier || "",
        market: req.query.market || "",
        limit: req.query.limit || 150,
        offset: req.query.offset || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/contacts" && req.method === "GET") {
      const data = await crm.crmContacts({
        q: req.query.q || "",
        hasEmail: req.query.has_email || "",
        hasLinkedIn: req.query.has_linkedin || "",
        source: req.query.source || "",
        limit: req.query.limit || 250,
        offset: req.query.offset || 0,
      });
      return send(res, 200, { ok: true, ...data });
    }

    if (route === "/api/crm/pipeline" && req.method === "GET") {
      const data = await crm.crmPipelineBoard({
        q: req.query.q || "",
        tier: req.query.tier || "",
        market: req.query.market || "",
        limit: req.query.limit || 600,
      });
      return send(res, 200, { ok: true, ...data });
    }

    const stageMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)\/stage$/);
    if (stageMatch && req.method === "PATCH") {
      const body = await readJsonBody(req);
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

    return send(res, 404, { ok: false, message: "Not found" });
  } catch (err) {
    return send(res, 500, { ok: false, message: err.message || "Server error" });
  }
}
