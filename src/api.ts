import { Hono, type Context } from "hono";
import { createUIMessageStreamResponse } from "ai";
import { handleChatStream } from "@mastra/ai-sdk";
import { RequestContext } from "@mastra/core/request-context";
import { Webhook } from "svix";
import { clearSession, consumeMagicToken, createDemoUser, issueSession, requestMagicLink, requireUser, sessionMiddleware, type Vars } from "./auth";
import { overLimit, q, q1 } from "./db";
import { createCase, handleInbound, resolveCase, stopCase, submitDecision } from "./engine";
import { env } from "./env";
import { getMastra } from "./registry";
import { readActionToken } from "./notify";
import { gymContactPage, gymFormSubmitted, gymPolicyPage, gymThanksPage, listScenarios, SCENARIOS } from "./sim";
import { addEvent, getAction, getCase, getUser, patchCase, publicCase, type ActionRow } from "./store";
import type { CaseRow, UserRow } from "./types";

type Env = { Variables: Vars };
export const api = new Hono<Env>();
api.use("*", sessionMiddleware);

const ip = (c: Context) => c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, kind: u.kind, autopilot: u.autopilot });

api.get("/healthz", (c) => c.json({ ok: true }));

/* ------------------------------------ auth ------------------------------------ */

api.get("/api/me", (c) => {
  const u = c.get("user");
  return c.json({ user: u ? publicUser(u) : null });
});

api.post("/api/auth/request", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await requestMagicLink(String(b.email ?? ""), b.name ? String(b.name) : null, ip(c)).catch((e) => ({ ok: false as const, error: String(e.message) }));
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
});

api.get("/auth/verify", async (c) => {
  const user = await consumeMagicToken(c.req.query("token") ?? "");
  if (!user) return c.redirect("/?signin=expired");
  issueSession(c, user.id);
  return c.redirect("/app");
});

api.post("/api/auth/demo", async (c) => {
  if (await overLimit(`demo:${ip(c)}`, 120, 3600_000)) return c.json({ error: "Too many demo sessions from your network. Try again later." }, 429);
  const existing = c.get("user");
  if (existing) return c.json({ user: publicUser(existing) });
  const u = await createDemoUser();
  issueSession(c, u.id);
  return c.json({ user: publicUser(u) });
});

