"""Stage 7: multi-touch sequence assignment."""
from __future__ import annotations

SEQUENCE_LINKEDIN_FIRST = [
    {"day": 0, "channel": "linkedin", "action": "connect", "template": "linkedin_message"},
    {"day": 2, "channel": "email", "action": "email_1", "template": "email_message"},
    {"day": 5, "channel": "email", "action": "follow_up", "template": "email_message"},
    {"day": 9, "channel": "linkedin", "action": "breakup", "template": "linkedin_message"},
]

SEQUENCE_EMAIL_FIRST = [
    {"day": 0, "channel": "email", "action": "email_1", "template": "email_message"},
    {"day": 3, "channel": "linkedin", "action": "connect", "template": "linkedin_message"},
    {"day": 7, "channel": "email", "action": "follow_up", "template": "email_message"},
]


def assign_sequence(row: dict, messages: dict) -> dict:
    enr = row.get("enrichment") or {}
    has_verified_email = enr.get("email") and enr.get("email_status") != "unverified_guess"
    seq = SEQUENCE_EMAIL_FIRST if has_verified_email else SEQUENCE_LINKEDIN_FIRST
    tz = (row.get("segments") or {}).get("segment_timezone", "America/New_York")
    return {
        "sequence_name": "email_first" if has_verified_email else "linkedin_first",
        "steps": seq,
        "send_timezone": tz,
        "preferred_send_hour_local": 9 if row.get("seniority_tier") in ("exec", "director") else 10,
    }
