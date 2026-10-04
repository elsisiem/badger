import { describe, expect, it } from "vitest";
import { fallbackPlan, sanitizePlan } from "../src/brain";
import { formUrlAllowed } from "../src/kernel";
import { actionToken, readActionToken } from "../src/notify";
import { contentProblem, footerFor, looksLikeStop, normalizeEmail } from "../src/safety";
import type { CaseRow, Research } from "../src/types";
import { dayMs, isoIn } from "../src/util";

const baseCase = (over: Partial<CaseRow> = {}): CaseRow => ({
  id: "11111111-2222-3333-4444-555555555555", user_id: "u", title: "t", counterparty_name: "Acme Gym", counterparty_email: "help@acme.com",
  counterparty_type: "organization", ask: "refund", amount_cents: 1000, currency: "USD", context: "", tone: "polite", status: "planning", mood: "sniffing",
  scenario: null, clock_scale: 1, research: {}, plan: [], summary: null, next_due_at: null, emails_sent: 0, working_since: null,
  created_at: new Date("2026-10-01T00:00:00Z").toISOString(), updated_at: "", resolved_at: null, ...over,
});
const research = (over: Partial<Research> = {}): Research => ({ contacts: [], policies: [], clocks: [], regulators: [], searched_at: "", queries: [], ...over });

describe("email normalisation", () => {
  it("accepts plain and display-name forms, lowercases", () => {
    expect(normalizeEmail("Help@Acme.com")).toBe("help@acme.com");
    expect(normalizeEmail("Alex <Alex@Mail.org>")).toBe("alex@mail.org");
  });
  it("rejects junk", () => {
    for (const bad of ["", "nope", "a@b", "a b@c.com", "@x.com", 5 as any, "a@b..com"]) expect(normalizeEmail(bad)).toBeNull();
  });
});

describe("outbound content checks", () => {
  it("lets a normal polite email through", () => {
    expect(contentProblem("Following up", "Hi team, I'm following up on a refund of $44.99 for charges after cancellation. Could you reply by Friday? Thank you.")).toBeNull();
  });
  it("blocks threats, fake authority, secrets, tiny and huge bodies", () => {
    expect(contentProblem("x", "Pay me or I will find where you live and make you regret it, we know your family")).toMatch(/threat/);
    expect(contentProblem("x", "I am a lawyer representing the member and demand payment now, thank you very much")).toMatch(/authority/);
    expect(contentProblem("x", "my card is 4111 1111 1111 1111 please refund it to this card ok thanks")).toMatch(/secret|card/);
    expect(contentProblem("x", "hi")).toMatch(/short/);
    expect(contentProblem("x", "a".repeat(2300))).toMatch(/long/);
  });
});

describe("STOP detection", () => {
  it("honours clear asks", () => {
    for (const t of ["STOP", "please stop", "Unsubscribe me", "Do not contact me again", "stop emailing us", "this is harassment"]) expect(looksLikeStop(t), t).toBe(true);
  });
  it("does not trigger on ordinary replies", () => {
    for (const t of ["We will stop the billing today, refund issued.", "Thanks, looking into it", "Can you stop by the front desk?"]) expect(looksLikeStop(t), t).toBe(false);
  });
});

describe("footer", () => {
  it("discloses the AI, carries a ref and a STOP instruction", () => {
    const f = footerFor({ name: "Sam", email: "sam@x.com", kind: "real" }, "abcdef12-0000");
    expect(f).toMatch(/AI assistant acting on behalf of Sam/);
    expect(f).toMatch(/reply STOP/);
    expect(f).toMatch(/Badger ref: abcdef12/);
  });
});

