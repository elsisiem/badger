import { classifyReply, fallbackPlan, makePlan, type Classification, classifySchema } from "./brain";
import { q, q1 } from "./db";
import { env } from "./env";
import { freshText, getMessage, type MailMessage } from "./mail";
import { notifyUser } from "./notify";
import { getMastra } from "./registry";
import { researchCase } from "./research";
import { SIM_INBOXES, checkRecipient, looksLikeStop, normalizeEmail } from "./safety";
import { simPolicies, simRespond } from "./sim";
import { addEvent, addMessage, caseMessages, createAction, decideAction, getAction, getCase, getUser, patchCase } from "./store";
import { isClosed } from "./steps";
import type { CaseRow, PlanStep, Research, Tone, UserRow } from "./types";
import { clip, dayMs, safely } from "./util";

/* ----------------------------------------------------------------------------------------------
 * Opening a case
 * ---------------------------------------------------------------------------------------------- */

export interface NewCase {
  title: string;
  counterparty_name: string;
  counterparty_email: string;
  counterparty_type: "person" | "organization";
  ask: string;
  amount_cents?: number | null;
  currency?: string;
  context?: string;
  tone?: Tone;
  scenario?: string | null;
}

const MAX_OPEN = { real: 5, demo: 4 } as const;

export async function createCase(user: UserRow, input: NewCase): Promise<{ ok: true; case: CaseRow } | { ok: false; error: string }> {
  const email = normalizeEmail(input.counterparty_email);
  if (!email) return { ok: false, error: "That email address does not look valid." };
  const title = input.title?.trim().slice(0, 100);
  const ask = input.ask?.trim().slice(0, 500);
  const name = input.counterparty_name?.trim().slice(0, 80);
  if (!title || !ask || !name) return { ok: false, error: "A case needs a title, who you are chasing, and what you want from them." };
  const rc = await checkRecipient(email, user, input.scenario ?? null);
  if (!rc.ok) return { ok: false, error: rc.reason };
  const open = await q1<{ n: string }>("SELECT count(*) AS n FROM cases WHERE user_id = $1 AND status NOT IN ('resolved','stopped','stalled')", [user.id]);
  if (Number(open?.n ?? 0) >= MAX_OPEN[user.kind]) return { ok: false, error: `You already have ${MAX_OPEN[user.kind]} open cases. Resolve or stop one first.` };

  const c = (await q1<CaseRow>(
    `INSERT INTO cases (user_id, title, counterparty_name, counterparty_email, counterparty_type, ask, amount_cents, currency, context, tone, scenario, clock_scale, status, mood)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planning','sniffing') RETURNING *`,
    [
      user.id, title, name, email, input.counterparty_type, ask,
      Number.isInteger(input.amount_cents) && input.amount_cents! > 0 && input.amount_cents! < 100_000_00 ? input.amount_cents : null,
      (input.currency || "USD").toUpperCase().slice(0, 3),
      (input.context ?? "").slice(0, 3000), input.tone ?? "polite", input.scenario ?? null,
      input.scenario ? env.demoClockScale : 1,
    ],
  ))!;
  await addEvent(c.id, "created", `Case opened: ${title}`, `Chasing ${name} for: ${ask}`);
  void kickoff(c.id).catch((e) => console.error("[kickoff]", e));
  return { ok: true, case: c };
}

/** Research the situation, build the plan, and start the first step. Runs in the background. */
export async function kickoff(caseId: string) {
  let c = (await getCase(caseId))!;
  const user = (await getUser(c.user_id))!;
  await addEvent(caseId, "researching", c.counterparty_type === "organization" ? `Researching ${c.counterparty_name}'s policy and your rights` : "Planning the nudges", null);
  const research: Research = await safely(
    "research",
    () => researchCase(c, c.scenario ? simPolicies(c.scenario) : []),
    { contacts: [], policies: c.scenario ? simPolicies(c.scenario) : [], clocks: [], regulators: [], searched_at: new Date().toISOString(), queries: [] } as Research,
  );
  c = await patchCase(caseId, { research });
  const found = research.policies.length + research.clocks.length + research.contacts.length + research.regulators.length;
  await addEvent(caseId, "researched", found ? `Found ${found} sourced fact${found === 1 ? "" : "s"}` : "No verified policy or rule found; sticking to the plain facts", null, { clocks: research.clocks.length, policies: research.policies.length });

  let plan: PlanStep[];
  let summary: string;
  try {
    const p = await makePlan(c, research, user);
    plan = p.steps;
    summary = p.summary;
  } catch (e) {
    console.error("[plan]", (e as Error).message);
    plan = fallbackPlan(c, user.autopilot);
    summary = `Follow up with ${c.counterparty_name} in a few polite, well-spaced steps.`;
  }
  c = await patchCase(caseId, { plan, summary, status: "waiting", mood: "napping", next_due_at: plan[0].due_at });
  await addEvent(caseId, "planned", `Plan ready: ${plan.filter((s) => s.kind !== "final").length} steps`, summary, { steps: plan.length });
  void runNextStep(caseId).catch((e) => console.error("[first step]", e));
}

