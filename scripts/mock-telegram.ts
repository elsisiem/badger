// A tiny stand-in for api.telegram.org so the chat-app path can be tested end to end without a real bot.
// Usage: npx tsx scripts/mock-telegram.ts   (listens on :9911, records every message Badger "sends")
import { createServer } from "node:http";

const sent: { method: string; body: any }[] = [];
createServer((req, res) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    let body: any = {};
    try { body = JSON.parse(data || "{}"); } catch {}
    if (req.url === "/__log") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(sent)); }
    if (req.url === "/__clear") { sent.length = 0; return res.end("ok"); }
    sent.push({ method, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "badger_test_bot" } : { message_id: sent.length } }));
  });
}).listen(9911, () => console.log("mock telegram on :9911"));
