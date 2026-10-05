import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlack, verifyTelegram, verifyTwilio } from "../src/channels";
import { money, parseRoster } from "../src/groups";

describe("webhook signature checks (a forged request must never reach the agent)", () => {
  it("Slack: accepts a correct v0 signature, rejects tampering, wrong secret and stale timestamps", () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "v0=" + createHmac("sha256", process.env.SLACK_SIGNING_SECRET!).update(`v0:${ts}:${body}`).digest("hex");
    expect(verifySlack(body, ts, sig)).toBe(true);
    expect(verifySlack(body + " ", ts, sig)).toBe(false);
    expect(verifySlack(body, ts, "v0=" + "0".repeat(64))).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = "v0=" + createHmac("sha256", process.env.SLACK_SIGNING_SECRET!).update(`v0:${old}:${body}`).digest("hex");
    expect(verifySlack(body, old, oldSig)).toBe(false);
    expect(verifySlack(body, undefined, undefined)).toBe(false);
  });

  it("Twilio: HMAC-SHA1 over the URL plus sorted params", () => {
    const url = "https://badger.test/api/channels/whatsapp";
    const params = { From: "whatsapp:+15551234567", Body: "who owes me?", ProfileName: "Sam" };
    const data = url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("");
    const sig = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!).update(data).digest("base64");
    expect(verifyTwilio(url, params, sig)).toBe(true);
    expect(verifyTwilio(url, { ...params, Body: "something else" }, sig)).toBe(false);
    expect(verifyTwilio(url, params, undefined)).toBe(false);
  });

  it("Telegram: only the secret header is accepted", () => {
    expect(verifyTelegram(process.env.TELEGRAM_WEBHOOK_SECRET)).toBe(true);
    expect(verifyTelegram("nope")).toBe(false);
    expect(verifyTelegram(undefined)).toBe(false);
  });
});

describe("roster text parsing", () => {
  it("reads 'name, email' lines in several shapes", () => {
    const r = parseRoster("Mia Lee, mrs.lee@example.com\nLeo Ortiz <ortiz@example.com>\n  \nPriya Shah\nAva (ava@example.org)");
    expect(r.map((x) => x.name)).toEqual(["Mia Lee", "Leo Ortiz", "Priya Shah", "Ava"]);
    expect(r.map((x) => x.email)).toEqual(["mrs.lee@example.com", "ortiz@example.com", null, "ava@example.org"]);
  });
  it("formats money", () => {
    expect(money(4500)).toBe("$45.00");
    expect(money(12050, "EUR")).toBe("EUR 120.50");
  });
});
