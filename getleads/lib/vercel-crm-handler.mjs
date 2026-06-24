import * as crm from "../../getleads/lib/crm-api-async.mjs";

export function sendJson(res, status, data) {
  res.status(status).json(data);
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
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

export function crmRouteFromRequest(req) {
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

export async function handleCrmRoute(req, res, route) {
  if (route === "/api/crm/stats" && req.method === "GET") {
    const stats = await crm.crmStats();
    return sendJson(res, 200, { ok: true, ...stats });
  }

  if (route === "/api/crm/markets" && req.method === "GET") {
    const markets = await crm.crmMarkets();
    return sendJson(res, 200, { ok: true, markets });
  }

  if (route === "/api/crm/accounts" && req.method === "GET") {
    const data = await crm.crmAccounts({
      q: req.query.q || "",
      tier: req.query.tier || "",
      market: req.query.market || "",
      limit: req.query.limit || 150,
      offset: req.query.offset || 0,
    });
    return sendJson(res, 200, { ok: true, ...data });
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
    return sendJson(res, 200, { ok: true, ...data });
  }

  if (route === "/api/crm/pipeline" && req.method === "GET") {
    const data = await crm.crmPipelineBoard({
      q: req.query.q || "",
      tier: req.query.tier || "",
      market: req.query.market || "",
      limit: req.query.limit || 600,
    });
    return sendJson(res, 200, { ok: true, ...data });
  }

  if (route === "/api/crm/company-states" && req.method === "GET") {
    const states = await crm.crmCompanyStates();
    return sendJson(res, 200, { ok: true, states });
  }

  if (route === "/api/crm/companies" && req.method === "GET") {
    const data = await crm.crmCompanies({
      q: req.query.q || "",
      state: req.query.state || "",
      hiring: req.query.hiring || "",
      hasEmail: req.query.has_email || "",
      industry: req.query.industry || "",
      limit: req.query.limit || 200,
      offset: req.query.offset || 0,
    });
    return sendJson(res, 200, { ok: true, ...data });
  }

  const companyMatch = route.match(/^\/api\/crm\/companies\/([^/]+)$/);
  if (companyMatch && req.method === "GET") {
    const company = await crm.crmCompanyDetail(companyMatch[1]);
    if (!company) return sendJson(res, 404, { ok: false, message: "Company not found" });
    return sendJson(res, 200, { ok: true, company });
  }

  const stageMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)\/stage$/);
  if (stageMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const updated = await crm.crmUpdateAccountStage(stageMatch[1], body.stage);
    if (!updated) return sendJson(res, 404, { ok: false, message: "Account not found" });
    return sendJson(res, 200, { ok: true, account: updated });
  }

  const accountMatch = route.match(/^\/api\/crm\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "GET") {
    const detail = await crm.crmAccountDetail(accountMatch[1]);
    if (!detail) return sendJson(res, 404, { ok: false, message: "Account not found" });
    return sendJson(res, 200, { ok: true, ...detail });
  }

  return sendJson(res, 404, { ok: false, message: "Not found" });
}

export async function handleCrmAccountDetail(req, res, id) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, message: "Method not allowed" });
  const detail = await crm.crmAccountDetail(id);
  if (!detail) return sendJson(res, 404, { ok: false, message: "Account not found" });
  return sendJson(res, 200, { ok: true, ...detail });
}

export async function handleCrmAccountStage(req, res, id) {
  if (req.method !== "PATCH") return sendJson(res, 405, { ok: false, message: "Method not allowed" });
  const body = await readJsonBody(req);
  const updated = await crm.crmUpdateAccountStage(id, body.stage);
  if (!updated) return sendJson(res, 404, { ok: false, message: "Account not found" });
  return sendJson(res, 200, { ok: true, account: updated });
}
