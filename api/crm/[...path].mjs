import {
  crmRouteFromRequest,
  handleCrmRoute,
} from "../../getleads/lib/vercel-crm-handler.mjs";

export default async function handler(req, res) {
  const route = crmRouteFromRequest(req);
  try {
    return await handleCrmRoute(req, res, route);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
