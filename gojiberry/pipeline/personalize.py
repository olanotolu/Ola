"""Stage 6: intent-routed personalization — no LLM slop."""
from __future__ import annotations

import json
from pathlib import Path

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "config" / "templates.json").read_text())


def _pain_topic(row: dict) -> str:
    kw = row.get("intent_keyword") or ""
    if kw:
        return kw.strip('"')
    return "hotel operations"


def _render(template: str, ctx: dict) -> str:
    out = template
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", str(v or ""))
    return out.strip()


def personalize_row(row: dict) -> dict:
    itype = row.get("intent_type") or "unknown"
    tpl = CONFIG["intent_templates"].get(itype, CONFIG["intent_templates"]["unknown"])
    blocks = CONFIG["blocks"]
    tier = row.get("seniority_tier", "manager")
    pain = _pain_topic(row)

    ctx = {
        "first_name": row.get("first_name") or "there",
        "company": row.get("company") or "your property",
        "pain_topic": pain,
        "pain_line": blocks["pain_keyword"] if row.get("intent_keyword") else blocks["pain_hospitality"],
        "value_line": blocks["value_exec"] if tier == "exec" else blocks["value_manager"],
        "cta": blocks["cta_direct"] if tier in ("exec", "director") else blocks["cta_soft"],
        "post_url": row.get("post_url") or "",
        "post_author": row.get("post_author") or "that author",
        "product_name": CONFIG["product_name"],
        "product_hook": CONFIG["product_hook"],
        "intent_keyword": pain,
    }

    # Never reference post_url if not extracted
    if not row.get("post_url") and itype in ("linkedin_post", "author_post"):
        ctx["post_url"] = ""
        tpl = CONFIG["intent_templates"]["lookalike"]

    email_body = _render(tpl["email_body"], ctx)
    email_opener = _render(tpl["email_opener"], ctx)
    email_full = f"{email_opener}\n\n{email_body}{blocks['unsubscribe']}"

    linkedin = _render(tpl.get("linkedin") or blocks["linkedin_short"], ctx)
    if row.get("post_url") and "{{post_url}}" not in tpl.get("linkedin", ""):
        linkedin = linkedin.replace("{{post_url}}", row["post_url"])

    subjects = CONFIG["subject_variants"].get(itype, CONFIG["subject_variants"]["unknown"])
    subject_a = _render(subjects[0], ctx)
    subject_b = _render(subjects[1] if len(subjects) > 1 else subjects[0], ctx)

    return {
        "email_message": email_full,
        "email_subject_a": subject_a,
        "email_subject_b": subject_b,
        "linkedin_message": linkedin,
        "template_intent": itype,
        "template_id": f"{itype}_{tier}",
        "audit": {"intent_type": itype, "had_post_url": bool(row.get("post_url")), "had_keyword": bool(row.get("intent_keyword"))},
    }