api.post("/api/auth/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

api.patch("/api/me", requireUser, async (c) => {
  const u = c.get("user")!;
  const b = await c.req.json().catch(() => ({}));
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : u.name;
  const autopilot = b.autopilot === "followups" || b.autopilot === "ask" ? b.autopilot : u.autopilot;
  const row = await q1<UserRow>("UPDATE users SET name = $2, autopilot = $3 WHERE id = $1 RETURNING *", [u.id, name, autopilot]);
  return c.json({ user: publicUser(row!) });
});

/* ------------------------------------ cases ------------------------------------ */

const ownCase = async (c: Context<Env>): Promise<CaseRow | null> => {
  const u = c.get("user")!;
  const row = await getCase(c.req.param("id") ?? "");
  return row && row.user_id === u.id ? row : null;
};

api.get("/api/scenarios", (c) => c.json({ scenarios: listScenarios(), demoClock: { day_seconds: Math.round(86400 / env.demoClockScale) } }));

api.get("/api/cases", requireUser, async (c) => {
  const u = c.get("user")!;
  const rows = await q<CaseRow & { pending: string }>(
    `SELECT c.*, (SELECT count(*) FROM actions a WHERE a.case_id = c.id AND a.status = 'pending') AS pending FROM cases c WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
    [u.id],
  );
  return c.json({ cases: rows.map((r) => ({ ...publicCase(r), pending: Number(r.pending) })) });
});

api.post("/api/cases", requireUser, async (c) => {
  const u = c.get("user")!;
  const b = await c.req.json().catch(() => ({}));
  const sandbox = Object.values(SCENARIOS).find((s) => s.inbox.toLowerCase() === String(b.counterparty_email ?? "").trim().toLowerCase());
  const res = await createCase(u, {
    title: String(b.title ?? ""),
    counterparty_name: String(b.counterparty_name ?? ""),
    counterparty_email: String(b.counterparty_email ?? ""),
    counterparty_type: b.counterparty_type === "person" ? "person" : "organization",
    ask: String(b.ask ?? ""),
    amount_cents: b.amount != null && b.amount !== "" ? Math.round(Number(b.amount) * 100) : null,
    currency: b.currency ? String(b.currency) : "USD",
    context: String(b.context ?? ""),
    tone: b.tone === "firm" || b.tone === "badger" ? b.tone : "polite",
    scenario: u.kind === "demo" && sandbox ? sandbox.key : null,
  });
  return res.ok ? c.json({ case: publicCase(res.case) }, 201) : c.json({ error: res.error }, 400);
});

api.post("/api/demo/start", requireUser, async (c) => {
  const u = c.get("user")!;
  const b = await c.req.json().catch(() => ({}));
  const sc = SCENARIOS[String(b.scenario)];
  if (!sc) return c.json({ error: "Unknown scenario." }, 400);
  if (await overLimit(`demo-start:${u.id}`, 10, 3600_000)) return c.json({ error: "That's plenty of demos for one hour." }, 429);
  const res = await createCase(u, { ...sc.case, counterparty_email: sc.inbox, scenario: sc.key });
  return res.ok ? c.json({ case: publicCase(res.case) }, 201) : c.json({ error: res.error }, 400);
});

api.get("/api/cases/:id", requireUser, async (c) => {
  const row = await ownCase(c);
  if (!row) return c.json({ error: "Not found." }, 404);
  const [events, messages, actions] = await Promise.all([
    q("SELECT id, ts, type, title, body, meta FROM events WHERE case_id = $1 ORDER BY id", [row.id]),
    q("SELECT id, direction, from_addr, to_addrs, subject, body, ts FROM messages WHERE case_id = $1 ORDER BY id", [row.id]),
    q<ActionRow>("SELECT * FROM actions WHERE case_id = $1 AND status = 'pending' ORDER BY created_at", [row.id]),
  ]);
  return c.json({ case: publicCase(row), events, messages, actions: actions.map((a) => ({ id: a.id, kind: a.kind, draft: a.draft, created_at: a.created_at, step_id: a.step_id })) });
});

api.post("/api/cases/:id/stop", requireUser, async (c) => {
  const row = await ownCase(c);
  if (!row) return c.json({ error: "Not found." }, 404);
  await stopCase(row.id, "You told Badger to stop.");
  return c.json({ ok: true });
});

api.post("/api/cases/:id/fast-forward", requireUser, async (c) => {
  const row = await ownCase(c);
  if (!row) return c.json({ error: "Not found." }, 404);
  if (!row.scenario) return c.json({ error: "Fast-forward only exists in the sandbox demo. Real cases run on a real clock." }, 400);
  if (["resolved", "stopped"].includes(row.status)) return c.json({ ok: true });
  await patchCase(row.id, { autoplay: true, ...(row.status === "waiting" ? { next_due_at: new Date().toISOString() } : {}) });
  await addEvent(row.id, "fast_forward", "Fast-forward on", "Badger skips the waiting and approves its own drafts. Watch the timeline race to the end.");
  return c.json({ ok: true });
});

api.post("/api/cases/:id/resolve", requireUser, async (c) => {
  const row = await ownCase(c);
  if (!row) return c.json({ error: "Not found." }, 404);
  await resolveCase(row.id, "You marked this as resolved.");
  return c.json({ ok: true });
});

/* ------------------------------ approvals (cookie or email token) ------------------------------ */

async function actionAccess(c: Context<Env>, id: string, token?: string | null): Promise<{ act: ActionRow; user: UserRow } | null> {
  const act = await getAction(id);
  if (!act) return null;
  const cs = await getCase(act.case_id);
  if (!cs) return null;
  const sess = c.get("user");
  if (sess && sess.id === cs.user_id) return { act, user: sess };
  if (token && readActionToken(token) === id) {
    const u = await getUser(cs.user_id);
    return u ? { act, user: u } : null;
  }
  return null;
}

/** For the one-tap email page: the token itself is the credential, so no sign-in is needed. */
api.get("/api/a/:token", async (c) => {
  const id = readActionToken(c.req.param("token"));
  if (!id) return c.json({ error: "This link has expired. Open Badger to see the case." }, 410);
  const acc = await actionAccess(c, id, c.req.param("token"));
  if (!acc) return c.json({ error: "Not found." }, 404);
  const cs = (await getCase(acc.act.case_id))!;
  return c.json({ action: { id: acc.act.id, kind: acc.act.kind, status: acc.act.status, draft: acc.act.draft }, case: { id: cs.id, title: cs.title, counterparty_name: cs.counterparty_name, ask: cs.ask } });
});

api.post("/api/actions/:id/decide", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const acc = await actionAccess(c, c.req.param("id"), typeof b.token === "string" ? b.token : null);
  if (!acc) return c.json({ error: "Not allowed." }, 403);
  if (await overLimit(`decide:${acc.user.id}`, 60, 3600_000)) return c.json({ error: "Slow down a little." }, 429);
  const res = await submitDecision(acc.act.id, {
    decision: b.decision === "skip" ? "skip" : "approve",
    subject: typeof b.subject === "string" ? b.subject : undefined,
    body: typeof b.body === "string" ? b.body : undefined,
    answer: typeof b.answer === "string" ? b.answer : undefined,
  });
  return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 409);
});

/* ------------------------------------ notifications ------------------------------------ */

api.get("/api/notifications", requireUser, async (c) => {
  const u = c.get("user")!;
  const rows = await q("SELECT id, case_id, ts, subject, body, link, read_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 30", [u.id]);
  return c.json({ notifications: rows });
});
api.post("/api/notifications/read", requireUser, async (c) => {
  await q("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [c.get("user")!.id]);
  return c.json({ ok: true });
});

/* ------------------------------------ chat (assistant-ui) ------------------------------------ */

api.post("/api/chat", requireUser, async (c) => {
  const u = c.get("user")!;
  if (await overLimit(`chat:${u.id}`, 60, 3600_000)) return c.json({ error: "That's a lot of chatting for one hour. Try again soon." }, 429);
  const body = await c.req.json().catch(() => null);
  if (!body?.messages?.length) return c.json({ error: "No messages." }, 400);
  const rc = new RequestContext();
  rc.set("userId", u.id);
  const stream = await handleChatStream({
    mastra: getMastra(),
    agentId: "intake",
    version: "v7",
    params: { messages: body.messages, trigger: body.trigger, requestContext: rc } as any,
  });
  return createUIMessageStreamResponse({ stream });
});

/* ------------------------------------ AgentMail webhook ------------------------------------ */

api.post("/api/webhooks/agentmail", async (c) => {
  const raw = await c.req.text();
  if (env.agentmailWebhookSecret) {
    try {
      new Webhook(env.agentmailWebhookSecret).verify(raw, Object.fromEntries(c.req.raw.headers) as Record<string, string>);
    } catch {
      return c.json({ error: "bad signature" }, 400);
    }
  } else if (env.isProd) {
    return c.json({ error: "webhook secret not configured" }, 503);
  }
  let ev: any;
  try {
    ev = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  if (ev.event_type === "message.received" && ev.message?.inbox_id && ev.message?.message_id) {
    void handleInbound(ev.message.inbox_id, ev.message.message_id).catch((e) => console.error("[webhook inbound]", e.message));
  } else if (ev.event_type === "message.bounced") {
    const mid = ev.bounce?.message_id ?? ev.message?.message_id;
    void (async () => {
      const m = mid ? await q1<{ case_id: string }>("SELECT case_id FROM messages WHERE am_message_id = $1", [mid]) : null;
      if (!m) return;
      const cs = await getCase(m.case_id);
      if (!cs) return;
      await addEvent(cs.id, "bounced", "That email bounced", "The address may be wrong or unreachable. Check it and tell Badger the right one.");
      const u = await getUser(cs.user_id);
      const { notifyUser } = await import("./notify");
      if (u) await notifyUser(u, cs, `Email to ${cs.counterparty_name} bounced`, "The address may be wrong or no longer in use. Open the case to fix it.");
    })().catch(() => {});
  }
  return c.json({ ok: true });
});

/* ------------------------------------ the sandbox gym's website ------------------------------------ */

api.get("/sim/gym/policy", (c) => c.html(gymPolicyPage()));
api.get("/sim/gym/contact", (c) => c.html(gymContactPage()));
api.post("/sim/gym/contact", async (c) => {
  const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
  void gymFormSubmitted(form);
  return c.html(gymThanksPage());
});