/* ----------------------------------------------------------------------------------------------
 * The clock: tick() wakes cases whose next step is due
 * ---------------------------------------------------------------------------------------------- */

const inFlight = new Set<string>();

export async function runNextStep(caseId: string) {
  if (inFlight.has(caseId)) return;
  inFlight.add(caseId);
  try {
    const c = await getCase(caseId);
    if (!c || isClosed(c)) return;
    const step = c.plan.find((s) => s.status === "pending");
    if (!step) return;
    const run = await getMastra().getWorkflow("nudgeStep").createRun();
    const res = await run.start({ inputData: { caseId, stepId: step.id } });
    if (res.status === "failed") throw new Error(String((res as any).error?.message ?? (res as any).error ?? "workflow failed"));
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[run step]", msg);
    await addEvent(caseId, "error", "Something went wrong on this step; Badger will retry shortly", clip(msg, 300));
    await patchCase(caseId, { status: "waiting", mood: "worried", working_since: null, next_due_at: new Date(Date.now() + 90_000).toISOString() });
  } finally {
    inFlight.delete(caseId);
  }
}

let ticking = false;
let lastSweep = 0;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Wake due cases. SKIP LOCKED makes this safe even if two instances ever run.
    const due = await q<{ id: string }>(
      `UPDATE cases SET status = 'working', working_since = now()
       WHERE id IN (SELECT id FROM cases WHERE status = 'waiting' AND next_due_at <= now() ORDER BY next_due_at LIMIT 5 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
    );
    for (const { id } of due) void runNextStep(id);

    // Rosters: once a minute, open cases for anyone who has become overdue.
    if (Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      await import("./groups").then((m) => m.sweep()).catch((e) => console.error("[sweep]", e.message));
    }

    // Fast-forward (sandbox cases only): skip the waiting, and let Badger approve its own drafts so the story plays out.
    await q(`UPDATE cases SET next_due_at = now() WHERE autoplay AND scenario IS NOT NULL AND status = 'waiting' AND next_due_at > now()`);
    const auto = await q<{ id: string; kind: string; case_id: string }>(
      `SELECT a.id, a.kind, a.case_id FROM actions a JOIN cases c ON c.id = a.case_id
       WHERE c.autoplay AND c.scenario IS NOT NULL AND a.status = 'pending' AND a.created_at < now() - interval '2 seconds' LIMIT 5`,
    );
    for (const a of auto) {
      void addEvent(a.case_id, "fast_forward", "Fast-forward: approved for you", "In the sandbox, fast-forward approves Badger's drafts so you can watch the whole story.");
      void submitDecision(a.id, a.kind === "need_info" ? { decision: "approve", answer: "Yes, that is right." } : { decision: "approve" }).catch((e) => console.error("[fast-forward]", e.message));
    }

    // A run that died mid-step (restart, crash) leaves the case 'working': hand it back to the clock.
    await q(`UPDATE cases SET status = 'waiting', working_since = NULL, next_due_at = now() WHERE status = 'working' AND working_since < now() - interval '4 minutes'`);

    // Badger nags the human, too: a draft waiting for approval gets one reminder.
    const stale = await q<{ id: string; case_id: string; user_id: string; title: string; clock_scale: number }>(
      `SELECT a.id, a.case_id, c.user_id, c.title, c.clock_scale FROM actions a JOIN cases c ON c.id = a.case_id
       WHERE a.status = 'pending' AND a.reminded_at IS NULL AND a.created_at < now() - (interval '1 day' / c.clock_scale) * 2 AND a.created_at < now() - interval '15 seconds' LIMIT 5`,
    );
    for (const a of stale) {
      await q("UPDATE actions SET reminded_at = now() WHERE id = $1", [a.id]);
      const user = await getUser(a.user_id);
      if (user) await notifyUser(user, { id: a.case_id, title: a.title }, `Badger is waiting on you: "${a.title}"`, "A draft is ready and nothing goes out until you approve it. (Yes, Badger is nagging you now.)", { actionId: a.id });
    }
  } catch (e) {
    console.error("[tick]", (e as Error).message);
  } finally {
    ticking = false;
  }
}

/* ----------------------------------------------------------------------------------------------
 * Human decisions
 * ---------------------------------------------------------------------------------------------- */

export type Decision = { decision: "approve" | "skip"; subject?: string; body?: string; answer?: string };

export async function submitDecision(actionId: string, d: Decision): Promise<{ ok: true } | { ok: false; error: string }> {
  const act = await getAction(actionId);
  if (!act) return { ok: false, error: "That request no longer exists." };
  if (act.status !== "pending") return { ok: false, error: `Already ${act.status}.` };
  const c = await getCase(act.case_id);
  if (!c) return { ok: false, error: "Case not found." };

  if (act.kind === "confirm_resolution") {
    if (!(await decideAction(actionId, d.decision === "approve" ? "approved" : "skipped"))) return { ok: false, error: "Already decided." };
    if (d.decision === "approve") await resolveCase(c.id, "You confirmed it is sorted.");
    else await reopen(c.id, "You said it is not actually resolved yet.");
    return { ok: true };
  }
  if (act.kind === "need_info") {
    const answer = (d.answer ?? "").trim().slice(0, 800);
    if (d.decision === "approve" && !answer) return { ok: false, error: "Type your answer first." };
    if (!(await decideAction(actionId, d.decision === "approve" ? "approved" : "skipped"))) return { ok: false, error: "Already decided." };
    if (d.decision === "approve") {
      await patchCase(c.id, { context: `${c.context}\n\nClient answered "${clip(act.draft?.question ?? "", 120)}": ${answer}`.trim() });
      await insertStep(c.id, { kind: "email", level: 1, label: "Answer their question", intent: `Answer their question using the client's answer: ${answer}`, needs_approval: true }, 0);
      await addEvent(c.id, "answered", "You answered Badger's question", answer);
    }
    await patchCase(c.id, { status: "waiting", mood: "napping" });
    return { ok: true };
  }

  // Step approvals: claim the action first (so a double tap cannot send twice), then resume the suspended workflow run.
  const edited = d.decision === "approve" && (d.subject || d.body) ? { ...act.draft, subject: d.subject?.trim() || act.draft.subject, body: d.body?.trim() || act.draft.body } : undefined;
  const claimed = await decideAction(actionId, d.decision === "approve" ? "approved" : "skipped", edited);
  if (!claimed) return { ok: false, error: "Already decided." };
  if (!act.run_id) return { ok: false, error: "This request lost its run; skip it and let Badger re-plan." };
  await patchCase(c.id, { status: "working", mood: "nagging", working_since: new Date().toISOString() });
  try {
    const run = await getMastra().getWorkflow("nudgeStep").createRun({ runId: act.run_id });
    const res = await run.resume({ step: "gate", resumeData: { decision: d.decision, subject: edited?.subject, body: edited?.body, actionId } });
    if (res.status === "failed") throw new Error(String((res as any).error?.message ?? "resume failed"));
  } catch (e) {
    console.error("[resume]", (e as Error).message);
    await addEvent(c.id, "error", "Could not carry out that decision; Badger will retry", clip((e as Error).message, 300));
    await patchCase(c.id, { status: "waiting", working_since: null, next_due_at: new Date(Date.now() + 60_000).toISOString() });
    return { ok: false, error: "Something went wrong carrying that out. Badger will retry." };
  }
  return { ok: true };
}

