/** Delivery reliability helpers — failure classification, open confidence, health metrics */

export const OPEN_SUSPECT_SECONDS = 45;
export const OPEN_CONFIRMED_SECONDS = 90;

const SCANNER_UA =
  /proofpoint|mimecast|barracuda|messagelabs|symantec|googleimageproxy|yahoo!.slurp|outlook-iOS|Microsoft Office|curl|python|bot|spider|crawler/i;

export function classifySmtpError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (/send limit exceeded|rate limit|too many|421|452|450.*limit/i.test(msg)) {
    return { failure_reason: "rate_limit", retryable: true };
  }
  if (/550|551|552|553|554|mailbox unavailable|user unknown|does not exist|invalid recipient|rejected/i.test(msg)) {
    return { failure_reason: "bounce", retryable: false };
  }
  if (/timeout|etimedout|econnreset|enotfound|network/i.test(msg)) {
    return { failure_reason: "provider_error", retryable: true };
  }
  return { failure_reason: "unknown", retryable: true };
}

export function classifyOpen({ sentAt, userAgent, ip }) {
  const sent = sentAt ? new Date(sentAt).getTime() : 0;
  const deltaSec = sent ? (Date.now() - sent) / 1000 : 999;
  const ua = userAgent || "";

  if (SCANNER_UA.test(ua)) {
    return { event_type: "open_suspect", confidence: "scanner", delta_sec: deltaSec };
  }
  if (deltaSec < OPEN_SUSPECT_SECONDS) {
    return { event_type: "open_suspect", confidence: "fast", delta_sec: deltaSec };
  }
  if (deltaSec >= OPEN_CONFIRMED_SECONDS) {
    return { event_type: "opened", confidence: "high", delta_sec: deltaSec };
  }
  return { event_type: "opened", confidence: "medium", delta_sec: deltaSec };
}

export function isConfirmedOpen(events) {
  const types = new Set((events || []).map((e) => e.event_type));
  if (types.has("replied") || types.has("clicked")) return true;
  return (events || []).some(
    (e) => e.event_type === "opened" && (e.payload?.confidence === "high" || e.payload?.confidence === "medium"),
  );
}

export function computeDeliveryHealth(sends, events) {
  const bySend = {};
  for (const e of events || []) {
    if (!bySend[e.send_id]) bySend[e.send_id] = [];
    bySend[e.send_id].push(e);
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let rate_limited = 0;
  let bounced = 0;
  let opened_confirmed = 0;
  let opened_suspect = 0;
  let replied = 0;
  let auto_replied = 0;

  for (const s of sends || []) {
    attempted++;
    const ev = bySend[s.id] || [];
    const types = new Set(ev.map((e) => e.event_type));

    if (s.status === "failed" || types.has("failed")) {
      failed++;
      if (s.failure_reason === "rate_limit" || types.has("rate_limited")) rate_limited++;
      continue;
    }
    if (s.status === "bounced" || types.has("bounced")) {
      bounced++;
      failed++;
      continue;
    }
    if (["sent", "delivered", "opened", "clicked", "replied"].includes(s.status)) {
      delivered++;
    }

    if (types.has("replied")) replied++;
    if (types.has("auto_replied")) auto_replied++;
    if (types.has("opened") && ev.some((e) => e.event_type === "opened" && e.payload?.confidence !== "fast")) {
      opened_confirmed++;
    }
    if (types.has("open_suspect")) opened_suspect++;
  }

  const delivery_rate = attempted > 0 ? Math.round((delivered / attempted) * 100) : 0;
  const failure_rate = attempted > 0 ? Math.round((failed / attempted) * 100) : 0;
  const reply_rate = delivered > 0 ? Math.round((replied / delivered) * 100) : 0;
  const open_rate_confirmed = delivered > 0 ? Math.round((opened_confirmed / delivered) * 100) : 0;

  return {
    attempted,
    delivered,
    failed,
    rate_limited,
    bounced,
    opened_confirmed,
    opened_suspect,
    replied,
    auto_replied,
    delivery_rate,
    failure_rate,
    reply_rate,
    open_rate_confirmed,
  };
}

export function nextRetryAt(attempts, failureReason) {
  const base = failureReason === "rate_limit" ? 3600000 : 300000; // 1h rate limit, 5m other
  const delay = Math.min(base * 2 ** Math.max(0, attempts - 1), 86400000);
  return new Date(Date.now() + delay).toISOString();
}
