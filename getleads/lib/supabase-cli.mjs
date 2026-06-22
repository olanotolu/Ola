import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LINK_DIR = process.env.CONCYA_SUPABASE_LINK_DIR || "/tmp/supabase-concya-query";

function parseSupabaseJson(out) {
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.rows ?? [];
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed.rows ?? [];
    }
    throw new Error(`Supabase query returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
}

export function dbQuery(sql) {
  const tmp = path.join(LINK_DIR, `.query-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, sql);
  try {
    const out = execFileSync(
      "supabase",
      ["db", "query", "--linked", "-o", "json", "-f", tmp],
      { cwd: LINK_DIR, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    return parseSupabaseJson(out);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function dbExec(sql) {
  return dbQuery(sql);
}

export function escSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function escJson(obj) {
  return escSql(JSON.stringify(obj ?? {}));
}