/** Put a new step at the front of the queue (reactive moves like answering a question or using a form they pointed to). */
async function insertStep(caseId: string, s: Partial<PlanStep> & Pick<PlanStep, "kind" | "level" | "label" | "intent">, delayDays = 0): Promise<PlanStep> {
  const c = (await getCase(caseId))!;
  const step: PlanStep = {
    id: `x${Date.now().toString(36)}`, day: 0, recipient: null, needs_approval: true, status: "pending", due_at: new Date(Date.now() + delayDays * dayMs(c.clock_scale)).toISOString(), ...s,
  };
  const firstPending = c.plan.findIndex((p) => p.status === "pending");
  const plan = [...c.plan];
  plan.splice(firstPending < 0 ? plan.length : firstPending, 0, step);
  await patchCase(caseId, { plan, status: "waiting", mood: "napping", next_due_at: step.due_at, working_since: null });
  return step;
}

export async function resolveCase(caseId: string, why: string) {
  const c = (await getCase(caseId))!;
  const plan = c.plan.map((s) => (s.status === "pending" ? { ...s, status: "skipped" as const } : s));
  await patchCase(caseId, { plan, status: "resolved", mood: "victory", resolved_at: new Date().toISOString(), next_due_at: null, working_since: null });
  await q("UPDATE actions SET status = 'expired', decided_at = now() WHERE case_id = $1 AND status = 'pending'", [caseId]);
  await addEvent(caseId, "resolved", "Resolved", why);
  if (c.member_id) await import("./groups").then((m) => m.settleFromCase(c)).catch((e) => console.error("[settle]", e.message));
  const user = await getUser(c.user_id);
  if (user) await notifyUser(user, c, `Resolved: "${c.title}"`, `${why} Nicely done, and Badger did the awkward part.`);
}

