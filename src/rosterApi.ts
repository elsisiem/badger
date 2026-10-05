import { Hono, type Context } from "hono";
import { requireUser, sessionMiddleware, type Vars } from "./auth";
import { q, q1, overLimit } from "./db";
import { env } from "./env";
import {
  CHANNELS, channelAvailable, createLinkCode, getTelegramUsername, listLinks, onChannelMessage, onTelegramCallback, unlink, verifySlack, verifyTelegram, verifyTwilio, type Channel,
} from "./channels";
import {
  addMembers, createGroup, getGroup, groupsOverview, logCharge, markPaid, membersOf, parseRoster, recentCharges, syncMember, updateGroup, updateMember, voidCharge,
} from "./groups";
import { scenarioForInbox } from "./sim";
import { patchCase } from "./store";
import type { UserRow } from "./types";

type E = { Variables: Vars };
export const rosterApi = new Hono<E>();
rosterApi.use("*", sessionMiddleware);

const me = (c: Context<E>) => c.get("user") as UserRow;
const toCents = (v: unknown): number | undefined => (v !== null && v !== undefined && v !== "" && isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) : undefined);
const bad = (c: Context<E>, error: string, status = 400) => c.json({ error }, status as 400);

/* ------------------------------------ groups ------------------------------------ */

rosterApi.get("/api/groups", requireUser, async (c) => c.json({ groups: await groupsOverview(me(c).id) }));

rosterApi.post("/api/groups", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await createGroup(me(c), {
    name: String(b.name ?? ""), kind: b.kind, default_amount_cents: toCents(b.default_amount) ?? null, currency: b.currency, grace_days: b.grace_days, repeat_days: b.repeat_days,
    max_reminders: b.max_reminders, tone: b.tone, payment_note: b.payment_note, consent: b.consent === true,
  });
  if (!r.ok) return bad(c, r.error);
  if (typeof b.roster === "string" && b.roster.trim()) await addMembers(me(c), r.group.id, parseRoster(b.roster));
  return c.json({ group: r.group }, 201);
});

rosterApi.get("/api/groups/:id", requireUser, async (c) => {
  const g = await getGroup(me(c).id, c.req.param("id"));
  if (!g) return bad(c, "Not found.", 404);
  const members = await membersOf(g.id);
  return c.json({ group: g, members, charges: await recentCharges(g.id), owed_cents: members.reduce((s, m) => s + m.owed_cents, 0) });
});

rosterApi.patch("/api/groups/:id", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await updateGroup(me(c), c.req.param("id"), {
    name: b.name, payment_note: b.payment_note, grace_days: b.grace_days, repeat_days: b.repeat_days, max_reminders: b.max_reminders, tone: b.tone,
    default_amount_cents: b.default_amount !== undefined ? toCents(b.default_amount) ?? null : undefined, auto_send: typeof b.auto_send === "boolean" ? b.auto_send : undefined, archived: b.archived,
  });
  return r.ok ? c.json({ group: r.group }) : bad(c, r.error);
});

rosterApi.post("/api/groups/:id/members", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const list = typeof b.text === "string" ? parseRoster(b.text) : Array.isArray(b.members) ? b.members : [];
  if (!list.length) return bad(c, "Add at least one person, one per line: Name, email");
  const r = await addMembers(me(c), c.req.param("id"), list);
  return r.ok ? c.json({ added: r.added.length, skipped: r.skipped }) : bad(c, r.error);
});

rosterApi.patch("/api/members/:id", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await updateMember(me(c), c.req.param("id"), {
    name: b.name, email: b.email, payer_name: b.payer_name, notes: b.notes, active: typeof b.active === "boolean" ? b.active : undefined,
    reminders_paused: typeof b.reminders_paused === "boolean" ? b.reminders_paused : undefined,
  });
  return r.ok ? c.json({ member: r.member }) : bad(c, r.error);
});

