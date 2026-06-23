import * as email from "../../../getleads/lib/email-api-async.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed" });
  try {
    const timeline = await email.getContactEmailTimeline(req.query.id);
    return res.status(200).json({ ok: true, timeline });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