async function reopen(caseId: string, why: string) {
  await addEvent(caseId, "reopened", "Not resolved yet", why);
  await insertStep(caseId, { kind: "email", level: 2, label: "Follow up: not actually resolved", intent: "They said it was resolved but the client says it is not. Politely but firmly ask what happens next and when, referring to what they said.", needs_approval: true }, 1);
}

export async function stopCase(caseId: string, why: string, by: "user" | "them" = "user") {
  const c = (await getCase(caseId))!;
  const plan = c.plan.map((s) => (s.status === "pending" ? { ...s, status: "skipped" as const } : s));
  await patchCase(caseId, { plan, status: "stopped", mood: "napping", next_due_at: null, working_since: null });
  await q("UPDATE actions SET status = 'expired', decided_at = now() WHERE case_id = $1 AND status = 'pending'", [caseId]);
  await addEvent(caseId, "stopped", by === "user" ? "You stopped this case" : "Stopped", why);
  if (c.member_id && by === "user") {
    // Stopping a roster case means "leave this person alone": pause their reminders until the owner turns them back on.
    await q("UPDATE members SET reminders_paused = true WHERE id = $1", [c.member_id]);
    await addEvent(caseId, "paused", "Reminders paused for this person", "Badger will not open a new case for them until you resume reminders on the roster.");
  }
}

/* ----------------------------------------------------------------------------------------------
 * Replies
 * ---------------------------------------------------------------------------------------------- */

/** Entry point for every inbound AgentMail message (webhook or reconcile poll). Idempotent. */
export async function handleInbound(inboxId: string, messageId: string) {
  const first = await q1("INSERT INTO seen_messages (am_message_id, inbox_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING am_message_id", [messageId, inboxId]);
  if (!first) return;
  const m = await getMessage(inboxId, messageId);
  if (m.labels?.includes("sent")) return;
  const from = normalizeEmail(m.from);
  if (!from) return;
  // Sandbox characters receive mail FROM Badger, so route them before the "ignore our own mail" check.
  if (SIM_INBOXES.has(inboxId.toLowerCase())) return simRespond(inboxId, m);
  if (from === env.agentmailInbox.toLowerCase()) return;
  if (inboxId.toLowerCase() !== env.agentmailInbox.toLowerCase()) return;
  await onCaseReply(m, from);
}