/** Log one item for one or several people at once. */
rosterApi.post("/api/groups/:id/charges", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const g = await getGroup(me(c).id, c.req.param("id"));
  if (!g) return bad(c, "Not found.", 404);
  const ids: string[] = Array.isArray(b.member_ids) ? b.member_ids.map(String) : [];
  if (!ids.length) return bad(c, "Pick at least one person.");
  const results = [];
  for (const id of ids) {
    const ok = await q1("SELECT 1 FROM members WHERE id = $1 AND group_id = $2 AND user_id = $3", [id, g.id, me(c).id]);
    if (!ok) continue;
    results.push(await logCharge(me(c), id, { description: b.description, amount_cents: toCents(b.amount), incurred_on: b.date }));
  }
  const failed = results.find((r) => !r.ok);
  return failed && !failed.ok ? bad(c, failed.error) : c.json({ logged: results.length });
});

rosterApi.post("/api/members/:id/paid", requireUser, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await markPaid(me(c), c.req.param("id"), toCents(b.amount));
  return r.ok ? c.json({ applied_cents: r.applied_cents, remaining_cents: r.remaining_cents }) : bad(c, r.error);
});

rosterApi.delete("/api/charges/:id", requireUser, async (c) => {
  const r = await voidCharge(me(c), c.req.param("id"));
  return r.ok ? c.json({ ok: true }) : bad(c, r.error);
});

/** Sandbox: skip the waiting on every open roster case in this group. */
rosterApi.post("/api/groups/:id/fast-forward", requireUser, async (c) => {
  const g = await getGroup(me(c).id, c.req.param("id"));
  if (!g) return bad(c, "Not found.", 404);
  const rows = await q<{ id: string; status: string }>("SELECT id, status FROM cases WHERE group_id = $1 AND scenario IS NOT NULL AND status NOT IN ('resolved','stopped','stalled')", [g.id]);
  for (const r of rows) await patchCase(r.id, { autoplay: true, ...(r.status === "waiting" ? { next_due_at: new Date().toISOString() } : {}) });
  return c.json({ fast_forwarded: rows.length });
});

/** The teacher demo: a ready-made roster whose students are sandbox parents. Everything else is the real machinery. */
rosterApi.post("/api/demo/teacher", requireUser, async (c) => {
  const u = me(c);
  if (await overLimit(`demo-teacher:${u.id}`, 4, 3600_000)) return bad(c, "That's plenty of rosters for one hour.", 429);
  const g = await createGroup(u, { name: "Piano lessons", kind: "students", default_amount_cents: 4000, grace_days: 0, repeat_days: 2, max_reminders: 3, payment_note: "Bank transfer, or cash at the next lesson.", consent: true });
  if (!g.ok) return bad(c, g.error);
  await updateGroup(u, g.group.id, { auto_send: true });
  const added = await addMembers(u, g.group.id, [
    { name: "Mia Lee", payer_name: "Mrs. Lee", email: env.simInboxes.parentLee },
    { name: "Leo Ortiz", payer_name: "Mr. Ortiz", email: env.simInboxes.parentOrtiz },
  ]);
  if (!added.ok) return bad(c, added.error);
  const [mia, leo] = added.added;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  await logCharge(u, mia.id, { description: "Piano lesson", amount_cents: 4000, incurred_on: day(12) });
  await logCharge(u, mia.id, { description: "Piano lesson", amount_cents: 4000, incurred_on: day(5) });
  await logCharge(u, leo.id, { description: "Piano lesson", amount_cents: 4000, incurred_on: day(8) });
  void scenarioForInbox; // the sandbox parents are matched by inbox inside syncMember
  return c.json({ group: g.group }, 201);
});

/* ------------------------------------ chat apps ------------------------------------ */

rosterApi.get("/api/channels", requireUser, async (c) => {
  const links = await listLinks(me(c).id);
  return c.json({
    channels: CHANNELS.map((ch) => ({ channel: ch, available: channelAvailable(ch), linked: links.filter((l) => l.channel === ch).map((l) => ({ label: l.label, since: l.created_at })) })),
    telegram_bot: getTelegramUsername() || null,
    whatsapp_number: env.twilioWhatsappFrom.replace(/^whatsapp:/, "") || null,
  });
});

