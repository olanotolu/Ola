import { handleCrmAccountDetail } from "../../../getleads/lib/vercel-crm-handler.mjs";

export default async function handler(req, res) {
  try {
    return await handleCrmAccountDetail(req, res, req.query.id);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