async function findCaseFor(m: MailMessage, from: string): Promise<CaseRow | null> {
  const byThread = await q1<CaseRow>(
    `SELECT c.* FROM cases c JOIN messages x ON x.case_id = c.id WHERE x.am_thread_id = $1 ORDER BY x.id DESC LIMIT 1`,
    [m.thread_id],
  );
  if (byThread) return byThread;
  return q1<CaseRow>(`SELECT * FROM cases WHERE counterparty_email = $1 AND status NOT IN ('resolved','stopped') ORDER BY created_at DESC LIMIT 1`, [from]);
}

async function onCaseReply(m: MailMessage, from: string) {
  const c = await findCaseFor(m, from);
  if (!c) {
    console.log("[inbound] no case for", from);
    return;
  }
  const text = freshText(m);
  const stored = await addMessage({ caseId: c.id, direction: "in", from, to: m.to ?? [], subject: m.subject ?? null, body: text || "(empty message)", amMessageId: m.message_id, amThreadId: m.thread_id });
  if (!stored) return;
  await addEvent(c.id, "reply", `${c.counterparty_name} replied`, clip(text, 700), { from });
  if (isClosed(c)) return;

  if (looksLikeStop(text)) return honorStop(c, from, text);

  const cls = await safely<Classification | null>("classify", () => classifyReply(c, text), null);
  if (!cls) {
    await patchCase(c.id, { mood: "worried" });
    const user = await getUser(c.user_id);
    if (user) await notifyUser(user, c, `${c.counterparty_name} replied`, `Badger could not read this one automatically. They wrote:\n\n${clip(text, 600)}`);
    return;
  }
  await addEvent(c.id, "classified", `Badger's read: ${cls.intent}`, cls.summary, { intent: cls.intent });
  await applyReply(c, cls, from);
}

