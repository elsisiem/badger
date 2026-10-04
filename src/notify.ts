import { overLimit, q1 } from "./db";
import { env } from "./env";
import { sendEmail } from "./mail";
import type { CaseRow, UserRow } from "./types";
import { b64url, safeEqual, safely, sign } from "./util";

/** One-tap links for emails: the token itself proves the right to decide that one action, for 3 days. */
export function actionToken(actionId: string, ttlMs = 3 * 24 * 3600_000): string {
  const exp = Date.now() + ttlMs;
  const body = `${actionId}.${exp}`;
  return b64url(`${body}.${sign(body)}`);
}
export function readActionToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, "base64url").toString();
    const [id, exp, sig] = raw.split(".");
    if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
    return safeEqual(sig, sign(`${id}.${exp}`)) ? id : null;
  } catch {
    return null;
  }
}

export const caseLink = (caseId: string) => `${env.publicUrl}/app/case/${caseId}`;
export const approveLink = (actionId: string) => `${env.publicUrl}/a/${actionToken(actionId)}`;

/**
 * Tell the human something. It always lands in the app; verified real users also get an email.
 * Demo users never get email (they have no inbox).
 */
export async function notifyUser(user: UserRow, c: Pick<CaseRow, "id" | "title"> | null, subject: string, body: string, opts: { actionId?: string } = {}) {
  const link = opts.actionId ? approveLink(opts.actionId) : c ? caseLink(c.id) : env.publicUrl + "/app";
  await q1("INSERT INTO notifications (user_id, case_id, subject, body, link) VALUES ($1, $2, $3, $4, $5)", [user.id, c?.id ?? null, subject, body, link]);
  if (user.kind !== "real" || !user.email || !env.sendingEnabled) return;
  if (await overLimit(`notify:${user.id}`, 25, 24 * 3600_000)) return;
  await safely(
    "notify-email",
    () =>
      sendEmail({
        inbox: env.agentmailInbox,
        to: [user.email!],
        subject: `Badger: ${subject}`,
        text: `${body}\n\n${opts.actionId ? "Review and decide (one tap): " : "Open the case: "}${link}\n\n-- Badger. The agent that nags so you don't have to.`,
        labels: ["to-user"],
      }),
    null,
  );
}
