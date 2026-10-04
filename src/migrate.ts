import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./db";

/** Applies any new SQL files in /migrations, once each, in order. Safe to run on every boot. */
export async function runMigrations(dir = join(process.cwd(), "migrations")) {
  await pool.query("CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now())");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if ((await pool.query("SELECT 1 FROM _migrations WHERE name = $1", [f])).rowCount) continue;
    console.log("[migrate] applying", f);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
