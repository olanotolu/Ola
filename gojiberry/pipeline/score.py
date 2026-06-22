"""Stage 4: composite priority scoring."""
from __future__ import annotations

from datetime import datetime, timezone

SENIORITY_W = {"exec": 1.0, "director": 0.85, "manager": 0.7, "ic": 0.5}
INTENT_W = {
    "just_hired": 1.0,
    "linkedin_post": 0.9,
    "author_post": 0.88,
    "top_active": 0.75,
    "lookalike": 0.55,
    "unknown": 0.4,
}
INDUSTRY_W = {"hospitality": 1.0, "restaurants": 0.9, "travel_tourism": 0.85, "other": 0.5}


def _recency(import_date: str | None) -> float:
    if not import_date:
        return 0.5
    try:
        dt = datetime.fromisoformat(import_date.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        days = (datetime.now(timezone.utc) - dt).days
        return max(0.2, 1.0 - days / 30)
    except ValueError:
        return 0.5


def score_row(row: dict) -> dict:
    enr = row.get("enrichment") or {}
    seniority = SENIORITY_W.get(row.get("seniority_tier", "ic"), 0.5)
    intent = INTENT_W.get(row.get("intent_type", "unknown"), 0.4)
    industry = INDUSTRY_W.get(row.get("canonical_industry", "other"), 0.5)
    recency = _recency(row.get("import_date"))
    goji = (row.get("gojiberry_score") or 2.0) / 2.3
    enrich_conf = enr.get("email_confidence", 0.3 if row.get("profile_resolved") else 0.1)
    keyword_boost = 0.08 if row.get("intent_keyword") else 0.0

    priority = (
        seniority * 0.25
        + intent * 0.28
        + industry * 0.12
        + recency * 0.15
        + goji * 0.05
        + enrich_conf * 0.15
        + keyword_boost
    )
    return {
        "priority_score": round(priority * 100, 1),
        "components": {
            "seniority": round(seniority, 3),
            "intent": round(intent, 3),
            "industry": round(industry, 3),
            "recency": round(recency, 3),
            "gojiberry_norm": round(goji, 3),
            "enrichment_confidence": round(enrich_conf, 3),
            "keyword_boost": keyword_boost,
        },
    }
