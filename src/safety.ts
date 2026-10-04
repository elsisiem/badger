import { overLimit, q1 } from "./db";
import { env } from "./env";
import type { CaseRow, UserRow } from "./types";

/**
 * Badger sends email to third parties on someone's behalf, which is exactly what a harassment or spam tool would do.
 * Every outbound message passes through these checks, and every limit is enforced in code, not in a prompt.
 */

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
const SYSTEM_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|postmaster|abuse|mailer-daemon|root|hostmaster|bounce[s]?)$/i;

export const SIM_INBOXES = new Set(Object.values(env.simInboxes).map((e) => e.toLowerCase()));

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /<([^>]+)>/.exec(raw);
  const s = (m ? m[1] : raw).trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

export type Check = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Check => ({ ok: false, reason });

/** May this address be emailed at all, for this kind of user? */
export async function checkRecipient(email: string, user: Pick<UserRow, "kind">, scenario: string | null): Promise<Check> {
  const e = normalizeEmail(email);
  if (!e) return no("That does not look like a valid email address.");
  const [local, domain] = e.split("@");
  if (SYSTEM_LOCAL.test(local)) return no(`${e} is a system address that nobody reads, so Badger will not use it.`);
  const sim = SIM_INBOXES.has(e);
  if (user.kind === "demo" && !sim) return no("Demo accounts can only nag the sandbox characters. Sign in with your email to open a real case.");
  if (sim && !scenario) return no("That address belongs to a sandbox character and can only be used in the demo.");
  if (!sim && (domain === "agentmail.to" || domain === env.agentmailInbox.split("@")[1])) return no("Badger does not email other Badger/AgentMail inboxes.");
  const sup = await q1("SELECT reason FROM suppressions WHERE email = $1", [e]);
  if (sup) return no(`${e} asked not to be contacted by Badger, so this case cannot send there.`);
  return { ok: true };
}

const PER_CASE_CAP = { person: 3, organization: 8 } as const;

/**
 * Called right before an email is sent. Consumes budget, so call it once per attempt.
 * Sandbox cases skip the real-world rate caps (they only ever reach our own inboxes).
 */
export async function consumeSendBudget(c: CaseRow, user: Pick<UserRow, "id" | "kind">, to: string): Promise<Check> {
  if (!env.sendingEnabled) return no("Sending is switched off right now (kill switch). Nothing was sent.");
  if (c.emails_sent >= PER_CASE_CAP[c.counterparty_type]) return no(`Badger sends at most ${PER_CASE_CAP[c.counterparty_type]} emails per case to ${c.counterparty_type === "person" ? "a person" : "an organization"}. Time to try a different route.`);
  if (c.scenario) return { ok: true };
  if (await overLimit(`send:user:${user.id}`, 12, 24 * 3600_000)) return no("Daily send limit reached (12 emails per day). Badger will pick this up tomorrow.");
  if (await overLimit(`send:rcpt:${to}`, 2, 24 * 3600_000)) return no(`Badger already emailed ${to} twice in the last day, and will not pile on.`);
  if (await overLimit("send:global", 400, 3600_000)) return no("Badger is rate limited right now. Try again in a bit.");
  return { ok: true };
}

const THREAT = /\b(?:kill|hurt|harm|beat|destroy|ruin\s+you|doxx?|leak\s+your|expose\s+you|blackmail|stalk|find\s+where\s+you\s+live|your\s+family)\b/i;
const FAKE_AUTHORITY = /\b(?:i\s+am\s+(?:a|his|her|their)\s+(?:lawyer|attorney|solicitor)|legal\s+counsel\s+for|on\s+behalf\s+of\s+the\s+(?:police|fbi|irs|court))\b/i;
const SECRETISH = /\b(?:sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}|\d{3}-\d{2}-\d{4}|\b(?:\d[ -]?){15,16}\b)/;

/** Reasons an outbound draft must not go out as written. Null when it is fine. */
export function contentProblem(subject: string, body: string): string | null {
  const t = `${subject}\n${body}`;
  if (body.trim().length < 20) return "the message is too short to be useful";
  if (body.length > 2200) return "the message is too long";
  if (THREAT.test(t)) return "it contains language that reads as a threat";
  if (FAKE_AUTHORITY.test(t)) return "it claims legal or official authority that Badger does not have";
  if (SECRETISH.test(t)) return "it appears to contain a secret or a card/ID number";
  if (/https?:\/\/\S+@|javascript:/i.test(t)) return "it contains a suspicious link";
  return null;
}

/** Does an inbound message ask us to stop? Short, unambiguous asks only; anything subtler goes to the classifier. */
export function looksLikeStop(text: string): boolean {
  const t = text.trim().slice(0, 400).toLowerCase();
  if (/^(?:please\s+)?(?:stop|unsubscribe|remove me|opt[- ]?out)\b/.test(t)) return true;
  return /\b(?:do not|don'?t|stop)\s+(?:contact|email|message|write to)\s+(?:me|us)\b|\bcease and desist\b|\bharass(?:ing|ment)\b/.test(t);
}

export function footerFor(user: Pick<UserRow, "name" | "email" | "kind">, caseId: string): string {
  const who = user.name?.trim() || "my client";
  return [
    "",
    "--",
    `Sent by Badger, an AI assistant acting on behalf of ${who}${user.kind === "real" && user.email ? ` (${user.email}, copied)` : ""}.`,
    "Reply to this message and it reaches both of us. If you would rather not hear from Badger, reply STOP and it ends here.",
    `Badger ref: ${caseId.slice(0, 8)}`,
  ].join("\n");
}
