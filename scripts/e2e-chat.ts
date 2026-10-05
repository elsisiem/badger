export {};
// Drives the Telegram path end to end against a LOCAL server wired to scripts/mock-telegram.ts.
//   TELEGRAM_BOT_TOKEN=fake TELEGRAM_API_BASE=http://127.0.0.1:9911 npx tsx --env-file=.env src/server.ts
//   npx tsx scripts/mock-telegram.ts
//   npx tsx scripts/e2e-chat.ts
const BASE = process.env.BASE || "http://localhost:8080";
const MOCK = "http://127.0.0.1:9911";
const CHAT = Math.floor(Math.random() * 1e9) + 1e9; // fresh chat per run so old state never leaks in
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
let cookie = "";
const log = (...a: unknown[]) => console.log(...a);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { log(ok ? "ok  " : "FAIL", name, ok ? "" : detail); if (!ok) failed++; };

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers as any) } });
  const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const outbox = async (): Promise<string[]> => ((await (await fetch(MOCK + "/__log")).json()) as any[]).filter((m) => m.method === "sendMessage").map((m) => m.body.text as string);
const say = async (text: string) => {
  await fetch(MOCK + "/__clear");
  const r = await fetch(BASE + "/api/channels/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ message: { text, chat: { id: CHAT, type: "private" }, from: { username: "teacher" } } }) });
  if (r.status !== 200) throw new Error("webhook " + r.status);
  for (let i = 0; i < 60; i++) { await new Promise((x) => setTimeout(x, 1000)); const o = await outbox(); if (o.length) return o.join("\n---\n"); }
  return "";
};

await api("/api/auth/demo", { method: "POST" });
const bad = await fetch(BASE + "/api/channels/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, body: "{}" });
check("webhook rejects a bad secret", bad.status === 403, String(bad.status));

const stranger = await say("hello");
check("unlinked chat is told how to connect", /don't know this chat|Chat apps/i.test(stranger), stranger);

const lc = await api("/api/channels/telegram/link-code", { method: "POST" });
check("link code issued", !!lc.json?.code, JSON.stringify(lc.json));
const linked = await say(`/start ${lc.json.code}`);
check("linking works", /Connected/i.test(linked), linked);
check("api shows the chat as linked", (await api("/api/channels")).json.channels.find((c: any) => c.channel === "telegram").linked.length === 1);

const g = await say("Create a group called Lessons. Usual price is $40, they pay by bank transfer. Yes, the parents expect payment reminders from me.");
log("   group ->", g.replace(/\n/g, " | ").slice(0, 160));
const a = await say("Add Mia Lee, her parent is Mrs. Lee, piano-parent-lee@agentmail.to");
log("   add ->", a.replace(/\n/g, " | ").slice(0, 180));
const l = await say("Mia had a lesson today");
log("   log ->", l.replace(/\n/g, " | ").slice(0, 180));
check("logging a lesson confirms the balance", /\$?40/.test(l), l);
const w = await say("who owes me?");
check("'who owes me' answers from the ledger", /Mia/.test(w) && /40/.test(w), w);
const p = await say("Mia paid");
log("   paid ->", p.replace(/\n/g, " | ").slice(0, 180));
check("marking paid clears the balance", /paid|all paid|nothing/i.test(p), p);
const w2 = await say("who owes me?");
check("ledger is clear afterwards", /no group|all paid|paid up|0\.00/i.test(w2) || !/Mia: \$40/.test(w2), w2);
const h = await say("help");
check("help works", /I'm Badger/.test(h), h);
log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);