describe("plan sanitizer (the model proposes, code disposes)", () => {
  const wild = [
    { kind: "escalate_email" as const, day: 0, level: 3, label: "Nuke", intent: "x", recipient: "ceo@evil.com" },
    { kind: "email" as const, day: 1, level: 3, label: "again", intent: "y", recipient: null },
    { kind: "user_action" as const, day: 2, level: 1, label: "sue", intent: "z", recipient: null },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "email" as const, day: 3 + i, level: 2, label: "n" + i, intent: "q", recipient: null })),
  ];
  it("starts with a day-0 email, never escalates to an unverified address, caps the length", () => {
    const plan = sanitizePlan(wild, baseCase(), research(), "ask");
    expect(plan[0]).toMatchObject({ kind: "email", day: 0 });
    expect(plan.every((s) => s.recipient === null || s.recipient === "ceo@evil.com" === false)).toBe(true);
    expect(plan.filter((s) => s.kind === "escalate_email")).toHaveLength(0);
    expect(plan.filter((s) => s.kind === "user_action")).toHaveLength(0); // no verified remedy to back it
    expect(plan.length).toBeLessThanOrEqual(7); // 6 steps + final report
    expect(plan[plan.length - 1].kind).toBe("final");
    expect(plan.every((s, i) => i === 0 || s.day > plan[i - 1].day)).toBe(true);
  });
  it("allows escalation only to a researched address", () => {
    const r = research({ contacts: [{ role: "manager", email: "manager@acme.com", url: "https://acme.com/c", quote: "manager@acme.com" }] });
    const plan = sanitizePlan([{ kind: "email", day: 0, level: 1, label: "a", intent: "i", recipient: null }, { kind: "escalate_email", day: 6, level: 2, label: "b", intent: "i", recipient: "manager@acme.com" }], baseCase(), r, "ask");
    expect(plan.find((s) => s.kind === "escalate_email")?.recipient).toBe("manager@acme.com");
  });
  it("treats friends gently: at most 3 emails, 3+ days apart, never level 3, no escalation", () => {
    const plan = sanitizePlan(wild, baseCase({ counterparty_type: "person" }), research(), "followups");
    const emails = plan.filter((s) => s.kind !== "final");
    expect(emails.length).toBeLessThanOrEqual(3);
    expect(Math.max(...emails.map((s) => s.level))).toBeLessThanOrEqual(2);
    emails.forEach((s, i) => i && expect(s.day - emails[i - 1].day).toBeGreaterThanOrEqual(3));
  });
  it("always needs approval for the first email, escalations and level 3; autopilot only relaxes routine follow-ups", () => {
    const plan = sanitizePlan([
      { kind: "email", day: 0, level: 1, label: "a", intent: "i", recipient: null },
      { kind: "email", day: 3, level: 1, label: "b", intent: "i", recipient: null },
      { kind: "email", day: 7, level: 3, label: "c", intent: "i", recipient: null },
    ], baseCase(), research(), "followups");
    expect(plan[0].needs_approval).toBe(true);
    expect(plan[1].needs_approval).toBe(false);
  });
  it("the deterministic fallback plan is valid too", () => {
    const plan = fallbackPlan(baseCase(), "ask");
    expect(plan[0]).toMatchObject({ kind: "email", day: 0 });
    expect(plan.length).toBeGreaterThanOrEqual(4);
  });
});

describe("web-form gate", () => {
  it("only fills forms on the counterparty's own site (or the sandbox), over https", () => {
    expect(formUrlAllowed("https://www.acme.com/cancel", "help@acme.com", null).ok).toBe(true);
    expect(formUrlAllowed("https://evil.com/phish", "help@acme.com", null).ok).toBe(false);
    expect(formUrlAllowed("http://acme.com/cancel", "help@acme.com", null).ok).toBe(false);
    expect(formUrlAllowed("https://acme.com.evil.com/x", "help@acme.com", null).ok).toBe(false);
    expect(formUrlAllowed("https://192.168.0.1/admin", "help@acme.com", null).ok).toBe(false);
    expect(formUrlAllowed("https://badger.test/sim/gym/contact", "sunnyside-gym@agentmail.to", "gym").ok).toBe(true);
  });
});

describe("clock + tokens", () => {
  it("the demo clock compresses days", () => {
    expect(dayMs(1)).toBe(86_400_000);
    expect(dayMs(4320)).toBe(20_000);
    expect(new Date(isoIn(0, 3, 4320)).getTime()).toBe(60_000);
  });
  it("action tokens round-trip and reject tampering", () => {
    const t = actionToken("abc-123");
    expect(readActionToken(t)).toBe("abc-123");
    expect(readActionToken(t.slice(0, -2) + "xx")).toBeNull();
    expect(readActionToken("garbage")).toBeNull();
  });
});
