export {};
// Plays a user against a running Badger: BASE=http://localhost:8080 npx tsx scripts/e2e.ts [roommate|gym]
// It uses the sandbox cast, so every email is real AgentMail traffic but only between Badger and its own inboxes.
const BASE = (process.env.BASE || "http://localhost:8080").replace(/\/$/, "");
const scenario = process.argv[2] || "roommate";
let cookie = "";

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers as any) } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const demo = await call("/api/auth/demo", { method: "POST" });
if (!demo.json?.user) throw new Error("demo sign-in failed: " + demo.text);
log("signed in as", demo.json.user.kind, demo.json.user.id.slice(0, 8));

const started = await call("/api/demo/start", { method: "POST", body: JSON.stringify({ scenario }) });
if (started.status !== 201) throw new Error("start failed: " + started.text);
const id = started.json.case.id as string;
log("case opened:", started.json.case.title);

const seen = new Set<number>();
const handled = new Set<string>();
const deadline = Date.now() + 8 * 60_000;
let lastStatus = "";
while (Date.now() < deadline) {
  const r = await call(`/api/cases/${id}`);
  if (r.status !== 200) throw new Error("poll failed: " + r.text);
  const { case: c, events, actions } = r.json;
  for (const e of events) if (!seen.has(e.id)) { seen.add(e.id); log(`  [${e.type}] ${e.title}${e.body ? " :: " + String(e.body).replace(/\s+/g, " ").slice(0, 140) : ""}`); }
  if (c.status !== lastStatus) { lastStatus = c.status; log(`status -> ${c.status} (${c.mood})`); }
  for (const a of actions) {
    if (handled.has(a.id)) continue;
    handled.add(a.id);
    if (a.kind === "need_info") {
      log("  approving need_info with an answer");
      await call(`/api/actions/${a.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve", answer: "Yes, that is right." }) });
      continue;
    }
    log(`  >> ${a.kind} awaiting approval${a.draft?.body ? ":\n" + String(a.draft.body).split("\n").map((l: string) => "       | " + l).join("\n") : ""}`);
    const d = await call(`/api/actions/${a.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    log("  approve ->", d.status, d.json?.error ?? "ok");
  }
  if (c.status === "resolved") { log("RESOLVED"); break; }
  if (["stopped", "stalled"].includes(c.status)) { log("ended:", c.status); break; }
  await new Promise((r) => setTimeout(r, 2500));
}
const final = await call(`/api/cases/${id}`);
log("final status:", final.json.case.status, "| emails sent:", final.json.case.emails_sent, "| messages:", final.json.messages.length);
process.exit(final.json.case.status === "resolved" ? 0 : 1);
