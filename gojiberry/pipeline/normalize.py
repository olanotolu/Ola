"""Stage 1: ingestion and normalization."""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

EXPECTED_COLUMNS = [
    "First Name", "Last Name", "Email", "Email 2", "Email 3",
    "Phone", "Phone 2", "Phone 3", "Location", "Job Title", "Industry",
    "Company", "Company URL", "Website", "Import Date", "Intent",
    "Profile URL", "Total Score", "Intent Keyword",
    "Personnalized Email message", "Personnalized LinkedIn message",
]

CREDENTIALS = set()
_cred_path = Path(__file__).resolve().parent.parent / "config" / "credentials.txt"
if _cred_path.exists():
    CREDENTIALS = {x.strip().rstrip(",") for x in _cred_path.read_text().split(",") if x.strip()}

INDUSTRY_MAP: dict[str, str] = {}
_map_path = Path(__file__).resolve().parent.parent / "config" / "industry_map.json"
if _map_path.exists():
    INDUSTRY_MAP = json.loads(_map_path.read_text())


class IntentHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.href: str | None = None
        self.in_anchor = False
        self.anchor_text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.in_anchor = True
            for k, v in attrs:
                if k == "href":
                    self.href = v

    def handle_endtag(self, tag):
        if tag == "a":
            self.in_anchor = False

    def handle_data(self, data):
        if self.in_anchor:
            self.anchor_text.append(data)


def split_name(last_name: str) -> tuple[str, str]:
    raw = (last_name or "").strip()
    if not raw:
        return "", ""
    if "," in raw:
        name_part, cred_part = raw.split(",", 1)
        creds = cred_part.strip()
        return name_part.strip(), creds
    for cred in sorted(CREDENTIALS, key=len, reverse=True):
        if raw.endswith(f" {cred}"):
            return raw[: -len(cred)].strip().rstrip(","), cred
        if raw.endswith(cred):
            return raw[: -len(cred)].strip().rstrip(","), cred
    return raw, ""


def parse_location(loc: str) -> dict:
    loc = (loc or "").strip()
    parts = [p.strip() for p in loc.split(",")]
    city, region, country = "", "", ""
    if len(parts) >= 3:
        city, region, country = parts[0], parts[1], parts[2]
    elif len(parts) == 2:
        city, country = parts[0], parts[1]
    elif len(parts) == 1:
        country = parts[0]
    metro = "metropolitan" in city.lower() or "greater" in city.lower() or "metroplex" in city.lower()
    return {
        "city": city,
        "region": region,
        "country": country,
        "is_metro": metro,
        "raw": loc,
    }


def classify_intent(intent_raw: str, parser: IntentHTMLParser) -> dict:
    text = intent_raw or ""
    post_url = parser.href
    post_author = "".join(parser.anchor_text).strip() if parser.anchor_text else None

    if "post written by" in text.lower():
        itype = "author_post"
    elif text.startswith("Just engaged with a <a") or "Just engaged with a <a" in text:
        itype = "linkedin_post"
    elif "Lookalike" in text:
        itype = "lookalike"
    elif "Just hired" in text:
        itype = "just_hired"
    elif "Top 5%" in text:
        itype = "top_active"
    else:
        itype = "unknown"

    return {
        "intent_type": itype,
        "intent_raw": text,
        "post_url": post_url,
        "post_author": post_author if itype == "author_post" else None,
    }


def apex_domain(website: str, company: str) -> tuple[str | None, float]:
    w = (website or "").strip().lower()
    if w:
        if not w.startswith("http"):
            w = "https://" + w
        host = urlparse(w).netloc or urlparse(w).path
        host = host.replace("www.", "")
        if host:
            return host, 0.95
    # guess from company
    slug = re.sub(r"\b(inc|llc|ltd|corp|co|group|hotels?|hospitality)\b\.?", "", company or "", flags=re.I)
    slug = re.sub(r"[^a-z0-9]+", "", slug.lower())
    if len(slug) >= 3:
        return f"{slug}.com", 0.35
    return None, 0.0


def profile_format(url: str) -> dict:
    u = (url or "").strip().lower()
    urn = bool(re.search(r"/in/(aco|acw)", u))
    vanity = bool(u and not urn and "/in/" in u)
    return {"profile_url": url, "profile_urn": urn, "profile_resolved": vanity}


def seniority_tier(title: str) -> str:
    t = (title or "").lower()
    if any(x in t for x in ("ceo", "coo", "cto", "cfo", "president", "chief", "evp", "executive vice")):
        return "exec"
    if any(x in t for x in ("vice president", "vp ", "svp", "regional director")):
        return "director"
    if any(x in t for x in ("director", "head of")):
        return "director"
    if any(x in t for x in ("manager", "gm", "general manager")):
        return "manager"
    return "ic"


def clean_keyword(kw: str) -> str:
    return (kw or "").strip().strip('"')


def normalize_row(row: dict) -> dict:
    parser = IntentHTMLParser()
    parser.feed(row.get("Intent", "") or "")
    intent = classify_intent(row.get("Intent", ""), parser)
    clean_last, credentials = split_name(row.get("Last Name", ""))
    loc = parse_location(row.get("Location", ""))
    domain, domain_conf = apex_domain(row.get("Website", ""), row.get("Company", ""))
    profile = profile_format(row.get("Profile URL", ""))
    industry_raw = row.get("Industry", "")
    canonical_industry = INDUSTRY_MAP.get(industry_raw, "other")

    try:
        import_date = datetime.strptime(row.get("Import Date", ""), "%b %d, %Y %I:%M %p")
    except ValueError:
        import_date = None

    out = {
        "first_name": (row.get("First Name") or "").strip(),
        "last_name_raw": row.get("Last Name", ""),
        "clean_last_name": clean_last,
        "credentials": credentials,
        "display_name": f"{(row.get('First Name') or '').strip()} {clean_last}".strip(),
        "job_title": (row.get("Job Title") or "").strip(),
        "seniority_tier": seniority_tier(row.get("Job Title", "")),
        "company": (row.get("Company") or "").strip(),
        "company_url": (row.get("Company URL") or "").strip(),
        "website": (row.get("Website") or "").strip(),
        "apex_domain": domain,
        "apex_domain_confidence": domain_conf,
        "industry_raw": industry_raw,
        "canonical_industry": canonical_industry,
        "location": loc,
        "casl_flag": loc.get("country", "").lower() in ("canada",),
        "import_date": import_date.isoformat() if import_date else None,
        "gojiberry_score": float(row.get("Total Score") or 0),
        "intent_keyword": clean_keyword(row.get("Intent Keyword", "")),
        **intent,
        **profile,
        "emails_raw": [row.get("Email"), row.get("Email 2"), row.get("Email 3")],
        "_raw": row,
    }
    return out


def load_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("CSV has no header")
        missing = [c for c in EXPECTED_COLUMNS if c not in reader.fieldnames]
        if missing:
            raise ValueError(f"Gojiberry schema changed — missing columns: {missing}")
        return list(reader)


def ingest(path: Path) -> list[dict]:
    rows = load_csv(path)
    return [normalize_row(r) for r in rows]
