import { createHmac } from "node:crypto";
import { q, q1 } from "./db";
import { env } from "./env";
import { groupsOverview, money } from "./groups";
import { getMastra } from "./registry";
import { RequestContext } from "@mastra/core/request-context";
import { submitDecision } from "./engine";
import { approveLink } from "./notify";
import type { UserRow } from "./types";
import { clip, randomToken, safeEqual, safely } from "./util";

/**
 * Chat apps. Telegram, Slack and WhatsApp all funnel into one router, so the behaviour is identical everywhere:
 *   - "link CODE" connects the chat to your Badger account (the code comes from the app, valid 10 minutes)
 *   - "approve" / "skip" answer the draft Badger is waiting on
 *   - "who owes me?" / "status" answer straight from the ledger
 *   - anything else goes to the Badger agent, which can log lessons, mark people paid, open cases...
 * Each channel switches on only when its credentials are configured.
 */

export type Channel = "telegram" | "slack" | "whatsapp";
export const CHANNELS: Channel[] = ["telegram", "slack", "whatsapp"];

export const channelAvailable = (c: Channel): boolean =>
  c === "telegram" ? !!env.telegramToken : c === "slack" ? !!(env.slackBotToken && env.slackSigningSecret) : !!(env.twilioSid && env.twilioToken && env.twilioWhatsappFrom);

let telegramUsername = "";
export const getTelegramUsername = () => telegramUsername;

/* ------------------------------------ outbound ------------------------------------ */

interface Btn { label: string; data: string }

