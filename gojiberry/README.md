# Gojiberry Outreach Intelligence Engine

Python pipeline for Gojiberry CSV exports: ingest → normalize → dedupe → enrich → score → segment → personalize → sequence → compliance → export.

**Stack:** Python 3.11+, SQLite (`data/pipeline.db`), GetLeads for enrichment (swappable provider interface).

## Quick start

```bash
cd gojiberry
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# API key auto-loads from ../getleads/.env.getleads if present

# Dry run (no API credits)
python run.py /path/to/gojiberry-selected-contacts.csv --dry-run

# Full run with GetLeads enrichment
python run.py /path/to/gojiberry-selected-contacts.csv

pytest tests/
```

## Outputs

- `output/gojiberry-enriched-export.csv` — original Gojiberry schema with personalization columns filled
- `output/pipeline-report.json` — contactability, segments, top leads

## Config

| File | Purpose |
|------|---------|
| `config/industry_map.json` | Industry → canonical segment |
| `config/credentials.txt` | Name suffixes (CFBE, PMP, Jr., etc.) |
| `config/templates.json` | Intent-routed message templates |
| `.env` | API keys, `DRY_RUN`, `MIN_ENRICHMENT_CONFIDENCE` |

## Idempotent re-runs

Contacts are keyed by LinkedIn profile or name+company. Enrichment responses are cached in SQLite. Re-importing the same file skips re-personalization for already-processed rows.
