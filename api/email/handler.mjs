import {
  emailRouteFromRequest,
  handleEmailRoute,
} from "../../getleads/lib/vercel-email-handler.mjs";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  const route = emailRouteFromRequest(req);
  try {
    return await handleEmailRoute(req, res, route);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
