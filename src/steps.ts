import { env } from "./env";
import { safeDraft } from "./brain";
import { formUrlAllowed, submitContactForm } from "./kernel";
import { replyEmail, sendEmail } from "./mail";
import { notifyUser } from "./notify";
import { checkRecipient, consumeSendBudget, contentProblem, footerFor } from "./safety";
import { q1 } from "./db";
import { addEvent, addMessage, caseMessages, createAction, getCase, getUser, patchCase } from "./store";
import type { CaseRow, Draft, PlanStep, UserRow } from "./types";
import { DAY_MS, clip, fmtDate } from "./util";

export const isClosed = (c: Pick<CaseRow, "status">) => c.status === "resolved" || c.status === "stopped";

export function replyByPhrase(c: CaseRow, level: number): string {
  if (c.clock_scale > 1) return level >= 2 ? "within 1 day" : "within 2 days";
  return new Date(Date.now() + (level >= 2 ? 2 : 4) * DAY_MS).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

const ensureFooter = (body: string, user: UserRow, caseId: string) => (/Sent by Badger/.test(body) ? body : body.trimEnd() + "\n" + footerFor(user, caseId));

export interface Prepared {
  draft: Draft | null;
  needsApproval: boolean;
  blocked: string | null;
}

/** Build the draft for a step and decide whether a human has to approve it. */
export async function prepareStep(caseId: string, stepId: string): Promise<Prepared> {
  const c = await getCase(caseId);
  if (!c) return { draft: null, needsApproval: false, blocked: "case not found" };
  const user = (await getUser(c.user_id))!;
  const idx = c.plan.findIndex((s) => s.id === stepId);
  const step = c.plan[idx];
  if (!step || step.status !== "pending") return { draft: null, needsApproval: false, blocked: "this step was already handled" };
  if (isClosed(c)) return { draft: null, needsApproval: false, blocked: "the case is closed" };

  if (step.kind === "final") {
    return { draft: { kind: "final", level: 1, subject: "Where things stand", body: await finalSummary(c), to: "", cc: [] }, needsApproval: false, blocked: null };
  }
  if (step.kind === "user_action") {
    return { draft: { kind: "user_action", level: step.level, subject: step.label, body: step.intent, to: "", cc: [] }, needsApproval: false, blocked: null };
  }

  const to = step.kind === "web_form" ? c.counterparty_email : step.recipient ?? c.counterparty_email;
  const rc = await checkRecipient(to, user, c.scenario);
  if (!rc.ok) return { draft: null, needsApproval: false, blocked: rc.reason };

  if (step.kind === "web_form") {
    const ok = formUrlAllowed(step.recipient ?? "", c.counterparty_email, c.scenario);
    if (!ok.ok) return { draft: null, needsApproval: false, blocked: ok.reason };
  }

  const thread = (await caseMessages(caseId)).map((m) => ({ direction: m.direction, body: m.body, ts: m.ts }));
  const d = await safeDraft({
    c,
    user,
    step,
    thread,
    replyByPhrase: replyByPhrase(c, step.level),
    extraNote: step.kind === "web_form" ? "This message will be typed into the company's website contact form instead of emailed, so write it as a self-contained form message." : undefined,
  });
  const cc = user.kind === "real" && user.email ? [user.email] : [];
  const draft: Draft = {
    kind: step.kind,
    level: step.level,
    subject: d.subject,
    body: step.kind === "web_form" ? `${d.body}\n\nBadger ref: ${c.id.slice(0, 8)}` : ensureFooter(d.body, user, c.id),
    to,
    cc,
    form_url: step.kind === "web_form" ? step.recipient ?? undefined : undefined,
    note: d.used === "template" ? "The writing model could not produce a clean draft, so this is a plain template. Edit freely." : step.intent,
  };
  // Escalations, forms and formal notices are always the human's call. So is the first email, unless the owner gave a standing
  // approval for gentle reminders to this roster (group.auto_send).
  const groupAuto = c.group_id ? (await q1<{ auto_send: boolean }>("SELECT auto_send FROM groups WHERE id = $1", [c.group_id]))?.auto_send === true : false;
  const risky = step.kind === "escalate_email" || step.kind === "web_form" || step.level === 3;
  const needsApproval = risky || (groupAuto ? false : step.needs_approval || (step.kind === "email" && c.emails_sent === 0));
  return { draft, needsApproval, blocked: null };
}

/** The human is asked to approve: store the draft as an action and tell them. Returns the action id. */
export async function openApproval(caseId: string, stepId: string, draft: Draft, runId: string | null): Promise<string> {
  const c = (await getCase(caseId))!;
  const user = (await getUser(c.user_id))!;
  const act = await createAction(caseId, draft.kind, draft, stepId, runId);
  await patchCase(caseId, { status: "awaiting_approval", mood: "worried" });
  const what = draft.kind === "web_form" ? `fill in ${c.counterparty_name}'s web form` : draft.kind === "escalate_email" ? `escalate to ${draft.to}` : `email ${c.counterparty_name}`;
  await addEvent(caseId, "approval_needed", `Badger wants to ${what}`, "Waiting for your OK. Nothing goes out until you approve.", { action_id: act.id });
  await notifyUser(user, c, `Approve: ${what}`, `Badger drafted this for "${c.title}":\n\n${draft.subject ? "Subject: " + draft.subject + "\n\n" : ""}${clip(draft.body, 900)}`, { actionId: act.id });
  return act.id;
}

async function finalSummary(c: CaseRow): Promise<string> {
  const msgs = await caseMessages(c.id);
  const sent = msgs.filter((m) => m.direction === "out").length;
  const got = msgs.filter((m) => m.direction === "in");
  const last = got[got.length - 1];
  return [
    `I've worked through the whole plan for "${c.title}": ${sent} message${sent === 1 ? "" : "s"} sent, ${got.length} repl${got.length === 1 ? "y" : "ies"} received.`,
    last ? `Their last word (${fmtDate(last.ts)}): "${clip(last.body, 240)}"` : `${c.counterparty_name} never replied.`,
    "It is still unresolved. Your options: tell me to keep going with a new plan, switch to a firmer tone, or take it up a level yourself. Open the case and I'll pick up whichever you choose.",
  ].join("\n\n");
}

/** Mark a step done/skipped, re-base the remaining steps if this one ran late, and set the next wake-up. */
export async function advance(caseId: string, stepId: string, as: "done" | "skipped" = "done"): Promise<CaseRow> {
  const c = (await getCase(caseId))!;
  const plan = c.plan.map((s) => ({ ...s }));
  const i = plan.findIndex((s) => s.id === stepId);
  if (i >= 0 && plan[i].status === "pending") {
    const late = Math.max(0, Date.now() - new Date(plan[i].due_at).getTime());
    plan[i].status = as;
    plan[i].done_at = new Date().toISOString();
    for (let j = i + 1; j < plan.length; j++) if (plan[j].status === "pending") plan[j].due_at = new Date(new Date(plan[j].due_at).getTime() + late).toISOString();
  }
  const next = plan.find((s) => s.status === "pending");
  if (isClosed(c) || c.status === "awaiting_confirmation") return patchCase(caseId, { plan });
  if (next) return patchCase(caseId, { plan, status: "waiting", mood: "napping", next_due_at: next.due_at, working_since: null });
  return patchCase(caseId, { plan, status: "stalled", mood: "grumpy", next_due_at: null, working_since: null });
}

async function blockedPath(c: CaseRow, user: UserRow, step: PlanStep, reason: string) {
  await addEvent(c.id, "blocked", `Skipped: ${step.label}`, reason, { step_id: step.id });
  await notifyUser(user, c, `Badger held back on "${c.title}"`, reason);
  return advance(c.id, step.id, "skipped");
}

/** Do the thing the human approved (or that autopilot allowed): send, fill the form, remind, or report back. */
export async function deliverStep(caseId: string, stepId: string, draft: Draft, decision: "approve" | "skip"): Promise<{ outcome: string }> {
  const c = (await getCase(caseId))!;
  const user = (await getUser(c.user_id))!;
  const step = c.plan.find((s) => s.id === stepId);
  if (!step || step.status !== "pending") return { outcome: "already handled" };
  if (isClosed(c)) {
    await advance(caseId, stepId, "skipped");
    return { outcome: "case closed" };
  }
  if (decision === "skip") {
    await addEvent(caseId, "skipped", `You skipped: ${step.label}`, null, { step_id: stepId });
    await advance(caseId, stepId, "skipped");
    return { outcome: "skipped" };
  }

  if (step.kind === "final") {
    await addEvent(caseId, "report", "Badger's report", draft.body);
    await notifyUser(user, c, `Report: "${c.title}" is still open`, draft.body);
    await advance(caseId, stepId, "done");
    return { outcome: "reported" };
  }
  if (step.kind === "user_action") {
    await addEvent(caseId, "user_action", step.label, step.intent, { step_id: stepId });
    await notifyUser(user, c, `Your move: ${step.label}`, step.intent);
    await advance(caseId, stepId, "done");
    return { outcome: "reminded" };
  }

  // From here on we contact a third party. Re-check everything, because the draft may have been edited and time has passed.
  const to = draft.to;
  const rc = await checkRecipient(to, user, c.scenario);
  if (!rc.ok) return blockedPath(c, user, step, rc.reason).then(() => ({ outcome: "blocked" }));
  const problem = contentProblem(draft.subject, draft.body);
  if (problem) return blockedPath(c, user, step, `The message was not sent because ${problem}. Edit it and approve again.`).then(() => ({ outcome: "blocked" }));
  const budget = await consumeSendBudget(c, user, to);
  if (!budget.ok) return blockedPath(c, user, step, budget.reason).then(() => ({ outcome: "blocked" }));

  await patchCase(caseId, { status: "working", mood: "nagging", working_since: new Date().toISOString() });

  if (step.kind === "web_form") {
    const url = draft.form_url ?? step.recipient ?? "";
    const gate = formUrlAllowed(url, c.counterparty_email, c.scenario);
    if (!gate.ok) return blockedPath(c, user, step, `Badger will not fill that form: ${gate.reason}.`).then(() => ({ outcome: "blocked" }));
    const res = await submitContactForm({
      caseId,
      url: gate.url,
      profile: { name: user.name || "Client", email: env.agentmailInbox, subject: draft.subject, message: draft.body, reference: c.context.match(/(?:member|account|order|reference|ref)\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9-]{4,20})/i)?.[1] },
    });
    await patchCase(caseId, { emails_sent: c.emails_sent + 1 });
    if (res.ok) {
      await addMessage({ caseId, direction: "out", from: env.agentmailInbox, to: [url], subject: draft.subject, body: `[Submitted through their web form]\n\n${draft.body}` });
      await addEvent(caseId, "form_submitted", "Badger submitted their web form", clip(res.pageText ?? "", 400), { screenshot: res.screenshot ?? null, final_url: res.finalUrl ?? null, step_id: stepId });
    } else {
      await addEvent(caseId, "form_failed", "The web form did not go through", res.error ?? "unknown error", { step_id: stepId });
      await notifyUser(user, c, `Could not submit the form for "${c.title}"`, `${res.error ?? "Unknown error"}. You may need to submit it yourself: ${url}`);
    }
    await advance(caseId, stepId, "done");
    return { outcome: res.ok ? "form_submitted" : "form_failed" };
  }

  // Email. Reply inside the existing thread when we can so the company sees one conversation.
  const msgs = await caseMessages(caseId);
  const anchor = step.kind === "email" ? [...msgs].reverse().find((m) => m.am_message_id && (m.direction === "in" || m.to_addrs.includes(to))) : undefined;
  let sent;
  try {
    if (anchor?.am_message_id) {
      try {
        sent = await replyEmail({ inbox: env.agentmailInbox, messageId: anchor.am_message_id, text: draft.body, to: [to], cc: draft.cc });
      } catch (e) {
        console.error("[reply failed, sending fresh]", (e as Error).message);
      }
    }
    sent ??= await sendEmail({ inbox: env.agentmailInbox, to: [to], cc: draft.cc, subject: draft.subject, text: draft.body, labels: ["badger-out", `case-${caseId.slice(0, 8)}`] });
  } catch (e) {
    const msg = (e as Error).message;
    await addEvent(caseId, "send_failed", "The email could not be sent", msg, { step_id: stepId });
    await notifyUser(user, c, `Email failed for "${c.title}"`, msg);
    await advance(caseId, stepId, "skipped");
    return { outcome: "send_failed" };
  }
  await addMessage({ caseId, direction: "out", from: env.agentmailInbox, to: [to, ...draft.cc], subject: draft.subject, body: draft.body, amMessageId: sent.message_id, amThreadId: sent.thread_id });
  await patchCase(caseId, { emails_sent: c.emails_sent + 1 });
  await addEvent(caseId, "email_sent", step.kind === "escalate_email" ? `Escalated to ${to}` : `Email sent to ${c.counterparty_name}`, clip(draft.body, 600), { step_id: stepId, level: step.level, to });
  if (c.group_id) await notifyUser(user, c, `Reminded ${c.counterparty_name}`, `Badger sent a reminder for "${c.title}" (reminder ${c.emails_sent + 1}). Open the roster to see where everyone stands.`, { quiet: true });
  await advance(caseId, stepId, "done");
  return { outcome: "sent" };
}
