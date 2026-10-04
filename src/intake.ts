import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { env } from "./env";
import { createCase } from "./engine";
import { findContacts } from "./research";
import { SCENARIOS } from "./sim";
import { getUser } from "./store";

/**
 * The chat front door. Badger interviews the person (briefly), finds a company's contact address when it is missing,
 * then opens the case. Opening a case is safe by construction: nothing is sent until the human approves the first email.
 */

const userIdOf = (ctx: any): string | null => {
  const rc = ctx?.requestContext;
  return (rc?.get?.("userId") as string | undefined) ?? null;
};

const findContactTool = createTool({
  id: "find_contact",
  description: "Search the web for a company's support/contact email address. Returns candidate addresses, each with the page it was found on and a quote. Always confirm the address with the user before using it.",
  inputSchema: z.object({ company: z.string().describe("Company or organization name, e.g. 'Sunnyside Fitness'") }),
  outputSchema: z.object({ candidates: z.array(z.object({ email: z.string(), role: z.string(), url: z.string(), quote: z.string() })) }),
  execute: async ({ company }) => ({ candidates: await findContacts(company) }),
});

const openCaseTool = createTool({
  id: "open_case",
  description: "Open a follow-through case. Call once you know who to chase (with a verified email address), what you want from them, and the key facts. Badger will research and draft; nothing is sent until the user approves the first email.",
  inputSchema: z.object({
    title: z.string().describe("Short title, like 'Gym still charging me after I cancelled'"),
    counterparty_name: z.string(),
    counterparty_email: z.string(),
    counterparty_type: z.enum(["person", "organization"]),
    ask: z.string().describe("What the user wants, in one sentence"),
    amount: z.number().nullable().describe("Money involved in major units (e.g. 64.5), or null"),
    currency: z.string().nullable().describe("3-letter currency code, default USD"),
    context: z.string().describe("All relevant facts: dates, what was promised, reference numbers, what the user already tried"),
    tone: z.enum(["polite", "firm", "badger"]).nullable().describe("polite by default; firm if the user is fed up; badger for persistent and a bit cheeky"),
  }),
  outputSchema: z.object({ ok: z.boolean(), case_id: z.string().nullable(), title: z.string().nullable(), error: z.string().nullable() }),
  execute: async (input, ctx) => {
    const uid = userIdOf(ctx);
    const user = uid ? await getUser(uid) : null;
    if (!user) return { ok: false, case_id: null, title: null, error: "Not signed in." };
    const sandbox = Object.values(SCENARIOS).find((s) => s.inbox.toLowerCase() === input.counterparty_email.trim().toLowerCase());
    const res = await createCase(user, {
      title: input.title,
      counterparty_name: input.counterparty_name,
      counterparty_email: input.counterparty_email,
      counterparty_type: input.counterparty_type,
      ask: input.ask,
      amount_cents: input.amount != null ? Math.round(input.amount * 100) : null,
      currency: input.currency ?? "USD",
      context: input.context,
      tone: input.tone ?? "polite",
      scenario: user.kind === "demo" && sandbox ? sandbox.key : null,
    });
    return res.ok ? { ok: true, case_id: res.case.id, title: res.case.title, error: null } : { ok: false, case_id: null, title: null, error: res.error };
  },
});

export const intakeAgent = new Agent({
  id: "intake",
  name: "Badger",
  model: env.modelSmart,
  tools: { find_contact: findContactTool, open_case: openCaseTool },
  instructions: `You are Badger, a warm, slightly cheeky honey badger who nags people so the user doesn't have to. You help the user open a "case": someone owes them something (money, a reply, a refund, a cancellation, a deposit, a teammate's part) and chasing them is awkward.

Your job in chat: get just enough to open the case, then open it. Be brief and friendly. Ask at most two questions at a time and never repeat what the user already told you.

You need: (1) who to chase and a real email address for them, (2) what the user wants, (3) the key facts (dates, amounts, what was promised or tried), (4) optionally how pushy to be.
- If it is a company and you lack an email, call find_contact, then ask the user to confirm the best address before using it. Never invent an email address.
- If it is a person, ask for their email if missing.
- Infer the title, the ask, and the context from what the user says; don't interrogate.
- When you have enough, call open_case. Then say in two or three sentences what happens next: Badger researches the company's policy and the user's rights, plans a few well-spaced nudges, and drafts the first email for approval. Nothing is sent until they approve it.
- Tone: "polite" by default. Use "firm" if they say they're fed up, "badger" if they want relentless-but-cheeky.
- You are not a lawyer; never give legal advice or promise outcomes.
- Demo accounts can only chase the sandbox characters: alex-roommate@agentmail.to (Alex Rivera, a roommate who owes money) and sunnyside-gym@agentmail.to (Sunnyside Fitness, a gym that kept charging after cancellation). If a demo user tries something else, tell them to sign in with their email to open real cases.
Keep replies short. No markdown headings. Today is ${new Date().toISOString().slice(0, 10)}.`,
});
