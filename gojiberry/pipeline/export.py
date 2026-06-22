"""Stage 9: export to Gojiberry schema + reporting."""
from __future__ import annotations

import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

GOJIBERRY_COLUMNS = [
    "First Name", "Last Name", "Email", "Email 2", "Email 3",
    "Phone", "Phone 2", "Phone 3", "Location", "Job Title", "Industry",
    "Company", "Company URL", "Website", "Import Date", "Intent",
    "Profile URL", "Total Score", "Intent Keyword",
    "Personnalized Email message", "Personnalized LinkedIn message",
]


def row_to_export(raw: dict, processed: dict) -> dict:
    enr = processed.get("enrichment") or {}
    comp = processed.get("compliance") or {}
    msgs = processed.get("messages") or {}
    blocked = not comp.get("outreach_allowed")

    email = enr.get("email", "") if comp.get("channel_email_ok") else ""
    if comp.get("outreach_allowed"):
        li_msg = msgs.get("linkedin_message", "")
        em_msg = msgs.get("email_message", "")
    else:
        li_msg = ""
        em_msg = ""

    if blocked and not li_msg and not em_msg:
        flag = "[BLOCKED: " + ", ".join(comp.get("blocked_reasons", [])) + "]"
        if processed.get("profile_resolved"):
            li_msg = flag
        else:
            em_msg = flag

    return {
        "First Name": raw.get("First Name", processed.get("first_name", "")),
        "Last Name": raw.get("Last Name", processed.get("last_name_raw", "")),
        "Email": email or raw.get("Email", ""),
        "Email 2": raw.get("Email 2", ""),
        "Email 3": raw.get("Email 3", ""),
        "Phone": enr.get("phone") or raw.get("Phone", ""),
        "Phone 2": raw.get("Phone 2", ""),
        "Phone 3": raw.get("Phone 3", ""),
        "Location": raw.get("Location", (processed.get("location") or {}).get("raw", "")),
        "Job Title": raw.get("Job Title", processed.get("job_title", "")),
        "Industry": raw.get("Industry", processed.get("industry_raw", "")),
        "Company": raw.get("Company", processed.get("company", "")),
        "Company URL": raw.get("Company URL", processed.get("company_url", "")),
        "Website": raw.get("Website", processed.get("website", "")),
        "Import Date": raw.get("Import Date", ""),
        "Intent": raw.get("Intent", processed.get("intent_raw", "")),
        "Profile URL": raw.get("Profile URL", processed.get("profile_url", "")),
        "Total Score": raw.get("Total Score", processed.get("gojiberry_score", "")),
        "Intent Keyword": raw.get("Intent Keyword", processed.get("intent_keyword", "")),
        "Personnalized Email message": em_msg,
        "Personnalized LinkedIn message": li_msg,
    }


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=GOJIBERRY_COLUMNS)
        w.writeheader()
        w.writerows(rows)


def build_report(processed: list[dict], before_contactable: int, total: int) -> dict:
    after_email = sum(1 for r in processed if (r.get("enrichment") or {}).get("email"))
    after_contactable = sum(1 for r in processed if (r.get("enrichment") or {}).get("contactable") or r.get("profile_resolved"))
    intent_ctr = Counter(r.get("intent_type") for r in processed)
    segment_ctr = Counter((r.get("segments") or {}).get("segment_intent") for r in processed)
    scores = [r.get("scores", {}).get("priority_score", 0) for r in processed]
    blocked = sum(1 for r in processed if not (r.get("compliance") or {}).get("outreach_allowed"))
    casl = sum(1 for r in processed if r.get("casl_flag"))
    urn = sum(1 for r in processed if r.get("profile_urn"))

    top10 = sorted(processed, key=lambda x: x.get("scores", {}).get("priority_score", 0), reverse=True)[:10]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_rows": total,
        "contactability_before_pct": round(100 * before_contactable / max(total, 1), 1),
        "contactability_after_pct": round(100 * after_contactable / max(total, 1), 1),
        "emails_discovered": after_email,
        "intent_breakdown": dict(intent_ctr),
        "segment_breakdown": dict(segment_ctr),
        "blocked_outreach": blocked,
        "casl_flagged": casl,
        "urn_profiles": urn,
        "priority_score_avg": round(sum(scores) / max(len(scores), 1), 1),
        "top_10_leads": [
            {
                "name": r.get("display_name"),
                "company": r.get("company"),
                "score": r.get("scores", {}).get("priority_score"),
                "intent": r.get("intent_type"),
                "email": (r.get("enrichment") or {}).get("email"),
            }
            for r in top10
        ],
    }


def write_report(report: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2))
