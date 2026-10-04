import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { overLimit, q1 } from "./db";
import { env } from "./env";
import { sendEmail } from "./mail";
import { normalizeEmail } from "./safety";
import type { UserRow } from "./types";
import { b64url, randomToken, safeEqual, sha256, sign } from "./util";

const COOKIE = "badger_session";
const MAX_AGE_S = 60 * 60 * 24 * 30;

export function issueSession(c: Context, userId: string) {
  const exp = Date.now() + MAX_AGE_S * 1000;
  const body = `${userId}.${exp}`;
  setCookie(c, COOKIE, b64url(`${body}.${sign(body)}`), { httpOnly: true, sameSite: "Lax", secure: env.isProd, path: "/", maxAge: MAX_AGE_S });
}
export const clearSession = (c: Context) => deleteCookie(c, COOKIE, { path: "/" });

async function userFromCookie(c: Context): Promise<UserRow | null> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  try {
    const [id, exp, sig] = Buffer.from(raw, "base64url").toString().split(".");
    if (!id || Number(exp) < Date.now() || !safeEqual(sig ?? "", sign(`${id}.${exp}`))) return null;
    return await q1<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  } catch {
    return null;
  }
}

export type Vars = { user: UserRow | null };
export const sessionMiddleware: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  c.set("user", await userFromCookie(c));
  await next();
};

export const requireUser: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Please sign in." }, 401);
  await next();
};

/** Magic-link sign-in: Badger emails a one-time link. The proof of owning an address is the whole point; it is what lets Badger CC you. */
export async function requestMagicLink(emailRaw: string, name: string | null, ip: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(emailRaw);
  if (!email) return { ok: false, error: "That email address does not look valid." };
  if (await overLimit(`login:ip:${ip}`, 12, 3600_000)) return { ok: false, error: "Too many sign-in requests. Try again in an hour." };
  if (await overLimit(`login:email:${email}`, 4, 3600_000)) return { ok: false, error: "A link was already sent to that address a few times. Check your inbox (and spam)." };
  const token = randomToken();
  await q1("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '20 minutes')", [sha256(token), email]);
  if (name) await q1("INSERT INTO users (email, name, kind) VALUES ($1, $2, 'real') ON CONFLICT (email) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name)", [email, name.slice(0, 60)]);
  await sendEmail({
    inbox: env.agentmailInbox,
    to: [email],
    subject: "Your Badger sign-in link",
    text: `Hi${name ? " " + name.split(" ")[0] : ""},\n\nHere is your one-time link to sign in to Badger (it works for 20 minutes):\n\n${env.publicUrl}/auth/verify?token=${token}\n\nIf you didn't ask for this, ignore this email; nothing happens.\n\n-- Badger. The agent that nags so you don't have to.`,
    labels: ["login"],
  });
  return { ok: true };
}

export async function consumeMagicToken(token: string): Promise<UserRow | null> {
  const row = await q1<{ email: string }>("UPDATE login_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email", [sha256(token)]);
  if (!row) return null;
  return q1<UserRow>(
    "INSERT INTO users (email, kind) VALUES ($1, 'real') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *",
    [row.email],
  );
}

export async function createDemoUser(): Promise<UserRow> {
  return (await q1<UserRow>("INSERT INTO users (name, kind, autopilot) VALUES ('You (demo)', 'demo', 'followups') RETURNING *"))!;
}
