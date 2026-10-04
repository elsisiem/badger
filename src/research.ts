import { z } from "zod";
import { env } from "./env";
import { normalizeEmail } from "./safety";
import type { CaseRow, Research } from "./types";

/**
 * Research uses Exa's /search with `outputSchema`, as Exa's own guidance recommends for "extract these fields from the pages".
 * The system prompt forbids guessing, and we drop anything that comes back without a source URL and an exact quote,
 * so every rule or deadline Badger cites in an email can be traced to a page.
 */

const SYSTEM =
  "You extract facts for a consumer who is chasing something owed to them. Use ONLY what the retrieved pages state. " +
  "Every item needs the exact short quote from the page and that page's URL. Omit anything you cannot verify on a page; never guess, never paraphrase a quote. " +
  "Prefer official sources (government, regulators, the company's own policy pages) over blogs.";

const itemQuote = { quote: { type: "string" }, url: { type: "string" } };

const SCHEMAS = {
  contacts: {
    type: "object",
    properties: {
      contacts: {
        type: "array",
        items: {
          type: "object",
          properties: { role: { type: "string" }, email: { type: "string" }, ...itemQuote },
          required: ["role", "email", "quote", "url"],
        },
      },
    },
    required: ["contacts"],
  },
  policies: {
    type: "object",
    properties: {
      policies: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, ...itemQuote }, required: ["claim", "quote", "url"] } },
      clocks: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, days: { type: "number" }, ...itemQuote }, required: ["label", "quote", "url"] },
      },
    },
    required: ["policies", "clocks"],
  },
  regulators: {
    type: "object",
    properties: {
      regulators: { type: "array", items: { type: "object", properties: { name: { type: "string" }, url: { type: "string" }, when: { type: "string" } }, required: ["name", "url", "when"] } },
    },
    required: ["regulators"],
  },
} as const;

async function exa(query: string, schema: object): Promise<any> {
  if (!env.exaKey) return null;
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.exaKey },
    body: JSON.stringify({ query, type: "auto", systemPrompt: SYSTEM, outputSchema: schema, contents: { highlights: true } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  return j.output?.content ?? null;
}

const httpsUrl = (u: unknown) => {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" ? x.toString() : null;
  } catch {
    return null;
  }
};
const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Queries tailored to the kind of case. Kept in code (not LLM-written) so research cost and behaviour are predictable. */
export function buildQueries(c: Pick<CaseRow, "counterparty_name" | "counterparty_type" | "ask" | "title" | "context">): { contacts: string | null; policies: string; regulators: string | null } {
  const topic = `${c.title}. ${c.ask}`.slice(0, 160);
  if (c.counterparty_type === "person") return { contacts: null, policies: `friendly etiquette and legal basics for asking someone to repay a small debt: ${topic}`, regulators: null };
  return {
    contacts: `${c.counterparty_name} customer support escalation contact email manager complaints`,
    policies: `${c.counterparty_name} policy and consumer law deadlines and rights for: ${topic}`,
    regulators: `which government agency or ombudsman accepts consumer complaints about: ${topic}`,
  };
}

export async function researchCase(c: CaseRow, extraPolicies: Research["policies"] = []): Promise<Research> {
  const queries = buildQueries(c);
  const [contacts, policies, regulators] = await Promise.all([
    queries.contacts ? exa(queries.contacts, SCHEMAS.contacts).catch((e) => (console.error("[exa contacts]", e.message), null)) : null,
    exa(queries.policies, SCHEMAS.policies).catch((e) => (console.error("[exa policies]", e.message), null)),
    queries.regulators ? exa(queries.regulators, SCHEMAS.regulators).catch((e) => (console.error("[exa regulators]", e.message), null)) : null,
  ]);

  const out: Research = {
    contacts: [],
    policies: [...extraPolicies],
    clocks: [],
    regulators: [],
    searched_at: new Date().toISOString(),
    queries: Object.values(queries).filter(Boolean) as string[],
  };

  for (const x of contacts?.contacts ?? []) {
    const email = normalizeEmail(x?.email);
    const url = httpsUrl(x?.url);
    if (email && url && str(x.quote, 400).toLowerCase().includes(email.split("@")[0].slice(0, 6))) out.contacts.push({ role: str(x.role, 60) || "contact", email, url, quote: str(x.quote, 300) });
  }
  for (const x of policies?.policies ?? []) {
    const url = httpsUrl(x?.url);
    if (url && str(x.quote, 400) && str(x.claim, 300)) out.policies.push({ claim: str(x.claim, 300), quote: str(x.quote, 400), url });
  }
  for (const x of policies?.clocks ?? []) {
    const url = httpsUrl(x?.url);
    const days = typeof x?.days === "number" && x.days > 0 && x.days < 800 ? Math.round(x.days) : null;
    if (url && str(x.quote, 400) && str(x.label, 160)) out.clocks.push({ label: str(x.label, 160), days, quote: str(x.quote, 400), url });
  }
  for (const x of regulators?.regulators ?? []) {
    const url = httpsUrl(x?.url);
    if (url && str(x.name, 120)) out.regulators.push({ name: str(x.name, 120), url, when: str(x.when, 200) });
  }
  out.policies = out.policies.slice(0, 6);
  out.clocks = out.clocks.slice(0, 5);
  out.contacts = out.contacts.slice(0, 4);
  out.regulators = out.regulators.slice(0, 3);
  return out;
}

export const researchSchema = z.object({
  contacts: z.array(z.object({ role: z.string(), email: z.string().nullable(), url: z.string(), quote: z.string() })),
  policies: z.array(z.object({ claim: z.string(), quote: z.string(), url: z.string() })),
  clocks: z.array(z.object({ label: z.string(), days: z.number().nullable(), quote: z.string(), url: z.string() })),
  regulators: z.array(z.object({ name: z.string(), url: z.string(), when: z.string() })),
});

/** For the intake chat: find a company's contact email, grounded in a page that actually shows it. */
export async function findContacts(company: string): Promise<{ email: string; role: string; url: string; quote: string }[]> {
  const r = await exa(`${company} customer support contact email address`, SCHEMAS.contacts);
  const out: { email: string; role: string; url: string; quote: string }[] = [];
  for (const x of r?.contacts ?? []) {
    const email = normalizeEmail(x?.email);
    const url = httpsUrl(x?.url);
    if (email && url) out.push({ email, role: str(x.role, 60) || "contact", url, quote: str(x.quote, 300) });
  }
  return out.slice(0, 4);
}
