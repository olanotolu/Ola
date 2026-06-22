"""SQLite persistence for idempotent pipeline runs."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "pipeline.db"


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_key TEXT UNIQUE,
            raw_json TEXT NOT NULL,
            normalized_json TEXT,
            enriched_json TEXT,
            scores_json TEXT,
            segments_json TEXT,
            messages_json TEXT,
            compliance_json TEXT,
            processed_at TEXT,
            pipeline_version INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS enrichment_cache (
            cache_key TEXT PRIMARY KEY,
            provider TEXT,
            response_json TEXT,
            credits_used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS suppression (
            email TEXT PRIMARY KEY,
            reason TEXT
        );
        """
    )
    conn.commit()


def source_key(row: dict) -> str:
    profile = (row.get("profile_url") or row.get("Profile URL") or "").strip().lower()
    if profile and "/in/aco" not in profile and "/in/acw" not in profile:
        return f"li:{profile}"
    fn = (row.get("first_name") or row.get("First Name") or "").strip().lower()
    ln = (row.get("clean_last_name") or row.get("Last Name") or "").strip().lower()
    co = (row.get("company") or row.get("Company") or "").strip().lower()
    return f"nameco:{fn}|{ln}|{co}"


def get_cached_enrichment(conn: sqlite3.Connection, key: str) -> dict | None:
    row = conn.execute(
        "SELECT response_json FROM enrichment_cache WHERE cache_key = ?", (key,)
    ).fetchone()
    return json.loads(row["response_json"]) if row else None


def set_cached_enrichment(conn: sqlite3.Connection, key: str, provider: str, data: dict, credits: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO enrichment_cache (cache_key, provider, response_json, credits_used) VALUES (?,?,?,?)",
        (key, provider, json.dumps(data), credits),
    )
    conn.commit()
