import { Resend } from "resend";
import { Webhook } from "svix";
import { getSupabase } from "./supabase-client.mjs";
import { crmUpdateAccountStage } from "./crm-api-async.mjs";
import { sendSmtpEmail, getFromAddress } from "./smtp-send.mjs";
import {
  classifySmtpError,
  classifyOpen,
  computeDeliveryHealth,
  isConfirmedOpen,
  nextRetryAt,
} from "./email-delivery.mjs";
import {
  SEQUENCE_KEY,
  OUTREACH_STATUSES,
  SEQUENCE_STEPS,
  buildTouchContent,
  nextSendAt,
} from "./sequence-config.mjs";
import { assertNorthAmericaContact } from "./outreach-region.mjs";

const EVENT_MAP = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
};

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  return new Resend(key);
}

async function loadContact(sb, contactId) {
  const { data, error } = await sb
    .from("crm_contacts")
    .select(
      "id, name, email, title, account_id, outreach_notes, source_payload, crm_accounts(id, group_name, stage, tier, market_name, market_key)",
    )
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.email) throw new Error("Contact has no email address");
  return data;
}

async function getFirstSendMessageId(sb, enrollmentId) {
  const { data } = await sb
    .from("crm_email_sends")
    .select("message_id")
    .eq("enrollment_id", enrollmentId)
    .eq("sequence_step", 1)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.message_id || null;
}

async function advanceEnrollment(sb, enrollmentId, step) {
  const now = new Date().toISOString();
  const updates = {
    current_step: step,
    last_sent_at: now,
    next_send_at: nextSendAt(step),
    outreach_status: step >= 5 ? "completed" : "active",
    updated_at: now,
  };
  await sb.from("crm_sequence_enrollments").update(updates).eq("id", enrollmentId);
}

async function recordSendFailure(sb, sendId, err) {
  const { failure_reason, retryable } = classifySmtpError(err);
  const error_message = String(err?.message || err).slice(0, 500);
  const now = new Date().toISOString();
  await sb
    .from("crm_email_sends")
    .update({ status: "failed", failure_reason, error_message, updated_at: now })
    .eq("id", sendId);
  await sb.from("crm_email_events").insert({
    send_id: sendId,
    event_type: failure_reason === "rate_limit" ? "rate_limited" : "failed",
    source: "smtp",
    payload: { error: error_message, failure_reason, retryable },
  });
}

async function findDuplicateSend(sb, { contactId, sequenceStep, subject }) {
  if (sequenceStep != null) {
    const { data } = await sb
      .from("crm_email_sends")
      .select("id, sent_at, status")
      .eq("contact_id", contactId)
      .eq("sequence_step", sequenceStep)
      .not("sent_at", "is", null)
      .neq("status", "failed")
      .neq("status", "bounced")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }

  const since = new Date(Date.now() - 6 * 3600000).toISOString();
  const { data: bySubject } = await sb
    .from("crm_email_sends")
    .select("id, sent_at, status")
    .eq("contact_id", contactId)
    .eq("subject", subject)
    .not("sent_at", "is", null)
    .neq("status", "failed")
    .neq("status", "bounced")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return bySubject || null;
}

function duplicateSendError(contact, sequenceStep, existing) {
  const err = new Error(
    `Duplicate send blocked: ${sequenceStep != null ? `touch ${sequenceStep}` : "this subject"} already sent to ${contact.name || contact.email}`,
  );
  err.code = "DUPLICATE_SEND";
  err.existingSendId = existing.id;
  return err;
}

