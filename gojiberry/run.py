#!/usr/bin/env python3
"""Gojiberry Outreach Intelligence Engine — CLI runner."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / "getleads" / ".env.getleads", override=False)

from pipeline.compliance import compliance_check, load_suppression
from pipeline.db import connect, init_db, source_key
from pipeline.dedupe import dedupe, quality_scorecard
from pipeline.enrich import enrich_all
from pipeline.export import build_report, row_to_export, write_csv, write_report
from pipeline.normalize import ingest, load_csv
from pipeline.personalize import personalize_row
from pipeline.score import score_row
from pipeline.segment import segment_row
from pipeline.sequence import assign_sequence


def already_processed(conn, key: str) -> dict | None:
    row = conn.execute(
        "SELECT normalized_json, enriched_json, scores_json, segments_json, messages_json, compliance_json FROM contacts WHERE source_key = ?",
        (key,),
    ).fetchone()
    if not row or not row["messages_json"]:
        return None
    return {
        **json.loads(row["normalized_json"] or "{}"),
        "enrichment": json.loads(row["enriched_json"] or "{}"),
        "scores": json.loads(row["scores_json"] or "{}"),
        "segments": json.loads(row["segments_json"] or "{}"),
        "messages": json.loads(row["messages_json"] or "{}"),
        "compliance": json.loads(row["compliance_json"] or "{}"),
        "_from_db": True,
    }


def persist(conn, key: str, raw: dict, proc: dict) -> None:
    conn.execute(
        """INSERT INTO contacts (source_key, raw_json, normalized_json, enriched_json, scores_json, segments_json, messages_json, compliance_json, processed_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(source_key) DO UPDATE SET
             enriched_json=excluded.enriched_json,
             scores_json=excluded.scores_json,
             segments_json=excluded.segments_json,
             messages_json=excluded.messages_json,
             compliance_json=excluded.compliance_json,
             processed_at=excluded.processed_at""",
        (
            key,
            json.dumps(raw),
            json.dumps({k: v for k, v in proc.items() if k not in ("enrichment", "scores", "segments", "messages", "compliance", "_from_db")}),
            json.dumps(proc.get("enrichment", {})),
            json.dumps(proc.get("scores", {})),
            json.dumps(proc.get("segments", {})),
            json.dumps(proc.get("messages", {})),
            json.dumps(proc.get("compliance", {})),
        ),
    )
    conn.commit()


def run_pipeline(csv_path: Path, dry_run: bool = False, skip_enrich: bool = False, force: bool = False) -> None:
    conn = connect()
    init_db(conn)
    raw_rows = load_csv(csv_path)
    before_contactable = sum(
        1 for r in raw_rows
        if (r.get("Email") or r.get("Profile URL"))
    )

    normalized = ingest(csv_path)
    unique, dupes = dedupe(normalized)
    print(f"Ingested {len(raw_rows)} rows → {len(unique)} unique ({len(dupes)} dupes dropped)")

    min_conf = float(os.getenv("MIN_ENRICHMENT_CONFIDENCE", "0.45"))
    suppression = load_suppression(conn)
    processed: list[dict] = []

    if not skip_enrich and not dry_run:
        unique = enrich_all(unique, conn, dry_run=False)
    elif dry_run:
        unique = enrich_all(unique, conn, dry_run=True)

    for i, row in enumerate(unique):
        row["quality"] = quality_scorecard(row)
        key = source_key(row)
        cached = already_processed(conn, key) if not force else None
        if cached and cached.get("messages"):
            proc = cached
        else:
            if "enrichment" not in row:
                row["enrichment"] = row.get("enrichment") or {}
            row["scores"] = score_row(row)
            row["segments"] = segment_row(row)
            row["messages"] = personalize_row(row)
            row["sequence"] = assign_sequence(row, row["messages"])
            row["compliance"] = compliance_check(row, suppression, min_conf)
            proc = row
            persist(conn, key, proc.get("_raw") or row.get("_raw") or {}, proc)
        processed.append(proc)

    export_rows = []
    for proc in processed:
        raw = proc.get("_raw") or {}
        export_rows.append(row_to_export(raw, proc))

    out_csv = ROOT / "output" / "gojiberry-enriched-export.csv"
    out_report = ROOT / "output" / "pipeline-report.json"
    write_csv(export_rows, out_csv)
    report = build_report(processed, before_contactable, len(raw_rows))
    report["duplicates_removed"] = len(dupes)
    write_report(report, out_report)

    print(f"\nExport: {out_csv}")
    print(f"Report: {out_report}")
    print(f"Contactability: {report['contactability_before_pct']}% → {report['contactability_after_pct']}%")
    print(f"Emails discovered: {report['emails_discovered']}")
    print(f"Top lead: {report['top_10_leads'][0]}")


def main():
    p = argparse.ArgumentParser(description="Gojiberry Outreach Intelligence Engine")
    p.add_argument("csv", nargs="?", default="/Users/term_/Downloads/gojiberry-selected-contacts.csv")
    p.add_argument("--dry-run", action="store_true", help="No paid API calls")
    p.add_argument("--skip-enrich", action="store_true", help="Normalize/score/personalize only")
    p.add_argument("--force", action="store_true", help="Re-personalize even if cached")
    args = p.parse_args()
    run_pipeline(Path(args.csv), dry_run=args.dry_run, skip_enrich=args.skip_enrich, force=args.force)


if __name__ == "__main__":
    main()
