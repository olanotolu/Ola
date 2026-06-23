import * as email from "../../../getleads/lib/email-api-async.mjs";

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

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "Method not allowed" });
  try {
    const raw = await readRawBody(req);
    const headers = {
      "svix-id": req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"],
    };
    const result = await email.handleResendWebhook(raw, headers);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
