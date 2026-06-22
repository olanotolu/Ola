import * as crm from "../../getleads/lib/crm-api-async.mjs";

function send(res, status, data) {
  res.status(status).json(data);
}

export default async function handler(req, res) {
  const segments = Array.isArray(req.query.path) ? req.query.path : [];
  const route = `/api/crm/${segments.join("/")}`;

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
