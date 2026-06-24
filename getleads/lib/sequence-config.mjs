export const SEQUENCE_KEY = "concya_5_touch";

import { buildGmOutreachEmail, buildGmTouch2Email } from "./outreach-template.mjs";

export const OUTREACH_STATUSES = [
  { id: "queue", label: "Queue", hint: "Has email, not enrolled" },
  { id: "active", label: "In sequence", hint: "Touches 1–5 in progress" },
  { id: "opened", label: "Opened", hint: "Opened, no reply yet" },
  { id: "replied", label: "Replied", hint: "Reply detected" },
  { id: "meeting", label: "Meeting", hint: "Call or demo scheduled" },
  { id: "completed", label: "Done", hint: "Sequence complete or closed" },
  { id: "paused", label: "Paused", hint: "Paused manually" },
  { id: "bounced", label: "Bounced", hint: "Delivery failed" },
];

export const SEQUENCE_STEPS = [
  { step: 1, day_offset: 0, label: "Signal", purpose: "Personalized opener from research signal" },
  { step: 2, day_offset: 3, label: "Problem", purpose: "Pain angle tied to their role" },
  { step: 3, day_offset: 7, label: "Proof", purpose: "Demo / outcome offer" },
  { step: 4, day_offset: 12, label: "Bump", purpose: "Property-specific follow-up" },
  { step: 5, day_offset: 18, label: "Close", purpose: "Polite close-the-loop" },
];

const PRODUCT = "Concya";
const SENDER = "Ola";

function firstName(name) {
  return (name || "there").split(/\s+/)[0];
}

function intentType(contact) {
  return contact?.source_payload?.gojiberry?.intent_type || "unknown";
}

function company(contact) {
  return contact?.crm_accounts?.group_name || contact?.company || "your property";
}

function valueLine(title) {
  const t = (title || "").toLowerCase();
  if (/vp|director|president|chief/.test(t)) {
    return `${PRODUCT} sits on top of what you already use — one agentic voice layer for guest ops and staff routing across properties.`;
  }
  return `${PRODUCT} cuts the back-and-forth between front desk, housekeeping, and F&B when something breaks mid-shift.`;
}

function opener(contact) {
  const first = firstName(contact.name);
  const co = company(contact);
  const intent = intentType(contact);
  const gb = contact?.source_payload?.gojiberry || {};
  if (intent === "just_hired") return `Hi ${first} — congrats on the new role at ${co}.`;
  if (intent === "top_active") return `Hi ${first} — you're clearly active in hospitality ops on LinkedIn.`;
  if (gb.intent_raw) return `Hi ${first} — ${gb.intent_raw.toLowerCase().includes("hired") ? `congrats on the move at ${co}` : `quick note on ${co}`}.`;
  return `Hi ${first} — quick note on ${co}.`;
}

export function buildTouchContent(contact, step, signalBrief) {
  const first = firstName(contact.name);
  const co = company(contact);
  const val = valueLine(contact.title);
  const brief = (signalBrief || contact?.outreach_notes || "").trim();

  const subjects = {
    1: brief.match(/Subject options?:[\s\S]*?`([^`]+)`/i)?.[1] || `Quick thought for ${co}`,
    2: `Guest ops at ${co}`,
    3: `${PRODUCT} — 10-min live look`,
    4: `Before your next busy week`,
    5: `Close the loop?`,
  };

  if (step === 1 && brief.includes("## Email 1")) {
    const match = brief.match(/## Email 1[\s\S]*?```\n([\s\S]*?)```/);
    if (match) return { subject: subjects[1], body: match[1].trim() };
  }

  if (step === 1) {
    const gm = buildGmOutreachEmail(first);
    return { subject: gm.subject, body: gm.bodyText, html: gm.bodyHtml };
  }

  if (step === 2) {
    const t2 = buildGmTouch2Email(first);
    return { subject: t2.subject, body: t2.bodyText, html: t2.bodyHtml };
  }

  const bodies = {
    3: `Hi ${first},\n\nWe built ${PRODUCT} for mixed hospitality portfolios — boutique, flagged, and extended-stay — without forcing one workflow.\n\nHappy to show a 10-minute live demo on a guest call → housekeeping route. No deck.\n\n${SENDER}`,
    4: `Hi ${first},\n\nStill open to a quick walkthrough this week? The best time to fix guest-comms ops is before the next busy season, not after the first bad review.\n\n${SENDER}`,
    5: `Hi ${first},\n\nI know inboxes are a firehose — if guest ops AI isn't a priority right now, no worries. Should I check back next quarter, or is this a "not for us"?\n\nEither way, appreciate your time.\n${SENDER}`,
  };

  return { subject: subjects[step] || `Touch ${step} — ${co}`, body: bodies[step] || bodies[2] };
}

export function nextSendAt(step) {
  const def = SEQUENCE_STEPS.find((s) => s.step === step + 1);
  if (!def) return null;
  return new Date(Date.now() + def.day_offset * 86400000).toISOString();
}