async function tg(method: string, body: object): Promise<any> {
  const r = await fetch(`${env.telegramApi}/bot${env.telegramToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

async function slackPost(channel: string, text: string): Promise<void> {
  const r = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.slackBotToken}` }, body: JSON.stringify({ channel, text }), signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Slack: ${j.error ?? r.status}`);
}

async function whatsappSend(to: string, text: string): Promise<void> {
  const body = new URLSearchParams({ To: to, From: env.twilioWhatsappFrom, Body: text.slice(0, 1500) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Twilio: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
}

export async function sendTo(channel: Channel, externalId: string, text: string, buttons: Btn[] = []): Promise<void> {
  const t = clip(text, 3800);
  if (channel === "telegram") {
    await tg("sendMessage", { chat_id: externalId, text: t, disable_web_page_preview: true, ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] } } : {}) });
  } else if (channel === "slack") await slackPost(externalId, t);
  else await whatsappSend(externalId, t);
}

/** Message every chat the user has connected. Best effort: a dead chat never blocks the case. */
export async function pushToUser(userId: string, text: string, opts: { actionId?: string } = {}): Promise<void> {
  const links = await q<{ channel: Channel; external_id: string }>("SELECT channel, external_id FROM channel_links WHERE user_id = $1", [userId]);
  for (const l of links) {
    if (!channelAvailable(l.channel)) continue;
    const buttons: Btn[] = opts.actionId && l.channel === "telegram" ? [{ label: "Approve", data: `act:${opts.actionId}:approve` }, { label: "Skip", data: `act:${opts.actionId}:skip` }] : [];
    const tail = opts.actionId ? `\n\nReply APPROVE to go ahead or SKIP to pass. Edit first: ${approveLink(opts.actionId)}` : "";
    await safely(`push-${l.channel}`, () => sendTo(l.channel, l.external_id, text + tail, buttons), undefined);
  }
}

/* ------------------------------------ linking ------------------------------------ */

export async function createLinkCode(userId: string, channel: Channel): Promise<string> {
  const code = randomToken(4).toUpperCase().slice(0, 7);
  await q("DELETE FROM link_codes WHERE user_id = $1 AND channel = $2", [userId, channel]);
  await q("INSERT INTO link_codes (code, user_id, channel, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')", [code, userId, channel]);
  return code;
}

async function redeem(code: string, channel: Channel, externalId: string, label: string | null): Promise<UserRow | null> {
  const row = await q1<{ user_id: string }>("DELETE FROM link_codes WHERE code = $1 AND channel = $2 AND expires_at > now() RETURNING user_id", [code.toUpperCase(), channel]);
  if (!row) return null;
  await q("INSERT INTO channel_links (user_id, channel, external_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT (channel, external_id) DO UPDATE SET user_id = EXCLUDED.user_id, label = EXCLUDED.label", [row.user_id, channel, externalId, label]);
  return q1<UserRow>("SELECT * FROM users WHERE id = $1", [row.user_id]);
}

export const listLinks = (userId: string) => q<{ channel: Channel; label: string | null; created_at: string }>("SELECT channel, label, created_at FROM channel_links WHERE user_id = $1 ORDER BY id", [userId]);
export const unlink = (userId: string, channel: Channel) => q("DELETE FROM channel_links WHERE user_id = $1 AND channel = $2", [userId, channel]);

/* ------------------------------------ the router ------------------------------------ */

export interface Inbound { channel: Channel; externalId: string; text: string; label?: string | null }

const HELP = [
  "I'm Badger. I chase people for you, politely and persistently.",
  "",
  "Try:",
  "- \"Sam had a lesson today, $45\"",
  "- \"Mark Lee paid\"",
  "- \"who owes me?\"",
  "- \"status\" for your open cases",
  "- APPROVE / SKIP when I ask for your OK",
].join("\n");

interface Pending { id: string; kind: string; draft: any; case_id: string; title: string; counterparty_name: string }
const pendingFor = (userId: string) =>
  q<Pending>(`SELECT a.id, a.kind, a.draft, a.case_id, c.title, c.counterparty_name FROM actions a JOIN cases c ON c.id = a.case_id WHERE c.user_id = $1 AND a.status = 'pending' ORDER BY a.created_at DESC LIMIT 8`, [userId]);

const describePending = (p: Pending) =>
  p.kind === "confirm_resolution" ? `${p.counterparty_name} says it's sorted: confirm?`
  : p.kind === "need_info" ? `Badger needs an answer: ${clip(p.draft?.question ?? "", 120)}`
  : `${p.kind === "web_form" ? "Fill in the web form" : "Email"} ${p.counterparty_name}: "${clip(p.draft?.subject ?? p.title, 70)}"`;

async function decide(user: UserRow, decision: "approve" | "skip", which: number | null, answer?: string): Promise<string> {
  const pend = await pendingFor(user.id);
  if (!pend.length) return "Nothing is waiting on you right now.";
  if (pend.length > 1 && which == null) return "More than one thing is waiting:\n" + pend.map((p, i) => `${i + 1}. ${describePending(p)}`).join("\n") + `\n\nReply "${decision} 1", "${decision} 2"...`;
  const p = pend[which != null ? which - 1 : 0];
  if (!p) return "I couldn't find that one. Say \"status\" to see what's waiting.";
  const res = await submitDecision(p.id, p.kind === "need_info" ? { decision, answer } : { decision });
  if (!res.ok) return `Couldn't do that: ${res.error}`;
  return decision === "approve" ? (p.kind === "confirm_resolution" ? "Marked as resolved. Nicely done." : p.kind === "need_info" ? "Thanks, got it. Badger carries on." : "Approved. Badger is sending it now.") : "Skipped.";
}

async function statusText(user: UserRow): Promise<string> {
  const rows = await q<{ title: string; status: string; counterparty_name: string }>("SELECT title, status, counterparty_name FROM cases WHERE user_id = $1 AND status NOT IN ('resolved','stopped') ORDER BY created_at DESC LIMIT 10", [user.id]);
  const pend = await pendingFor(user.id);
  if (!rows.length) return "No open cases. Tell me who owes you something and I'll get on it.";
  return rows.map((r) => `- ${r.title} [${r.status.replace(/_/g, " ")}]`).join("\n") + (pend.length ? `\n\n${pend.length} waiting on you (say APPROVE or SKIP).` : "");
}

export async function balancesText(userId: string, onlyOwing = true): Promise<string> {
  const groups = await groupsOverview(userId);
  if (!groups.length) return "You have no groups yet. Say \"create a group called Piano students\" to start.";
  const lines: string[] = [];
  let grand = 0;
  for (const g of groups) {
    const owing = g.members.filter((m) => m.owed_cents > 0);
    grand += g.owed_cents;
    lines.push(`${g.name}: ${g.owed_cents ? money(g.owed_cents, g.currency) + " owed" : "all paid up"}`);
    for (const m of onlyOwing ? owing : g.members) lines.push(`  ${m.name}: ${money(m.owed_cents, g.currency)}${m.case_status ? ` (Badger is on it, ${m.reminders_sent ?? 0} sent)` : ""}`);
  }
  return lines.join("\n") + (grand ? `\n\nTotal outstanding: ${money(grand)}` : "");
}

async function history(userId: string, channel: Channel) {
  const rows = await q<{ role: "user" | "assistant"; content: string }>("SELECT role, content FROM channel_history WHERE user_id = $1 AND channel = $2 ORDER BY id DESC LIMIT 10", [userId, channel]);
  return rows.reverse();
}

async function agentTurn(user: UserRow, channel: Channel, text: string): Promise<string> {
  const rc = new RequestContext();
  rc.set("userId", user.id);
  const msgs = [
    { role: "system" as const, content: `You are replying inside ${channel === "whatsapp" ? "WhatsApp" : channel === "slack" ? "Slack" : "Telegram"}. Keep replies short and plain: no markdown, no headings, no tables. Use short lines. When you log or change anything, confirm in one line with the amount and the new balance.` },
    ...(await history(user.id, channel)),
    { role: "user" as const, content: text },
  ];
  const r = await getMastra().getAgent("intake").generate(msgs as any, { requestContext: rc, maxSteps: 6 } as any);
  const reply = (r.text ?? "").trim() || "Done.";
  await q("INSERT INTO channel_history (user_id, channel, role, content) VALUES ($1,$2,'user',$3), ($1,$2,'assistant',$4)", [user.id, channel, clip(text, 1500), clip(reply, 3000)]);
  return reply;
}

export async function onChannelMessage(m: Inbound): Promise<void> {
  const reply = (t: string, buttons: Btn[] = []) => sendTo(m.channel, m.externalId, t, buttons);
  const text = (m.text ?? "").trim();
  if (!text) return;

  const link = /^(?:\/start\s+|link\s+|connect\s+)([A-Za-z0-9]{5,10})\s*$/i.exec(text);
  if (link) {
    const user = await redeem(link[1], m.channel, m.externalId, m.label ?? null);
    return reply(user ? `Connected. Hi${user.name ? " " + user.name.split(" ")[0] : ""}! I'm Badger.\n\n${HELP}` : "That code didn't work. It may have expired (they last 10 minutes). Get a fresh one in the Badger app: Chat apps.");
  }

  const row = await q1<{ user_id: string }>("SELECT user_id FROM channel_links WHERE channel = $1 AND external_id = $2", [m.channel, m.externalId]);
  if (!row) return reply(`Hi, I'm Badger. I don't know this chat yet. Open ${env.publicUrl}, go to Chat apps, pick ${m.channel[0].toUpperCase() + m.channel.slice(1)}, and send me the code it shows you.`);
  const user = (await q1<UserRow>("SELECT * FROM users WHERE id = $1", [row.user_id]))!;

  const lower = text.toLowerCase().replace(/^\//, "");
  if (/^(help|\?|start)$/.test(lower)) return reply(HELP);
  if (/^(status|cases|what'?s up)\??$/.test(lower)) return reply(await statusText(user));
  if (/^(balances?|owed|who owes( me)?\??|who owes me what\??)$/.test(lower)) return reply(await balancesText(user.id));
  const cmd = /^(approve|yes|y|ok|okay|send|go|go ahead|skip|no|n|pass)(?:\s+(\d))?\s*[.!]*$/.exec(lower);
  if (cmd) {
    const pend = await pendingFor(user.id);
    if (pend.length) {
      const decision = /^(skip|no|n|pass)$/.test(cmd[1]) ? "skip" : "approve";
      return reply(await decide(user, decision, cmd[2] ? Number(cmd[2]) : null));
    }
  }
  // A lone question from Badger waiting on a free-text answer: treat the next message as the answer.
  const pend = await pendingFor(user.id);
  const need = pend.filter((p) => p.kind === "need_info");
  if (need.length === 1 && pend.length === 1 && !/^(log|add|create|mark|who|status)/.test(lower)) return reply(await decide(user, "approve", null, text));

  try {
    await reply(await agentTurn(user, m.channel, text));
  } catch (e) {
    console.error("[channel agent]", (e as Error).message);
    await reply("Sorry, I hit a snag. Try again in a moment.");
  }
}

/** Telegram button taps ("act:<actionId>:approve"). Only the owner of the action may decide it. */
export async function onTelegramCallback(chatId: string, callbackId: string, data: string): Promise<void> {
  const m = /^act:([0-9a-f-]{36}):(approve|skip)$/.exec(data);
  await safely("tg-answer", () => tg("answerCallbackQuery", { callback_query_id: callbackId }), undefined);
  if (!m) return;
  const link = await q1<{ user_id: string }>("SELECT user_id FROM channel_links WHERE channel = 'telegram' AND external_id = $1", [chatId]);
  const act = await q1<{ user_id: string }>("SELECT c.user_id FROM actions a JOIN cases c ON c.id = a.case_id WHERE a.id = $1", [m[1]]);
  if (!link || !act || link.user_id !== act.user_id) return sendTo("telegram", chatId, "That button isn't for this chat.");
  const res = await submitDecision(m[1], { decision: m[2] as "approve" | "skip" });
  await sendTo("telegram", chatId, res.ok ? (m[2] === "approve" ? "Approved. Badger is on it." : "Skipped.") : `Couldn't do that: ${res.error}`);
}

/* ------------------------------------ inbound verification ------------------------------------ */

export function verifySlack(raw: string, ts: string | undefined, sig: string | undefined): boolean {
  if (!env.slackSigningSecret || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const mine = "v0=" + createHmac("sha256", env.slackSigningSecret).update(`v0:${ts}:${raw}`).digest("hex");
  return safeEqual(mine, sig);
}

export function verifyTwilio(url: string, params: Record<string, string>, sig: string | undefined): boolean {
  if (!env.twilioToken || !sig) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return safeEqual(createHmac("sha1", env.twilioToken).update(data).digest("base64"), sig);
}

export const verifyTelegram = (header: string | undefined) => !!env.telegramToken && !!header && safeEqual(header, env.telegramSecret);

/** Boot-time setup: learn the bot's username and point Telegram at us. */
export async function setupChannels(): Promise<void> {
  if (env.telegramToken) {
    try {
      const me = await tg("getMe", {});
      telegramUsername = me.username ?? "";
      if (env.publicUrl.startsWith("https://")) {
        await tg("setWebhook", { url: `${env.publicUrl}/api/channels/telegram`, secret_token: env.telegramSecret, allowed_updates: ["message", "callback_query"] });
      }
      console.log(`[telegram] ready as @${telegramUsername}`);
    } catch (e) {
      console.error("[telegram setup]", (e as Error).message);
    }
  }
  if (channelAvailable("slack")) console.log("[slack] enabled");
  if (channelAvailable("whatsapp")) console.log("[whatsapp] enabled");
}