async function honorStop(c: CaseRow, from: string, text: string) {
  await q("INSERT INTO suppressions (email, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from, "asked to stop"]);
  await stopCase(c.id, `${c.counterparty_name} asked not to be contacted. Badger respects that and has stopped. They wrote: "${clip(text, 200)}"`, "them");
  const user = await getUser(c.user_id);
  if (user) await notifyUser(user, c, `Stopped: ${c.counterparty_name} asked not to be contacted`, `Badger has stopped emailing them, for good. If this matters, take it up directly or with a third party.`);
}

function shiftPending(plan: PlanStep[], notBeforeMs: number): PlanStep[] {
  const idx = plan.findIndex((s) => s.status === "pending");
  if (idx < 0) return plan;
  const cur = new Date(plan[idx].due_at).getTime();
  if (cur >= notBeforeMs) return plan;
  const delta = notBeforeMs - cur;
  return plan.map((s, i) => (i >= idx && s.status === "pending" ? { ...s, due_at: new Date(new Date(s.due_at).getTime() + delta).toISOString() } : s));
}

export async function applyReply(c: CaseRow, cls: Classification, from: string) {
  const user = (await getUser(c.user_id))!;
  const day = dayMs(c.clock_scale);
  await q("UPDATE actions SET status = 'expired', decided_at = now() WHERE case_id = $1 AND status = 'pending' AND kind IN ('email','escalate_email','web_form')", [c.id]);

  switch (cls.intent) {
    case "resolved": {
      const act = await createAction(c.id, "confirm_resolution", { summary: cls.summary });
      await patchCase(c.id, { status: "awaiting_confirmation", mood: "worried", next_due_at: null });
      await addEvent(c.id, "claimed_resolved", "They say it's sorted. Waiting for your confirmation", cls.summary, { action_id: act.id });
      await notifyUser(user, c, `${c.counterparty_name} says it's resolved`, `${cls.summary}\n\nConfirm it is really done (money in, cancellation confirmed, etc.) and Badger closes the case.`, { actionId: act.id });
      return;
    }
    case "promise":
    case "auto_reply": {
      if (cls.promised_in_days && cls.promised_in_days > 0) {
        const plan = shiftPending(c.plan, Date.now() + (cls.promised_in_days + 1) * day);
        const next = plan.find((s) => s.status === "pending");
        await patchCase(c.id, { plan, status: "waiting", mood: "napping", next_due_at: next?.due_at ?? null });
        await addEvent(c.id, "waiting", `Giving them until day ${cls.promised_in_days + 1}`, "They gave a time frame, so Badger holds off until it passes.");
      } else {
        await patchCase(c.id, { status: "waiting", mood: "napping" });
      }
      return;
    }
    case "refusal": {
      const plan = c.plan.map((s) => ({ ...s }));
      const i = plan.findIndex((s) => s.status === "pending");
      if (i >= 0) {
        plan[i].level = Math.min(c.counterparty_type === "person" ? 2 : 3, Math.max(plan[i].level, 2)) as 1 | 2 | 3;
        plan[i].due_at = new Date(Date.now() + day).toISOString();
        plan[i].intent = `${plan[i].intent} They refused: "${clip(cls.summary, 160)}". Respond calmly to their stated reason.`;
      }
      await patchCase(c.id, { plan, status: "waiting", mood: "grumpy", next_due_at: plan[i]?.due_at ?? null });
      await notifyUser(user, c, `${c.counterparty_name} said no`, `${cls.summary}\n\nBadger will push back, firmly but fairly, with your approval.`);
      return;
    }
    case "redirect": {
      const url = cls.suggested_url;
      const mail = normalizeEmail(cls.suggested_email);
      if (url && !mail) {
        await insertStep(c.id, { kind: "web_form", level: 1, label: "Use their web form", intent: "They only accept this through a web form. State the request completely and clearly.", recipient: url, needs_approval: true });
        await addEvent(c.id, "rerouted", "They pointed to a web form", `Badger will fill it for you (with your OK): ${url}`);
      } else if (mail && mail !== c.counterparty_email) {
        await insertStep(c.id, { kind: "escalate_email", level: 1, label: "Use the address they gave", intent: "They told us to use this address instead. Restate the request completely.", recipient: mail, needs_approval: true });
        await addEvent(c.id, "rerouted", "They gave a different address", mail);
      } else {
        await patchCase(c.id, { status: "waiting", mood: "napping" });
      }
      await notifyUser(user, c, `${c.counterparty_name} redirected Badger`, cls.summary);
      return;
    }
    case "question": {
      if (cls.needs_user && cls.question_for_user) {
        const act = await createAction(c.id, "need_info", { question: cls.question_for_user, from_them: cls.summary });
        await patchCase(c.id, { status: "awaiting_approval", mood: "worried", next_due_at: null });
        await addEvent(c.id, "need_info", "Badger needs an answer from you", cls.question_for_user, { action_id: act.id });
        await notifyUser(user, c, `Badger needs your help on "${c.title}"`, `${c.counterparty_name} asked: ${cls.question_for_user}`, { actionId: act.id });
      } else {
        await insertStep(c.id, { kind: "email", level: 1, label: "Answer their question", intent: `They asked: ${cls.summary}. Answer using only the known facts.`, needs_approval: true });
      }
      return;
    }
    case "hostile": {
      await stopCase(c.id, `The reply was hostile, so Badger paused. They wrote something like: ${cls.summary}`, "them");
      await notifyUser(user, c, `Badger paused "${c.title}"`, `The reply was hostile: ${cls.summary}\n\nBadger will not engage further without you. Your call on what to do next.`);
      return;
    }
    case "stop": {
      await honorStop(c, from, cls.summary);
      return;
    }
    default: {
      // stall / other: keep the schedule. The next nudge is already on the clock.
      await patchCase(c.id, { status: "waiting", mood: "napping" });
      await addEvent(c.id, "waiting", "Noted. The next nudge stays on schedule", cls.summary);
    }
  }
}

export { classifySchema };

/* ----------------------------------------------------------------------------------------------
 * Reconcile: belt and braces for webhooks
 * ---------------------------------------------------------------------------------------------- */

import { listRecentMessages } from "./mail";

/** Polls the inboxes we care about for anything the webhook missed. Cheap: one list call per inbox. */
export async function reconcile(inboxes: string[]) {
  for (const inbox of inboxes) {
    try {
      const list = await listRecentMessages(inbox, 12);
      for (const m of list) {
        if (m.labels?.includes("sent")) continue;
        const seen = await q1("SELECT 1 FROM seen_messages WHERE am_message_id = $1", [m.message_id]);
        if (!seen) await handleInbound(inbox, m.message_id);
      }
    } catch (e) {
      console.error("[reconcile]", inbox, (e as Error).message);
    }
  }
}
