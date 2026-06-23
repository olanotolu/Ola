import { Resend } from "resend";
import { Webhook } from "svix";
import { getSupabase } from "./supabase-client.mjs";
import { crmUpdateAccountStage } from "./crm-api-async.mjs";

const EVENT_MAP = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
};

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  return new Resend(key);
}

export async function sendContactEmail({ contactId, subject, bodyText, bodyHtml, campaignId }) {
  const sb = getSupabase();
  const { data: contact, error: contactErr } = await sb
    .from("crm_contacts")
    .select("id, name, email, account_id, crm_accounts(id, group_name, stage)")
    .eq("id", contactId)
    .maybeSingle();

  if (contactErr) throw contactErr;
  if (!contact?.email) throw new Error("Contact has no email address");

  const from = process.env.RESEND_FROM_EMAIL || "Ola Adu <hello@concya.com>";
  const to = contact.email;

  const { data: sendRow, error: insertErr } = await sb
    .from("crm_email_sends")
    .insert({
      contact_id: contact.id,
      account_id: contact.account_id,
      campaign_id: campaignId || null,
      to_email: to,
      from_email: from,
      subject,
      body_text: bodyText,
      status: "queued",
    })
    .select("id")
    .single();

  if (insertErr) throw insertErr;

  const resend = getResend();
  const html = bodyHtml || `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(bodyText)}</pre>`;

  const { data: resendData, error: sendErr } = await resend.emails.send({
    from,
    to: [to],
    subject,
    text: bodyText,
    html,
    headers: { "X-CRM-Send-Id": sendRow.id },
  });

  if (sendErr) {
    await sb.from("crm_email_sends").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", sendRow.id);
    throw new Error(sendErr.message || "Resend send failed");
  }

  const messageId = resendData?.id;
  await sb
    .from("crm_email_sends")
    .update({
      resend_message_id: messageId,
      status: "sent",
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sendRow.id);

  await sb.from("crm_email_events").insert({
    send_id: sendRow.id,
    event_type: "sent",
    source: "resend",
    payload: { resend_id: messageId },
  });

  const account = contact.crm_accounts;
  if (account?.id && (account.stage === "research" || account.stage === "targeted")) {
    await crmUpdateAccountStage(account.id, "contacted");
  }

  return { send_id: sendRow.id, resend_message_id: messageId, to, subject };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function handleResendWebhook(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing RESEND_WEBHOOK_SECRET");

  const wh = new Webhook(secret);
  let event;
  try {
    event = wh.verify(rawBody, {
      "svix-id": headers["svix-id"],
      "svix-timestamp": headers["svix-timestamp"],
      "svix-signature": headers["svix-signature"],
    });
  } catch {
    throw new Error("Invalid webhook signature");
  }

  const type = event.type;
  const eventType = EVENT_MAP[type] || type;
  const data = event.data || {};
  const messageId = data.email_id || data.id;

  const sb = getSupabase();
  let sendId = null;

  if (data.headers?.["x-crm-send-id"]) {
    sendId = data.headers["x-crm-send-id"];
  }

  if (!sendId && messageId) {
    const { data: row } = await sb
      .from("crm_email_sends")
      .select("id")
      .eq("resend_message_id", messageId)
      .maybeSingle();
    sendId = row?.id;
  }

  if (!sendId) return { ok: true, skipped: true, reason: "no matching send" };

  const statusMap = {
    sent: "sent",
    delivered: "delivered",
    opened: "opened",
    clicked: "clicked",
    bounced: "bounced",
    complained: "complained",
  };
  const newStatus = statusMap[eventType];
  if (newStatus) {
    await sb
      .from("crm_email_sends")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", sendId);
  }

  await sb.from("crm_email_events").insert({
    send_id: sendId,
    event_type: eventType,
    source: "resend",
    payload: data,
    occurred_at: data.created_at || new Date().toISOString(),
  });

  if (eventType === "bounced") {
    const { data: send } = await sb.from("crm_email_sends").select("account_id").eq("id", sendId).maybeSingle();
    if (send?.account_id) await crmUpdateAccountStage(send.account_id, "lost");
  }

  return { ok: true, send_id: sendId, event_type: eventType };
}

export async function getEmailStats() {
  const sb = getSupabase();
  const [{ count: sent }, { data: events }, { data: recent }] = await Promise.all([
    sb.from("crm_email_sends").select("*", { count: "exact", head: true }),
    sb.from("crm_email_events").select("event_type"),
    sb
      .from("crm_email_sends")
      .select(
        "id, to_email, subject, status, sent_at, contact_id, crm_contacts(name, crm_accounts(group_name))",
      )
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const counts = {};
  for (const e of events || []) {
    counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  }

  const delivered = counts.delivered || 0;
  const opened = counts.opened || 0;
  const bounced = counts.bounced || 0;
  const replied = counts.replied || 0;
  const total = sent ?? 0;

  return {
    total_sends: total,
    delivered,
    opened,
    clicked: counts.clicked || 0,
    bounced,
    replied,
    open_rate: delivered > 0 ? Math.round((opened / delivered) * 100) : 0,
    bounce_rate: total > 0 ? Math.round((bounced / total) * 100) : 0,
    reply_rate: total > 0 ? Math.round((replied / total) * 100) : 0,
    recent: (recent || []).map((r) => ({
      id: r.id,
      to_email: r.to_email,
      subject: r.subject,
      status: r.status,
      sent_at: r.sent_at,
      contact_name: r.crm_contacts?.name,
      company: r.crm_contacts?.crm_accounts?.group_name,
    })),
  };
}

export async function getContactEmailTimeline(contactId) {
  const sb = getSupabase();
  const { data: sends, error } = await sb
    .from("crm_email_sends")
    .select("id, subject, status, sent_at, to_email, created_at, crm_email_events(id, event_type, occurred_at, source)")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return sends || [];
}

export async function listOutreachContacts({ limit = 100 }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("crm_contacts")
    .select("id, name, email, title, account_id, crm_accounts(group_name, tier, stage)")
    .not("email", "is", null)
    .neq("email", "")
    .order("name")
    .limit(Number(limit) || 100);

  if (error) throw error;

  const contactIds = (data || []).map((c) => c.id);
  if (!contactIds.length) return [];

  const { data: sends } = await sb
    .from("crm_email_sends")
    .select("contact_id, status, sent_at")
    .in("contact_id", contactIds)
    .order("sent_at", { ascending: false });

  const lastByContact = {};
  for (const s of sends || []) {
    if (!lastByContact[s.contact_id]) lastByContact[s.contact_id] = s;
  }

  return (data || []).map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    title: c.title,
    company: c.crm_accounts?.group_name,
    tier: c.crm_accounts?.tier,
    stage: c.crm_accounts?.stage,
    last_send_status: lastByContact[c.id]?.status || null,
    last_sent_at: lastByContact[c.id]?.sent_at || null,
  }));
}

export async function recordReplyFromInbox({ sendId, payload }) {
  const sb = getSupabase();
  const { data: existing } = await sb
    .from("crm_email_events")
    .select("id")
    .eq("send_id", sendId)
    .eq("event_type", "replied")
    .limit(1);

  if (existing?.length) return { ok: true, duplicate: true };

  await sb.from("crm_email_events").insert({
    send_id: sendId,
    event_type: "replied",
    source: "himalaya",
    payload: payload || {},
  });

  const { data: send } = await sb.from("crm_email_sends").select("account_id").eq("id", sendId).maybeSingle();
  if (send?.account_id) await crmUpdateAccountStage(send.account_id, "connected");

  return { ok: true };
}

export async function getRecentSendsForSync(days = 14) {
  const sb = getSupabase();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb
    .from("crm_email_sends")
    .select("id, to_email, subject, sent_at")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });

  if (error) throw error;
  return data || [];
}
