import { queryAgent } from "./brain";
import { q, q1 } from "./db";
import { env } from "./env";
import { replyEmail, sendEmail, freshText, type MailMessage } from "./mail";
import { isClosed } from "./steps";
import { getCase } from "./store";
import type { CaseRow, Research } from "./types";
import { escapeHtml, sleep } from "./util";

/**
 * The sandbox. Two fictional characters answer REAL email sent through AgentMail, on a fast-forwarded clock, so a judge can watch the whole
 * loop (draft, approve, send, stall, redirect, web form, escalate, resolve) in about two minutes without anyone being emailed who didn't ask for it.
 * Only cases opened with `scenario` set can reach these inboxes (enforced in safety.checkRecipient).
 */

export interface Scenario {
  key: "gym" | "roommate";
  label: string;
  blurb: string;
  icon: "dumbbell" | "receipt";
  inbox: string;
  case: {
    title: string;
    counterparty_name: string;
    counterparty_type: "person" | "organization";
    ask: string;
    amount_cents: number;
    context: string;
    tone: "polite" | "firm" | "badger";
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  gym: {
    key: "gym",
    label: "The gym that won't let go",
    blurb: "You cancelled. They kept charging. Their reply: email isn't allowed, use the web form. Watch Badger fill it in a real cloud browser, then quote their own policy back at them.",
    icon: "dumbbell",
    inbox: env.simInboxes.gym,
    case: {
      title: "Gym still charging me after I cancelled",
      counterparty_name: "Sunnyside Fitness",
      counterparty_type: "organization",
      ask: "Confirm my membership is cancelled and refund the two charges made after I cancelled",
      amount_cents: 8998,
      context:
        "I cancelled my Sunnyside Fitness membership in person at the front desk on August 12 (member #SF20417) and was handed a cancellation receipt. They still charged my card $44.99 on September 1 and again on October 1, $89.98 in total.",
      tone: "polite",
    },
  },
  roommate: {
    key: "roommate",
    label: "The roommate who 'forgot'",
    blurb: "$64.50 for the electric bill and the Costco run. Nobody wants to be the one who keeps asking. Badger asks, kindly, as many times as it takes.",
    icon: "receipt",
    inbox: env.simInboxes.roommate,
    case: {
      title: "Alex owes me for the electric bill and Costco",
      counterparty_name: "Alex Rivera",
      counterparty_type: "person",
      ask: "Pay me back $64.50 for the electric bill and the Costco run",
      amount_cents: 6450,
      context: "Alex and I split the October electric bill ($38.00) and the Costco run ($26.50) and I paid for both on October 3. Alex said they'd Venmo me but it never came. Alex usually pays by Venmo.",
      tone: "polite",
    },
  },
};

/** The two sandbox "parents" used by the teacher demo. Not listed as stand-alone scenarios; the roster demo drives them. */
const PARENT_INBOXES = new Set([env.simInboxes.parentLee.toLowerCase(), env.simInboxes.parentOrtiz.toLowerCase()]);

/** Which sandbox script answers mail sent to this inbox, if any. */
export function scenarioForInbox(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (PARENT_INBOXES.has(e)) return "parent";
  return Object.values(SCENARIOS).find((s) => s.inbox.toLowerCase() === e)?.key ?? null;
}

/** Sourced facts for sandbox companies: stand-ins for what Exa finds on a real company's policy page. */
export function simPolicies(key: string): Research["policies"] {
  if (key !== "gym") return [];
  const url = `${env.publicUrl}/sim/gym/policy`;
  return [
    { claim: "Sunnyside accepts cancellations only through its online cancellation form; billing continues until the request is processed.", quote: "Cancellation requests must be submitted through our online form. Billing continues until your request has been processed.", url },
    { claim: "Sunnyside refunds charges made after a valid cancellation.", quote: "Charges made after your cancellation takes effect will be refunded on request.", url },
  ];
}

/* ----------------------------------------------------------------------------------------------
 * The characters answer email
 * ---------------------------------------------------------------------------------------------- */

const REF = /Badger ref:\s*([0-9a-f]{8})/i;

async function emailsSentSoFar(caseId: string): Promise<number> {
  const r = await q1<{ n: string }>("SELECT count(*) AS n FROM messages WHERE case_id = $1 AND direction = 'out' AND am_message_id IS NOT NULL", [caseId]);
  return Number(r?.n ?? 0);
}

const SCRIPT: Record<string, (stage: number, c: CaseRow) => { directive: string; fallback: string }> = {
  gym: (stage, c) => {
    const form = `${env.publicUrl}/sim/gym/contact`;
    if (stage <= 1)
      return {
        directive: `You are Pat, a polite but rigid member-care rep at Sunnyside Fitness. Explain that you cannot process cancellations by email; members must use the online cancellation form at ${form}. Say billing continues until the form is processed. Be courteous and a bit corporate.`,
        fallback: `Hi, thanks for getting in touch. Unfortunately we're unable to process cancellations by email. Please submit our online cancellation form at ${form}. Billing continues until your request has been processed.\n\nPat, Member Care`,
      };
    if (stage === 2)
      return {
        directive: `You are Pat at Sunnyside Fitness. You see this is a second message about cancelling and refunding two charges. Say you have passed it to the billing manager who will review it, and that you cannot promise a timeline. Stay vague and polite. Do not refund yet.`,
        fallback: `Hi again, I've passed this along to our billing manager who will review the account. I can't promise a timeline, but they'll be in touch.\n\nPat, Member Care`,
      };
    return {
      directive: `You are Pat at Sunnyside Fitness. The customer has quoted your own policy that charges after a valid cancellation are refunded. Concede fully and apologise: the membership is cancelled effective August 12, the two charges ($44.99 each, $89.98 total) were refunded to the card on file, and the confirmation number is SF-REFUND-7731. Warm and brief.`,
      fallback: `You're right, and I'm sorry for the trouble. Your membership is cancelled effective August 12 and the two charges ($89.98 total) have been refunded to your card on file. Confirmation number: SF-REFUND-7731.\n\nPat, Member Care`,
    };
  },
  parent: (stage, c) =>
    stage <= 1
      ? {
          directive: `You are ${c.counterparty_name}, a friendly, busy parent whose child takes piano lessons. You forgot to pay the teacher. Apologise warmly, say you'll send the bank transfer this evening. Short, polite, no emoji.`,
          fallback: `Oh no, I'm so sorry, that completely slipped my mind. I'll send the transfer this evening. Thank you for your patience!`,
        }
      : {
          directive: `You are ${c.counterparty_name}, a parent. You have just paid the piano teacher in full by bank transfer. Say so briefly and thank them. Short, warm, no emoji.`,
          fallback: `All sorted! I've just sent the full amount by bank transfer. Thank you for reminding me, and for everything you do for the kids.`,
        },
  roommate: (stage) =>
    stage <= 1
      ? {
          directive: `You are Alex, a friendly, slightly flaky roommate. Apologise warmly for forgetting, say you'll Venmo the money tonight. Casual lowercase vibe, no emoji.`,
          fallback: `omg i'm so sorry, completely forgot!! i'll venmo you tonight, promise`,
        }
      : {
          directive: `You are Alex. You just sent the full $64.50 on Venmo. Say so, casually, and thank them for the patience. No emoji.`,
          fallback: `ugh yes!! just sent you the full $64.50 on venmo, thanks for being patient with me`,
        },
};

async function voice(directive: string, fallback: string): Promise<string> {
  try {
    const r = await queryAgent.generate(`STAGE DIRECTIVE: ${directive}\n\nWrite only the email body.`);
    const t = (r.text ?? "").trim();
    return t.length > 20 && t.length < 900 ? t : fallback;
  } catch {
    return fallback;
  }
}

/** An email arrived at a sandbox inbox. Find the case by the "Badger ref" every Badger email carries, and answer in character. */
export async function simRespond(inboxId: string, m: MailMessage) {
  const text = freshText(m);
  const ref = REF.exec(text)?.[1];
  if (!ref) return;
  const c = await q1<CaseRow>("SELECT * FROM cases WHERE id::text LIKE $1 AND scenario IS NOT NULL", [ref.toLowerCase() + "%"]);
  if (!c?.scenario) return;
  const fresh = await getCase(c.id);
  if (!fresh || isClosed(fresh) || fresh.counterparty_email.toLowerCase() !== inboxId.toLowerCase()) return;
  const stage = await emailsSentSoFar(c.id);
  const line = SCRIPT[c.scenario]?.(stage, fresh);
  if (!line) return;
  void (async () => {
    await sleep(3500 + Math.random() * 3000); // a human-ish pause
    const body = await voice(line.directive, line.fallback);
    await replyEmail({ inbox: inboxId, messageId: m.message_id, text: body }).catch((e) => console.error("[sim reply]", e.message));
  })();
}

/* ----------------------------------------------------------------------------------------------
 * The gym's website: a policy page and a contact form, served by us so Kernel's cloud browser can reach them
 * ---------------------------------------------------------------------------------------------- */

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1c2b2b}h1{color:#0b6e69}label{display:block;margin:14px 0 4px;font-weight:600}input,textarea{width:100%;padding:10px;border:1px solid #9bb;border-radius:6px;font:inherit;box-sizing:border-box}button{margin-top:18px;background:#0b6e69;color:#fff;border:0;padding:12px 22px;border-radius:6px;font-size:16px;cursor:pointer}.note{background:#eef7f6;border-left:4px solid #0b6e69;padding:10px 14px;margin:18px 0}footer{margin-top:40px;color:#678;font-size:13px}</style></head>
<body>${body}<footer>Sunnyside Fitness is a fictional company in the Badger sandbox demo. Nothing here is real.</footer></body></html>`;

export const gymPolicyPage = () =>
  page(
    "Sunnyside Fitness: Membership Terms",
    `<h1>Sunnyside Fitness</h1><h2>Membership terms</h2>
<p><strong>Cancellations.</strong> Cancellation requests must be submitted through our online form. Billing continues until your request has been processed.</p>
<p><strong>Refunds.</strong> Charges made after your cancellation takes effect will be refunded on request.</p>
<p><a href="/sim/gym/contact">Cancellation and member-care form</a></p>`,
  );

export const gymContactPage = () =>
  page(
    "Sunnyside Fitness: Member Care",
    `<h1>Member care</h1><div class="note">All cancellations and billing requests go through this form. Email requests cannot be processed.</div>
<form method="post" action="/sim/gym/contact" id="member-care">
<label for="name">Your name</label><input id="name" name="name" required>
<label for="email">Your email</label><input id="email" name="email" type="email" required>
<label for="subject">Subject</label><input id="subject" name="subject" required>
<label for="message">How can we help?</label><textarea id="message" name="message" rows="7" required></textarea>
<button type="submit" id="send">Send request</button></form>`,
  );

export const gymThanksPage = () => page("Sunnyside Fitness: request received", `<h1>Thank you</h1><p>Your request has been received. Reference <strong>SF-4412</strong>. We will email you once it has been processed.</p>`);

/** The form was submitted: the "gym" emails the customer a receipt-style acknowledgement a few seconds later. */
export async function gymFormSubmitted(form: Record<string, string>) {
  const ref = REF.exec(form.message ?? "")?.[1];
  const to = (form.email || env.agentmailInbox).trim();
  if (to.toLowerCase() !== env.agentmailInbox.toLowerCase()) return; // sandbox only ever writes back to Badger
  void (async () => {
    await sleep(4500);
    await sendEmail({
      inbox: env.simInboxes.gym,
      to: [to],
      subject: "Your Sunnyside Fitness request SF-4412 has been received",
      text: `Hello,\n\nWe've received your request (reference SF-4412) and it is now in our processing queue. Please note billing may continue until it has been processed.\n\nBadger ref: ${ref ?? "unknown"}\n\nSunnyside Fitness Member Care`,
    }).catch((e) => console.error("[gym ack]", e.message));
  })();
}

export const listScenarios = () => Object.values(SCENARIOS).map(({ key, label, blurb, icon }) => ({ key, label, blurb, icon }));
export { q };