export async function enqueueSend({
  contactId,
  subject,
  bodyText,
  bodyHtml,
  campaignId,
  enrollmentId,
  sequenceStep,
  failureReason,
  lastError,
  attempts = 0,
}) {
  const sb = getSupabase();
  const contact = await loadContact(sb, contactId);
  assertNorthAmericaContact(contact);

  const dup = await findDuplicateSend(sb, { contactId, sequenceStep, subject });
  if (dup) throw duplicateSendError(contact, sequenceStep, dup);

  const { data, error } = await sb
    .from("crm_email_send_queue")
    .insert({
      contact_id: contactId,
      enrollment_id: enrollmentId || null,
      campaign_id: campaignId || null,
      sequence_step: sequenceStep || null,
      subject,
      body_text: bodyText,
      body_html: bodyHtml || null,
      status: "pending",
      attempts,
      failure_reason: failureReason || null,
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      next_attempt_at: nextRetryAt(attempts + 1, failureReason),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data;
}

export async function processSendQueue({ limit = 8 } = {}) {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { data: items, error } = await sb
    .from("crm_email_send_queue")
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  const results = [];

  for (const item of items || []) {
    await sb
      .from("crm_email_send_queue")
      .update({ status: "processing", updated_at: now })
      .eq("id", item.id);

    try {
      const sent = await sendContactEmail({
        contactId: item.contact_id,
        subject: item.subject,
        bodyText: item.body_text,
        bodyHtml: item.body_html,
        campaignId: item.campaign_id,
        enrollmentId: item.enrollment_id,
        sequenceStep: item.sequence_step,
      });
      await sb
        .from("crm_email_send_queue")
        .update({ status: "sent", updated_at: new Date().toISOString() })
        .eq("id", item.id);
      results.push({ id: item.id, status: "sent", send_id: sent.send_id });
    } catch (err) {
      const nonNa = err?.code === "NON_NA_CONTACT";
      const { failure_reason, retryable } = nonNa
        ? { failure_reason: "non_na_region", retryable: false }
        : classifySmtpError(err);
      const attempts = (item.attempts || 0) + 1;
      const updates = {
        attempts,
        last_error: String(err?.message || err).slice(0, 500),
        failure_reason,
        updated_at: new Date().toISOString(),
        status: nonNa || !retryable || attempts >= item.max_attempts ? "failed" : "pending",
        next_attempt_at: nonNa ? now : nextRetryAt(attempts, failure_reason),
      };
      if (nonNa) console.log(`[outreach] Queue skip (non-NA): ${updates.last_error}`);
      await sb.from("crm_email_send_queue").update(updates).eq("id", item.id);
      results.push({ id: item.id, status: updates.status, error: updates.last_error });
      if (failure_reason === "rate_limit") break;
    }
  }

  return { processed: results.length, results };
}

export async function requeueFailedSends({ limit = 50, failureReason = null } = {}) {
  const sb = getSupabase();
  let query = sb
    .from("crm_email_sends")
    .select("id, contact_id, enrollment_id, campaign_id, sequence_step, subject, body_text, failure_reason")
    .eq("status", "failed")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (failureReason) query = query.eq("failure_reason", failureReason);

  const { data: failed, error } = await query;
  if (error) throw error;

  let queued = 0;
  for (const row of failed || []) {
    const { data: pending } = await sb
      .from("crm_email_send_queue")
      .select("id")
      .eq("contact_id", row.contact_id)
      .eq("sequence_step", row.sequence_step)
      .eq("status", "pending")
      .limit(1);
    if (pending?.length) continue;

    await enqueueSend({
      contactId: row.contact_id,
      subject: row.subject,
      bodyText: row.body_text,
      campaignId: row.campaign_id,
      enrollmentId: row.enrollment_id,
      sequenceStep: row.sequence_step,
      failureReason: row.failure_reason,
      lastError: "Requeued from failed send",
    });
    queued++;
  }
  return { queued, scanned: (failed || []).length };
}

export async function sendContactEmail({
  contactId,
  subject,
  bodyText,
  bodyHtml,
  campaignId,
  enrollmentId,
  sequenceStep,
}) {
  const sb = getSupabase();
  const contact = await loadContact(sb, contactId);
  assertNorthAmericaContact(contact);
  const to = contact.email;
  const from = getFromAddress();

  const dup = await findDuplicateSend(sb, { contactId: contact.id, sequenceStep, subject });
  if (dup) throw duplicateSendError(contact, sequenceStep, dup);

  const { data: sendRow, error: insertErr } = await sb
    .from("crm_email_sends")
    .insert({
      contact_id: contact.id,
      account_id: contact.account_id,
      campaign_id: campaignId || null,
      enrollment_id: enrollmentId || null,
      sequence_step: sequenceStep || null,
      to_email: to,
      from_email: from,
      subject,
      body_text: bodyText,
      status: "queued",
      provider: process.env.RESEND_API_KEY ? "resend" : "smtp",
    })
    .select("id")
    .single();

  if (insertErr) throw insertErr;

  const dupAgain = await findDuplicateSend(sb, {
    contactId: contact.id,
    sequenceStep,
    subject,
  });
  if (dupAgain) {
    await recordSendFailure(sb, sendRow.id, duplicateSendError(contact, sequenceStep, dupAgain));
    throw duplicateSendError(contact, sequenceStep, dupAgain);
  }

  let messageId;
  let provider = "smtp";

  try {
    if (process.env.RESEND_API_KEY && !process.env.SMTP_PASS) {
      provider = "resend";
      const resend = getResend();
      const html =
        bodyHtml || `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(bodyText)}</pre>`;
      const { data: resendData, error: sendErr } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || from,
        to: [to],
        subject,
        text: bodyText,
        html,
        headers: { "X-CRM-Send-Id": sendRow.id },
      });
      if (sendErr) throw new Error(sendErr.message || "Resend send failed");
      messageId = resendData?.id;
    } else {
      const inReplyTo =
        enrollmentId && sequenceStep > 1 ? await getFirstSendMessageId(sb, enrollmentId) : null;
      const result = await sendSmtpEmail({
        to,
        subject,
        bodyText,
        bodyHtml,
        sendId: sendRow.id,
        inReplyTo,
        references: inReplyTo,
      });
      messageId = result.messageId;
      provider = result.provider;
    }
  } catch (err) {
    await recordSendFailure(sb, sendRow.id, err);
    throw err;
  }

  const sentAt = new Date().toISOString();
  await sb
    .from("crm_email_sends")
    .update({
      resend_message_id: provider === "resend" ? messageId : null,
      message_id: messageId,
      provider,
      status: "sent",
      sent_at: sentAt,
      delivered_at: sentAt,
      updated_at: sentAt,
    })
    .eq("id", sendRow.id);

  await sb.from("crm_email_events").insert({
    send_id: sendRow.id,
    event_type: "sent",
    source: provider,
    payload: { message_id: messageId },
  });

  await sb.from("crm_email_events").insert({
    send_id: sendRow.id,
    event_type: "delivered",
    source: provider,
    payload: {},
  });

  const account = contact.crm_accounts;
  if (account?.id && (account.stage === "research" || account.stage === "targeted")) {
    await crmUpdateAccountStage(account.id, "contacted");
  }

  if (enrollmentId && sequenceStep) {
    await advanceEnrollment(sb, enrollmentId, sequenceStep);
  }

  return { send_id: sendRow.id, message_id: messageId, to, subject, provider };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function enrollContact({ contactId, signalBrief, sequenceKey = SEQUENCE_KEY }) {
  const sb = getSupabase();
  const contact = await loadContact(sb, contactId);

  const { data: campaign } = await sb
    .from("crm_email_campaigns")
    .select("id")
    .eq("name", "Concya 5-Touch Hospitality")
    .maybeSingle();

  const { data, error } = await sb
    .from("crm_sequence_enrollments")
    .upsert(
      {
        contact_id: contact.id,
        account_id: contact.account_id,
        campaign_id: campaign?.id || null,
        sequence_key: sequenceKey,
        current_step: 0,
        outreach_status: "active",
        signal_brief: signalBrief || null,
        next_send_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "contact_id,sequence_key" },
    )
    .select("*")
    .single();

  if (error) throw error;
  if (signalBrief) {
    await sb.from("crm_contacts").update({ outreach_notes: signalBrief }).eq("id", contact.id);
  }
  return data;
}

export async function previewSequenceStep({ contactId, step, signalBrief }) {
  const sb = getSupabase();
  const contact = await loadContact(sb, contactId);
  const { data: enrollment } = await sb
    .from("crm_sequence_enrollments")
    .select("signal_brief")
    .eq("contact_id", contactId)
    .eq("sequence_key", SEQUENCE_KEY)
    .maybeSingle();
  const brief = signalBrief || enrollment?.signal_brief || contact.outreach_notes || "";
  return buildTouchContent(contact, Number(step), brief);
}

export async function sendSequenceStep({ contactId, step, previewOnly = false, signalBrief }) {
  const sb = getSupabase();
  const contact = await loadContact(sb, contactId);
  const stepNum = Number(step);
  if (stepNum < 1 || stepNum > 5) throw new Error("step must be 1–5");

  let { data: enrollment } = await sb
    .from("crm_sequence_enrollments")
    .select("*")
    .eq("contact_id", contactId)
    .eq("sequence_key", SEQUENCE_KEY)
    .maybeSingle();

  if (!enrollment) {
    enrollment = await enrollContact({ contactId, signalBrief });
  }

  const brief = signalBrief || enrollment.signal_brief || contact.outreach_notes || "";
  const { subject, body, html } = buildTouchContent(contact, stepNum, brief);

  if (previewOnly) return { subject, body, html, step: stepNum, enrollment_id: enrollment.id };

  const result = await sendContactEmail({
    contactId,
    subject,
    bodyText: body,
    bodyHtml: html,
    campaignId: enrollment.campaign_id,
    enrollmentId: enrollment.id,
    sequenceStep: stepNum,
  });

  return { ...result, subject, body, step: stepNum, enrollment_id: enrollment.id };
}

export async function updateEnrollmentStatus(enrollmentId, outreachStatus) {
  const sb = getSupabase();
  const allowed = new Set(OUTREACH_STATUSES.map((s) => s.id).concat(["queued"]));
  if (!allowed.has(outreachStatus)) throw new Error("Invalid outreach_status");

  const { data, error } = await sb
    .from("crm_sequence_enrollments")
    .update({ outreach_status: outreachStatus, updated_at: new Date().toISOString() })
    .eq("id", enrollmentId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Enrollment not found");

  if (outreachStatus === "meeting" && data.account_id) {
    await crmUpdateAccountStage(data.account_id, "meeting");
  }
  return data;
}

export async function getSequencesBoard({ tier, intent, dueOnly }) {
  const sb = getSupabase();

  const { data: contacts, error: cErr } = await sb
    .from("crm_contacts")
    .select(
      "id, name, email, title, outreach_notes, source_payload, account_id, crm_accounts(group_name, tier, market_name, stage)",
    )
    .not("email", "is", null)
    .neq("email", "")
    .order("enriched_at", { ascending: false, nullsFirst: false })
    .limit(500);

  if (cErr) throw cErr;

  const contactIds = (contacts || []).map((c) => c.id);

  const { data: enrollments } = await sb
    .from("crm_sequence_enrollments")
    .select("*")
    .eq("sequence_key", SEQUENCE_KEY)
    .limit(2000);

  const enrollByContact = Object.fromEntries(
    (enrollments || []).filter((e) => contactIds.includes(e.contact_id)).map((e) => [e.contact_id, e]),
  );

  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const { data: sends } = await sb
    .from("crm_email_sends")
    .select("id, contact_id, status, sequence_step, sent_at, enrollment_id, failure_reason")
    .gte("created_at", since)
    .order("sent_at", { ascending: false })
    .limit(3000);

  const eventsBySend = {};
  const eventsListBySend = {};
  const sendIds = (sends || []).map((s) => s.id);
  if (sendIds.length) {
    const { data: events } = await sb
      .from("crm_email_events")
      .select("send_id, event_type, payload")
      .in("send_id", sendIds);
    for (const e of events || []) {
      if (!eventsBySend[e.send_id]) eventsBySend[e.send_id] = new Set();
      eventsBySend[e.send_id].add(e.event_type);
      if (!eventsListBySend[e.send_id]) eventsListBySend[e.send_id] = [];
      eventsListBySend[e.send_id].push(e);
    }
  }

  const lastSendByContact = {};
  for (const s of sends || []) {
    if (!lastSendByContact[s.contact_id]) lastSendByContact[s.contact_id] = s;
  }

  const cards = [];
  for (const c of contacts || []) {
    if (tier && c.crm_accounts?.tier !== tier) continue;
    const gb = c.source_payload?.gojiberry;
    if (intent && gb?.intent_type !== intent) continue;

    const enrollment = enrollByContact[c.id];
    const lastSend = lastSendByContact[c.id];
    const eventTypes = lastSend ? eventsBySend[lastSend.id] || new Set() : new Set();
    const lastEvents = lastSend ? eventsListBySend[lastSend.id] || [] : [];

    let column = "queue";
    if (enrollment) {
      column = enrollment.outreach_status || "active";
      if (column === "queued") column = "active";
      if (column === "active" && eventTypes.has("opened") && !eventTypes.has("replied")) {
        column = "opened";
      }
    }

    if (lastSend?.status === "failed" || lastSend?.failure_reason) {
      column = enrollment ? "active" : "queue";
    }

    if (dueOnly && enrollment?.next_send_at && new Date(enrollment.next_send_at) > new Date()) continue;

    cards.push({
      contact_id: c.id,
      enrollment_id: enrollment?.id || null,
      name: c.name,
      email: c.email,
      title: c.title,
      company: c.crm_accounts?.group_name,
      tier: c.crm_accounts?.tier,
      market: c.crm_accounts?.market_name,
      account_stage: c.crm_accounts?.stage,
      intent_type: gb?.intent_type || null,
      intent_raw: gb?.intent_raw || null,
      gojiberry_score: gb?.gojiberry_score || null,
      current_step: enrollment?.current_step ?? 0,
      outreach_status: enrollment?.outreach_status || "queue",
      column,
      next_send_at: enrollment?.next_send_at || null,
      last_sent_at: enrollment?.last_sent_at || lastSend?.sent_at || null,
      has_opened: isConfirmedOpen(lastEvents),
      has_open_suspect: eventTypes.has("open_suspect"),
      has_replied: eventTypes.has("replied"),
      has_auto_reply: eventTypes.has("auto_replied"),
      has_failed: lastSend?.status === "failed",
      failure_reason: lastSend?.failure_reason || null,
      has_bounced: eventTypes.has("bounced") || lastSend?.status === "bounced",
      signal_brief: enrollment?.signal_brief || c.outreach_notes || null,
    });
  }

  const buckets = Object.fromEntries(OUTREACH_STATUSES.map((s) => [s.id, []]));
  buckets.queue = [];

  for (const card of cards) {
    const key = buckets[card.column] ? card.column : card.enrollment_id ? "active" : "queue";
    (buckets[key] || buckets.queue).push(card);
  }

  const columns = [
    { id: "queue", label: "Queue", hint: "Has email, not enrolled", count: buckets.queue.length, cards: buckets.queue },
    ...OUTREACH_STATUSES.filter((s) => s.id !== "queue").map((s) => ({
      ...s,
      count: (buckets[s.id] || []).length,
      cards: buckets[s.id] || [],
    })),
  ];

  return { columns, total: cards.length, sequence_steps: SEQUENCE_STEPS };
}

export async function recordTrackingEvent(sendId, eventType, source = "pixel", payload = {}) {
  const sb = getSupabase();
  const { data: send } = await sb
    .from("crm_email_sends")
    .select("id, enrollment_id, contact_id, status, sent_at")
    .eq("id", sendId)
    .maybeSingle();

  if (!send) return { ok: false, reason: "send not found" };

  if (eventType === "opened" && source === "pixel") {
    const classified = classifyOpen({
      sentAt: send.sent_at,
      userAgent: payload.user_agent,
      ip: payload.ip,
    });
    eventType = classified.event_type;
    payload = { ...payload, confidence: classified.confidence, delta_sec: classified.delta_sec };
  }

  const { data: existing } = await sb
    .from("crm_email_events")
    .select("id")
    .eq("send_id", sendId)
    .eq("event_type", eventType)
    .limit(1);

  if (!existing?.length) {
    await sb.from("crm_email_events").insert({
      send_id: sendId,
      event_type: eventType,
      source,
      payload,
    });
  }

  const statusRank = { sent: 1, delivered: 2, open_suspect: 2, opened: 3, clicked: 4, replied: 5, auto_replied: 4 };
  const newStatus = eventType === "open_suspect" ? null : eventType;
  if (newStatus && statusRank[newStatus] && statusRank[newStatus] > (statusRank[send.status] || 0)) {
    await sb
      .from("crm_email_sends")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", sendId);
  }

  if (
    send.enrollment_id &&
    eventType === "opened" &&
    ["high", "medium"].includes(payload.confidence)
  ) {
    const { data: enr } = await sb
      .from("crm_sequence_enrollments")
      .select("outreach_status")
      .eq("id", send.enrollment_id)
      .maybeSingle();
    if (enr && !["replied", "meeting", "completed"].includes(enr.outreach_status)) {
      await sb
        .from("crm_sequence_enrollments")
        .update({ outreach_status: "opened", updated_at: new Date().toISOString() })
        .eq("id", send.enrollment_id);
    }
  }

  return { ok: true, event_type: eventType, confidence: payload.confidence };
}

export function trackingPixelBuffer() {
  return TRANSPARENT_GIF;
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
  let sendId = data.headers?.["x-crm-send-id"];

  if (!sendId && messageId) {
    const { data: row } = await sb
      .from("crm_email_sends")
      .select("id")
      .eq("resend_message_id", messageId)
      .maybeSingle();
    sendId = row?.id;
  }

  if (!sendId) return { ok: true, skipped: true, reason: "no matching send" };
  await recordTrackingEvent(sendId, eventType, "resend", data);

  if (eventType === "bounced") {
    const { data: send } = await sb.from("crm_email_sends").select("account_id, enrollment_id").eq("id", sendId).maybeSingle();
    if (send?.account_id) await crmUpdateAccountStage(send.account_id, "lost");
    if (send?.enrollment_id) await updateEnrollmentStatus(send.enrollment_id, "bounced");
  }

  return { ok: true, send_id: sendId, event_type: eventType };
}

export async function getEmailStats() {
  const sb = getSupabase();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  const [
    { count: enrolled },
    { data: sends },
    { count: queuePending },
    { data: recent },
  ] = await Promise.all([
    sb.from("crm_sequence_enrollments").select("*", { count: "exact", head: true }),
    sb
      .from("crm_email_sends")
      .select("id, status, failure_reason, sent_at, delivered_at")
      .gte("created_at", since),
    sb
      .from("crm_email_send_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    sb
      .from("crm_email_sends")
      .select(
        "id, to_email, subject, status, sent_at, sequence_step, failure_reason, error_message, contact_id, crm_contacts(name, crm_accounts(group_name))",
      )
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const sendIds = (sends || []).map((s) => s.id);
  let events = [];
  if (sendIds.length) {
    const { data: ev } = await sb.from("crm_email_events").select("send_id, event_type, payload").in("send_id", sendIds);
    events = ev || [];
  }

  const health = computeDeliveryHealth(sends || [], events);
  const meetings =
    (await sb.from("crm_sequence_enrollments").select("*", { count: "exact", head: true }).eq("outreach_status", "meeting"))
      .count ?? 0;

  return {
    ...health,
    total_sends: health.attempted,
    enrolled: enrolled ?? 0,
    meetings,
    queue_pending: queuePending ?? 0,
    open_rate: health.open_rate_confirmed,
    bounce_rate: health.attempted > 0 ? Math.round((health.bounced / health.attempted) * 100) : 0,
    recent: (recent || []).map((r) => ({
      id: r.id,
      to_email: r.to_email,
      subject: r.subject,
      status: r.status,
      failure_reason: r.failure_reason,
      error_message: r.error_message,
      sent_at: r.sent_at,
      sequence_step: r.sequence_step,
      contact_name: r.crm_contacts?.name,
      company: r.crm_contacts?.crm_accounts?.group_name,
    })),
  };
}

export async function getContactEmailTimeline(contactId) {
  const sb = getSupabase();
  const { data: sends, error } = await sb
    .from("crm_email_sends")
    .select(
      "id, subject, status, sent_at, to_email, created_at, sequence_step, failure_reason, error_message, crm_email_events(id, event_type, occurred_at, source, payload)",
    )
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const { data: enrollment } = await sb
    .from("crm_sequence_enrollments")
    .select("*")
    .eq("contact_id", contactId)
    .eq("sequence_key", SEQUENCE_KEY)
    .maybeSingle();

  return { sends: sends || [], enrollment };
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

  const [{ data: sends }, { data: enrollments }] = await Promise.all([
    sb.from("crm_email_sends").select("contact_id, status, sent_at, sequence_step").in("contact_id", contactIds).order("sent_at", { ascending: false }),
    sb.from("crm_sequence_enrollments").select("contact_id, current_step, outreach_status").in("contact_id", contactIds),
  ]);

  const lastByContact = {};
  for (const s of sends || []) {
    if (!lastByContact[s.contact_id]) lastByContact[s.contact_id] = s;
  }
  const enrollByContact = Object.fromEntries((enrollments || []).map((e) => [e.contact_id, e]));

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
    current_step: enrollByContact[c.id]?.current_step ?? 0,
    outreach_status: enrollByContact[c.id]?.outreach_status || null,
  }));
}

export async function recordAutoReply({ sendId, payload }) {
  const sb = getSupabase();
  const { data: existing } = await sb
    .from("crm_email_events")
    .select("id")
    .eq("send_id", sendId)
    .eq("event_type", "auto_replied")
    .limit(1);
  if (existing?.length) return { ok: true, duplicate: true };

  await recordTrackingEvent(sendId, "auto_replied", "himalaya", payload || {});
  return { ok: true };
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

  await recordTrackingEvent(sendId, "replied", "himalaya", payload || {});

  const { data: send } = await sb
    .from("crm_email_sends")
    .select("account_id, enrollment_id, contact_id")
    .eq("id", sendId)
    .maybeSingle();

  if (send?.account_id) await crmUpdateAccountStage(send.account_id, "connected");
  if (send?.enrollment_id) await updateEnrollmentStatus(send.enrollment_id, "replied");

  return { ok: true };
}

export async function getRecentSendsForSync(days = 14) {
  const sb = getSupabase();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb
    .from("crm_email_sends")
    .select("id, to_email, subject, sent_at, message_id")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function saveContactSignalBrief(contactId, signalBrief) {
  const sb = getSupabase();
  await sb.from("crm_contacts").update({ outreach_notes: signalBrief }).eq("id", contactId);
  const { data: enrollment } = await sb
    .from("crm_sequence_enrollments")
    .select("id")
    .eq("contact_id", contactId)
    .maybeSingle();
  if (enrollment?.id) {
    await sb
      .from("crm_sequence_enrollments")
      .update({ signal_brief: signalBrief, updated_at: new Date().toISOString() })
      .eq("id", enrollment.id);
  }
  return { ok: true };
}
