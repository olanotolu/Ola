"""Stage 5: segmentation tags."""
from __future__ import annotations

TZ_MAP = {
    "georgia": "America/New_York", "florida": "America/New_York", "texas": "America/Chicago",
    "california": "America/Los_Angeles", "washington": "America/Los_Angeles",
    "arizona": "America/Phoenix", "nevada": "America/Los_Angeles", "wisconsin": "America/Chicago",
    "illinois": "America/Chicago", "kansas": "America/Chicago", "colorado": "America/Denver",
    "canada": "America/Toronto",
}


def _company_structure(company: str) -> str:
    c = (company or "").lower()
    if any(x in c for x in ("management", "companies", "group", "hospitality companies")):
        return "management_company"
    if any(x in c for x in ("hilton", "marriott", "hyatt", "hampton", "westin", "andaz", "sheraton")):
        return "branded_chain"
    if "inn" in c or "hotel" in c or "resort" in c:
        return "single_property"
    return "unknown"


def segment_row(row: dict) -> dict:
    loc = row.get("location") or {}
    region = (loc.get("region") or loc.get("country") or "").lower()
    tz = TZ_MAP.get(region, "America/New_York")
    return {
        "segment_industry": row.get("canonical_industry"),
        "segment_intent": row.get("intent_type"),
        "segment_seniority": row.get("seniority_tier"),
        "segment_company_structure": _company_structure(row.get("company", "")),
        "segment_timezone": tz,
        "segment_geo": loc.get("country") or "unknown",
    }
