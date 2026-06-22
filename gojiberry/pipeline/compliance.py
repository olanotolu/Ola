"""Stage 8: compliance gates."""
from __future__ import annotations

import sqlite3


def load_suppression(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT email FROM suppression").fetchall()
    return {r[0].lower() for r in rows if r[0]}


def compliance_check(row: dict, suppression: set[str], min_confidence: float) -> dict:
    enr = row.get("enrichment") or {}
    email = (enr.get("email") or "").lower()
    blocked_reasons: list[str] = []

    if email and email in suppression:
        blocked_reasons.append("suppression_list")
    if row.get("casl_flag"):
        blocked_reasons.append("casl_requires_consent_path")
    conf = enr.get("email_confidence", 0)
    contactable = enr.get("contactable") or row.get("profile_resolved")
    if not contactable:
        blocked_reasons.append("below_contactability_threshold")
    if enr.get("email") and conf < min_confidence and enr.get("email_status") == "unverified_guess":
        blocked_reasons.append("unverified_guessed_email")

    approved = len([b for b in blocked_reasons if b not in ("casl_requires_consent_path",)]) == 0 or (
        row.get("profile_resolved") and not email
    )
    # CASL: flag but allow LinkedIn-only path
    outreach_allowed = contactable and "suppression_list" not in blocked_reasons and "below_contactability_threshold" not in blocked_reasons

    return {
        "outreach_allowed": outreach_allowed,
        "casl_flag": row.get("casl_flag", False),
        "blocked_reasons": blocked_reasons,
        "channel_email_ok": outreach_allowed and email and "unverified_guessed_email" not in blocked_reasons,
        "channel_linkedin_ok": outreach_allowed and row.get("profile_resolved"),
    }
