"""Stage 2: deduplication and data quality."""
from __future__ import annotations

from difflib import SequenceMatcher


def _key_name_company(row: dict) -> str:
    fn = (row.get("first_name") or "").strip().lower()
    ln = (row.get("clean_last_name") or "").strip().lower()
    co = (row.get("company") or "").strip().lower()
    return f"{fn}|{ln}|{co}"


def _key_profile(row: dict) -> str | None:
    if row.get("profile_resolved") and row.get("profile_url"):
        return row["profile_url"].strip().lower()
    return None


def company_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def dedupe(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return (unique_rows, duplicate_log)."""
    seen_name: dict[str, int] = {}
    seen_profile: dict[str, int] = {}
    unique: list[dict] = []
    dupes: list[dict] = []

    for i, row in enumerate(rows):
        nk = _key_name_company(row)
        pk = _key_profile(row)
        dup_of = None
        if nk in seen_name:
            dup_of = seen_name[nk]
        elif pk and pk in seen_profile:
            dup_of = seen_profile[pk]
        if dup_of is not None:
            dupes.append({"row_index": i, "duplicate_of": dup_of, "key": nk or pk})
            continue
        seen_name[nk] = len(unique)
        if pk:
            seen_profile[pk] = len(unique)
        unique.append(row)
    return unique, dupes


def quality_scorecard(row: dict) -> dict:
    fields = [
        "first_name", "clean_last_name", "job_title", "company",
        "profile_url", "website", "apex_domain", "intent_keyword",
    ]
    filled = sum(1 for f in fields if row.get(f))
    completeness = round(filled / len(fields), 2)
    flags: list[str] = []
    if not row.get("profile_resolved"):
        flags.append("urn_profile")
    if not row.get("website") and (row.get("apex_domain_confidence") or 0) < 0.5:
        flags.append("no_domain")
    if not row.get("profile_url") and not row.get("apex_domain"):
        flags.append("low_enrichability")
    if row.get("casl_flag"):
        flags.append("casl")
    return {
        "completeness_pct": completeness,
        "quality_flags": flags,
        "enrichability": "low" if "low_enrichability" in flags else "medium" if flags else "high",
    }
