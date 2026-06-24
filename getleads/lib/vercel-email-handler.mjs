import * as email from "./email-api-async.mjs";

export function sendJson(res, status, data) {
  res.status(status).json(data);
}

export function emailRouteFromRequest(req) {
  const qPath = req.query?.path;
  if (qPath) {
    const segments = Array.isArray(qPath) ? qPath : String(qPath).split("/").filter(Boolean);
    if (segments.length) return `/api/email/${segments.join("/")}`;
  }

  if (req.url) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/email") && pathname !== "/api/email/handler") {
      return pathname;
    }
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

export async function handleEmailRoute(req, res, route) {
  if (route === "/api/email/stats" && req.method === "GET") {
    const stats = await email.getEmailStats();
    return sendJson(res, 200, { ok: true, ...stats });
  }

  if (route === "/api/email/queue/process" && req.method === "POST") {
    const result = await email.processSendQueue({ limit: Number(req.query.limit) || 8 });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (route === "/api/email/contacts" && req.method === "GET") {
    const contacts = await email.listOutreachContacts({ limit: req.query.limit || 100 });
    return sendJson(res, 200, { ok: true, contacts });
  }

  if (route === "/api/email/sequences/board" && req.method === "GET") {
    const board = await email.getSequencesBoard({
      tier: req.query.tier || "",
      intent: req.query.intent || "",
      dueOnly: req.query.due === "1",
    });
    return sendJson(res, 200, { ok: true, ...board });
  }

  if (route === "/api/email/enroll" && req.method === "POST") {
    const body = await readJsonBody(req);
    const enrollment = await email.enrollContact({
      contactId: body.contact_id,
      signalBrief: body.signal_brief,
    });
    return sendJson(res, 200, { ok: true, enrollment });
  }

  if (route === "/api/email/send-step" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await email.sendSequenceStep({
      contactId: body.contact_id,
      step: body.step,
      previewOnly: body.preview_only === true,
      signalBrief: body.signal_brief,
    });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (route === "/api/email/signal-brief" && req.method === "POST") {
    const body = await readJsonBody(req);
    await email.saveContactSignalBrief(body.contact_id, body.signal_brief);
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/email/send" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body.contact_id || !body.subject || !body.body) {
      return sendJson(res, 400, { ok: false, message: "contact_id, subject, and body required" });
    }
    const result = await email.sendContactEmail({
      contactId: body.contact_id,
      subject: body.subject,
      bodyText: body.body,
      bodyHtml: body.html,
      campaignId: body.campaign_id,
    });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (route === "/api/email/webhook/resend" && req.method === "POST") {
    const raw = await readRawBody(req);
    const headers = {
      "svix-id": req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"],
    };
    const result = await email.handleResendWebhook(raw, headers);
    return sendJson(res, 200, result);
  }

  const openMatch = route.match(/^\/api\/email\/track\/open\/([^/.]+)/);
  if (openMatch && req.method === "GET") {
    const sendId = openMatch[1].replace(/\.png$/i, "");
    const payload = {
      user_agent: req.headers["user-agent"] || "",
      ip: req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "",
    };
    await email.recordTrackingEvent(sendId, "opened", "pixel", payload);
    const buf = email.trackingPixelBuffer();
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  }

  const clickMatch = route.match(/^\/api\/email\/track\/click\/([^/]+)$/);
  if (clickMatch && req.method === "GET") {
    const target = new URL(req.url, "http://localhost").searchParams.get("u");
    if (target) await email.recordTrackingEvent(clickMatch[1], "clicked", "pixel", { url: target });
    return res.redirect(302, target || "/");
  }

  const enrollmentMatch = route.match(/^\/api\/email\/enrollments\/([^/]+)$/);
  if (enrollmentMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const updated = await email.updateEnrollmentStatus(enrollmentMatch[1], body.outreach_status);
    return sendJson(res, 200, { ok: true, enrollment: updated });
  }

  const contactMatch = route.match(/^\/api\/email\/contact\/([^/]+)$/);
  if (contactMatch && req.method === "GET") {
    const data = await email.getContactEmailTimeline(contactMatch[1]);
    return sendJson(res, 200, { ok: true, timeline: data.sends, enrollment: data.enrollment });
  }

  return sendJson(res, 404, { ok: false, message: "Not found" });
}
