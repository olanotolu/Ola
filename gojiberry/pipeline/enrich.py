"""Stage 3: contact enrichment via GetLeads + pattern guessing."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Protocol

import requests
from dotenv import load_dotenv

from .db import get_cached_enrichment, set_cached_enrichment

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "getleads" / ".env.getleads", override=False)


class EnrichmentProvider(Protocol):
    def enrich_person(self, row: dict) -> dict: ...


def _email_patterns(first: str, last: str, domain: str) -> list[tuple[str, float]]:
    f = re.sub(r"[^a-z]", "", (first or "").lower())
    l = re.sub(r"[^a-z]", "", (last or "").lower())
    if not f or not l or not domain:
        return []
    return [
        (f"{f}.{l}@{domain}", 0.55),
        (f"{f}{l}@{domain}", 0.45),
        (f"{f[0]}{l}@{domain}", 0.5),
        (f"{f}@{domain}", 0.35),
        (f"{l}@{domain}", 0.3),
    ]


class GetLeadsProvider:
  def __init__(self, dry_run: bool = False):
    self.dry_run = dry_run
    self.api_key = os.getenv("GETLEADS_API_KEY", "")
    self.base = os.getenv("GETLEADS_BASE_URL", "https://app.getleads.io").rstrip("/")
    self.credits_used = 0

  def _post(self, path: str, body: dict) -> dict:
    if self.dry_run:
      return {"dry_run": True, "results": []}
    for attempt in range(4):
      r = requests.post(
        f"{self.base}{path}",
        json=body,
        headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        timeout=60,
      )
      if r.status_code == 429:
        time.sleep(2 ** attempt)
        continue
      r.raise_for_status()
      return r.json()
    return {"error": "rate_limited"}

  def _extract_hit(self, data: dict) -> dict:
    items = data.get("results") or data.get("items") or data.get("data") or []
    if not items:
      return {}
    hit = items[0] if isinstance(items, list) else items
    inner = hit.get("data") or hit
    return {
      "email": hit.get("email") or inner.get("email_address") or inner.get("email"),
      "phone": inner.get("cellphone") or inner.get("phone"),
      "email_status": inner.get("email_status") or hit.get("email_status"),
      "raw": hit,
    }

  def enrich_person(self, row: dict) -> dict:
    profile = row.get("profile_url") or ""
    if profile and row.get("profile_resolved"):
      data = self._post("/api/v1/enrich/from-linkedin", {"items": [{"linkedin_url": profile}], "limit_per_item": 1})
      if data.get("error"):
        return {}
      parsed = self._extract_hit(data)
      self.credits_used += data.get("query_credits_used") or data.get("queryCreditsUsed") or (0 if self.dry_run else 1)
      if parsed.get("email"):
        status = (parsed.get("email_status") or "").upper()
        conf = 0.92 if status == "VALID" else 0.8 if status else 0.75
        return {
          "email": parsed["email"],
          "email_confidence": conf,
          "email_source": "getleads_linkedin",
          "email_status": parsed.get("email_status") or "unknown",
          "phone": parsed.get("phone"),
          "raw": parsed.get("raw"),
        }
    body = {
      "items": [{
        "first_name": row.get("first_name"),
        "last_name": row.get("clean_last_name"),
        "company_name": row.get("company"),
        "company_domain": row.get("apex_domain"),
      }]
    }
    data = self._post("/api/v1/enrich/from-person", body)
    if data.get("error"):
      return {}
    parsed = self._extract_hit(data)
    self.credits_used += data.get("query_credits_used") or data.get("queryCreditsUsed") or (0 if self.dry_run else 1)
    if parsed.get("email"):
      status = (parsed.get("email_status") or "").upper()
      conf = 0.88 if status == "VALID" else 0.72
      return {
        "email": parsed["email"],
        "email_confidence": conf,
        "email_source": "getleads_person",
        "email_status": parsed.get("email_status") or "unknown",
        "phone": parsed.get("phone"),
        "raw": parsed.get("raw"),
      }
    return {}


def verify_email_local(email: str) -> dict:
    """Lightweight syntax check; real verification would call Hunter/NeverBounce."""
    ok = bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email or ""))
    return {"verified": ok, "method": "syntax", "confidence": 0.7 if ok else 0.0}


def enrich_row(row: dict, provider: EnrichmentProvider, conn, cache_key: str) -> dict:
    cached = get_cached_enrichment(conn, cache_key)
    if cached:
        return {**cached, "from_cache": True}

    result = provider.enrich_person(row) if not isinstance(provider, type) else {}
    if not result.get("email") and row.get("apex_domain"):
        for guess, conf in _email_patterns(row.get("first_name", ""), row.get("clean_last_name", ""), row["apex_domain"]):
            v = verify_email_local(guess)
            if v["verified"]:
                result = {
                    "email": guess,
                    "email_confidence": conf * v["confidence"],
                    "email_source": "pattern_guess",
                    "email_status": "unverified_guess",
                }
                break

    if result.get("email") and result.get("email_status", "").upper() == "VALID":
        result["email_verified"] = True
        result["email_confidence"] = max(result.get("email_confidence", 0.5), 0.9)
    elif result.get("email") and result.get("email_status") != "unverified_guess":
        v = verify_email_local(result["email"])
        result["email_verified"] = v["verified"]
        result["email_confidence"] = min(result.get("email_confidence", 0.5), v["confidence"] + 0.15)

    result["contactable"] = bool(
        result.get("email") and result.get("email_confidence", 0) >= float(os.getenv("MIN_ENRICHMENT_CONFIDENCE", "0.45"))
    ) or bool(row.get("profile_resolved"))

    set_cached_enrichment(conn, cache_key, os.getenv("ENRICHMENT_PROVIDER", "getleads"), result, getattr(provider, "credits_used", 0))
    return result


def enrich_all(rows: list[dict], conn, dry_run: bool = False) -> list[dict]:
    from .db import source_key

    provider = GetLeadsProvider(dry_run=dry_run)
    out = []
    for row in rows:
        key = f"enrich:{source_key(row)}"
        enr = enrich_row(row, provider, conn, key)
        merged = {**row, "enrichment": enr}
        out.append(merged)
        if not dry_run:
            time.sleep(0.35)
    return out
