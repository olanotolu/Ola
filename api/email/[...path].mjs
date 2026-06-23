import * as email from "../../getleads/lib/email-api-async.mjs";

function send(res, status, data) {
  res.status(status).json(data);
}

function routeFromRequest(req) {
  if (req.url) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/email")) return pathname;
  }
  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : req.query.path
      ? [req.query.path]
      : [];
  return `/api/email/${segments.join("/")}`;
}

async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  const route = routeFromRequest(req);

  try {
    if (route === "/api/email/stats" && req.method === "GET") {
      const stats = await email.getEmailStats();
      return send(res, 200, { ok: true, ...stats });
    }

    if (route === "/api/email/contacts" && req.method === "GET") {
      const contacts = await email.listOutreachContacts({ limit: req.query.limit || 100 });
      return send(res, 200, { ok: true, contacts });
    }

    if (route === "/api/email/send" && req.method === "POST") {
      const body = await readJsonBody(req);
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
      const headers = {
        "svix-id": req.headers["svix-id"],
        "svix-timestamp": req.headers["svix-timestamp"],
        "svix-signature": req.headers["svix-signature"],
      };
      const result = await email.handleResendWebhook(raw, headers);
      return send(res, 200, result);
    }

    const contactMatch = route.match(/^\/api\/email\/contact\/([^/]+)$/);
    if (contactMatch && req.method === "GET") {
      const timeline = await email.getContactEmailTimeline(contactMatch[1]);
      return send(res, 200, { ok: true, timeline });
    }

    return send(res, 404, { ok: false, message: "Not found" });
  } catch (err) {
    return send(res, 500, { ok: false, message: err.message || "Server error" });
  }
}