rosterApi.post("/api/channels/:channel/link-code", requireUser, async (c) => {
  const ch = c.req.param("channel") as Channel;
  if (!CHANNELS.includes(ch) || !channelAvailable(ch)) return bad(c, "That chat app isn't set up on this server yet. See the setup guide in the repo (docs/CHANNELS.md).");
  if (await overLimit(`linkcode:${me(c).id}`, 12, 3600_000)) return bad(c, "Too many codes. Try again in a bit.", 429);
  const code = await createLinkCode(me(c).id, ch);
  const bot = getTelegramUsername();
  return c.json({
    code, expires_in_minutes: 10,
    instructions: ch === "telegram" ? `Open Telegram and send /start ${code} to @${bot}` : ch === "slack" ? `Open a direct message with the Badger app in Slack and send: link ${code}` : `Send "link ${code}" on WhatsApp to ${env.twilioWhatsappFrom.replace(/^whatsapp:/, "")}`,
    deep_link: ch === "telegram" && bot ? `https://t.me/${bot}?start=${code}` : null,
  });
});

rosterApi.delete("/api/channels/:channel", requireUser, async (c) => {
  const ch = c.req.param("channel") as Channel;
  if (!CHANNELS.includes(ch)) return bad(c, "Unknown chat app.");
  await unlink(me(c).id, ch);
  return c.json({ ok: true });
});

/* ------------------------------------ webhooks ------------------------------------ */

rosterApi.post("/api/channels/telegram", async (c) => {
  if (!verifyTelegram(c.req.header("x-telegram-bot-api-secret-token"))) return c.json({ error: "forbidden" }, 403);
  const u: any = await c.req.json().catch(() => null);
  if (u?.callback_query?.data && u.callback_query.message?.chat?.id) {
    void onTelegramCallback(String(u.callback_query.message.chat.id), u.callback_query.id, u.callback_query.data).catch((e) => console.error("[tg cb]", e.message));
  } else if (u?.message?.text && u.message.chat?.id && u.message.chat.type === "private") {
    void onChannelMessage({ channel: "telegram", externalId: String(u.message.chat.id), text: u.message.text, label: u.message.from?.username ? "@" + u.message.from.username : u.message.from?.first_name ?? null }).catch((e) => console.error("[tg msg]", e.message));
  }
  return c.json({ ok: true });
});

const seenSlack = new Set<string>();
rosterApi.post("/api/channels/slack/events", async (c) => {
  const raw = await c.req.text();
  if (!verifySlack(raw, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature"))) return c.json({ error: "forbidden" }, 403);
  const body: any = JSON.parse(raw || "{}");
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });
  const ev = body.event;
  if (body.type === "event_callback" && ev?.type === "message" && ev.channel_type === "im" && !ev.bot_id && !ev.subtype && typeof ev.text === "string") {
    if (body.event_id && seenSlack.has(body.event_id)) return c.json({ ok: true });
    if (body.event_id) { seenSlack.add(body.event_id); if (seenSlack.size > 500) seenSlack.clear(); }
    void onChannelMessage({ channel: "slack", externalId: ev.channel, text: ev.text, label: ev.user ?? null }).catch((e) => console.error("[slack msg]", e.message));
  }
  return c.json({ ok: true });
});

rosterApi.post("/api/channels/whatsapp", async (c) => {
  const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
  if (!verifyTwilio(`${env.publicUrl}/api/channels/whatsapp`, form, c.req.header("x-twilio-signature"))) return c.text("forbidden", 403);
  if (form.From && form.Body) void onChannelMessage({ channel: "whatsapp", externalId: form.From, text: form.Body, label: form.ProfileName ?? form.From }).catch((e) => console.error("[wa msg]", e.message));
  return c.body("<Response></Response>", 200, { "content-type": "text/xml" });
});

void q;
