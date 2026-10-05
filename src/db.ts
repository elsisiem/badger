import pg from "pg";
import { env } from "./env";

// DATE columns stay plain "YYYY-MM-DD" strings (node-pg would otherwise hand back JS Dates and shift them by timezone).
pg.types.setTypeParser(1082, (v: string) => v);

// Neon's pooled endpoint handles connection churn; keep our own pool small.
export const pool = new pg.Pool({ connectionString: env.databaseUrl.replace(/[?&]sslmode=[^&]*/, ""), max: 8, ssl: { rejectUnauthorized: false } });
pool.on("error", (e) => console.error("pg pool error", e.message));

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(text, params as any[]);
  return r.rows;
}
export async function q1<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

/**
 * Fixed-window counter. Returns true when the caller is OVER the limit.
 * One atomic upsert, so concurrent requests cannot slip past the cap.
 */
export async function overLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const r = await q1<{ n: number }>(
    `INSERT INTO rate_limits (k, n, reset_at) VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (k) DO UPDATE SET
       n = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.n + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + ($2 || ' milliseconds')::interval ELSE rate_limits.reset_at END
     RETURNING n`,
    [key, String(windowMs)],
  );
  return (r?.n ?? 0) > max;
}
