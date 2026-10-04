import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const DAY_MS = 24 * 3600_000;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("hex");
export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Length of one case "day" in ms. Real cases use 24h; sandbox cases run on a fast-forwarded clock. */
export const dayMs = (scale: number) => DAY_MS / Math.max(1, scale);

export const isoIn = (fromMs: number, days: number, scale: number) => new Date(fromMs + days * dayMs(scale)).toISOString();

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text to a minimal, safe HTML email body. */
export function textToHtml(t: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#222">${escapeHtml(t)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function fmtDate(d: Date | string, withTime = false): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}), timeZone: "UTC" }) + (withTime ? " UTC" : "");
}

/** Run an async fn, returning fallback on error (logs the reason). */
export async function safely<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    console.error(`[${label}]`, e?.message ?? e);
    return fallback;
  }
}
