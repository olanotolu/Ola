import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToHtml(text) {
  return `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#111">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

export function getCrmPublicUrl() {
  return (process.env.CRM_PUBLIC_URL || "http://localhost:3200").replace(/\/$/, "");
}

export function injectTracking(html, sendId) {
  const base = getCrmPublicUrl();
  const pixel = `<img src="${base}/api/email/track/open/${sendId}.png" width="1" height="1" alt="" style="display:none" />`;
  let out = html.replace(
    /<a\s+([^>]*href=["'])(https?:\/\/[^"']+)(["'][^>]*)>/gi,
    (_m, pre, url, post) => {
      const tracked = `${base}/api/email/track/click/${sendId}?u=${encodeURIComponent(url)}`;
      return `<a ${pre}${tracked}${post}>`;
    },
  );
  if (!out.includes(pixel)) out += pixel;
  return out;
}

export function createTransport() {
  const host = process.env.SMTP_HOST || "smtp.ionos.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error("Missing SMTP_USER or SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    requireTLS: port === 587,
  });
}

export function getFromAddress() {
  return process.env.SMTP_FROM || "Olaoluwasubomi <olaolu@concya.com>";
}

export function getCcAddresses() {
  return [];
}

export function getBccAddresses() {
  const raw = process.env.SMTP_BCC || process.env.SMTP_CC || "partnerships@concya.com";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sendSmtpEmail({
  to,
  subject,
  bodyText,
  bodyHtml,
  sendId,
  inReplyTo,
  references,
  cc,
  bcc,
}) {
  const transport = createTransport();
  const from = getFromAddress();
  const messageId = `<crm-${sendId || randomUUID()}@concya.com>`;
  const html = injectTracking(bodyHtml || textToHtml(bodyText), sendId);
  const bccList = bcc ?? getBccAddresses();

  const info = await transport.sendMail({
    from,
    to,
    bcc: bccList.length ? bccList : undefined,
    subject,
    text: bodyText,
    html,
    messageId,
    inReplyTo: inReplyTo || undefined,
    references: references || inReplyTo || undefined,
    headers: sendId ? { "X-CRM-Send-Id": sendId } : undefined,
  });

  return {
    messageId: info.messageId || messageId,
    provider: "smtp",
    from,
  };
}
