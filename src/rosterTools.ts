import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { q } from "./db";
import { balancesText } from "./channels";
import { addMembers, createGroup, logCharge, markPaid, money, owedCents, resolveMember, updateMember, type GroupRow } from "./groups";
import { getUser } from "./store";

/** Tools that let the Badger agent keep a roster ledger from chat. Every tool acts only on the signed-in owner's data. */

const uidOf = (ctx: any): string | null => (ctx?.requestContext?.get?.("userId") as string | undefined) ?? null;
const owner = async (ctx: any) => {
  const id = uidOf(ctx);
  return id ? getUser(id) : null;
};
const cents = (n: number | null | undefined) => (typeof n === "number" && isFinite(n) && n > 0 ? Math.round(n * 100) : undefined);

async function findGroup(userId: string, ref: string | null | undefined): Promise<{ group: GroupRow } | { error: string }> {
  const rows = await q<GroupRow>("SELECT * FROM groups WHERE user_id = $1 AND NOT archived AND ($2::text IS NULL OR name ILIKE $3)", [userId, ref?.trim() || null, `%${ref?.trim() ?? ""}%`]);
  if (rows.length === 1) return { group: rows[0] };
  if (!rows.length) return { error: ref ? `No group matching "${ref}". Create it first.` : "You have no groups yet. Create one first." };
  return { error: `Which group? ${rows.map((r) => r.name).join(", ")}` };
}

const out = z.object({ result: z.string() });

export const rosterTools = {
  list_groups: createTool({
    id: "list_groups",
    description: "Show the user's groups (rosters) with everyone in them and what each person owes.",
    inputSchema: z.object({}),
    outputSchema: out,
    execute: async (_i, ctx) => {
      const u = await owner(ctx);
      return { result: u ? await balancesText(u.id, false) : "Not signed in." };
    },
  }),

  who_owes: createTool({
    id: "who_owes",
    description: "Answer 'who owes me?': everyone with an outstanding balance, and the total.",
    inputSchema: z.object({}),
    outputSchema: out,
    execute: async (_i, ctx) => {
      const u = await owner(ctx);
      return { result: u ? await balancesText(u.id, true) : "Not signed in." };
    },
  }),

  create_group: createTool({
    id: "create_group",
    description:
      "Create a group (roster) such as 'Piano students'. Ask the user first whether the people in it expect payment reminders from them; only set contacts_expect_reminders to true if they said yes. " +
      "Never turn on auto-send; tell the user they can switch that on in the roster settings if they want.",
    inputSchema: z.object({
      name: z.string(),
      default_amount: z.number().nullable().describe("Usual price per lesson/item in major units, or null"),
      payment_note: z.string().nullable().describe("How people pay, e.g. 'Venmo @sam or cash at the next lesson'"),
      grace_days: z.number().nullable().describe("Days to wait after a charge before the first reminder (default 3)"),
      repeat_days: z.number().nullable().describe("Days between reminders (default 7)"),
      contacts_expect_reminders: z.boolean(),
    }),
    outputSchema: out,
    execute: async (i, ctx) => {
      const u = await owner(ctx);
      if (!u) return { result: "Not signed in." };
      const r = await createGroup(u, { name: i.name, default_amount_cents: cents(i.default_amount) ?? null, payment_note: i.payment_note, grace_days: i.grace_days ?? undefined, repeat_days: i.repeat_days ?? undefined, consent: i.contacts_expect_reminders });
      return { result: r.ok ? `Created "${r.group.name}". Now add the people.` : r.error };
    },
  }),

  add_people: createTool({
    id: "add_people",
    description: "Add people to a group. For students under 18, use a parent's email and put their name in payer_name.",
    inputSchema: z.object({
      group: z.string().nullable().describe("Group name; null if the user has only one"),
      people: z.array(z.object({ name: z.string(), email: z.string().nullable(), payer_name: z.string().nullable() })),
    }),
    outputSchema: out,
    execute: async (i, ctx) => {
      const u = await owner(ctx);
      if (!u) return { result: "Not signed in." };
      const g = await findGroup(u.id, i.group);
      if ("error" in g) return { result: g.error };
      const r = await addMembers(u, g.group.id, i.people.map((p) => ({ name: p.name, email: p.email, payer_name: p.payer_name })));
      if (!r.ok) return { result: r.error };
      const noEmail = r.added.filter((m) => !m.email).map((m) => m.name);
      return { result: `Added ${r.added.length} to ${g.group.name}.${r.skipped.length ? " Skipped: " + r.skipped.join("; ") + "." : ""}${noEmail.length ? ` No email yet for ${noEmail.join(", ")}, so Badger can't remind them until you add one.` : ""}` };
    },
  }),

  log_charge: createTool({
    id: "log_charge",
    description: "Log something a person owes: a lesson, a session, dues. Use for 'Sam had a lesson today, $45'. Pass several names to log the same item for each. If no amount is given, the person's/group's default price is used.",
    inputSchema: z.object({
      people: z.array(z.string()).min(1),
      amount: z.number().nullable().describe("Amount in major units (45 or 45.50), or null for the default price"),
      description: z.string().nullable().describe("e.g. 'Piano lesson'"),
      date: z.string().nullable().describe("YYYY-MM-DD; null means today"),
      group: z.string().nullable(),
    }),
    outputSchema: out,
    execute: async (i, ctx) => {
      const u = await owner(ctx);
      if (!u) return { result: "Not signed in." };
      const lines: string[] = [];
      for (const ref of i.people) {
        const m = await resolveMember(u.id, ref, i.group ?? undefined);
        if (!m.ok) { lines.push(m.error); continue; }
        const r = await logCharge(u, m.member.id, { description: i.description ?? undefined, amount_cents: cents(i.amount), incurred_on: i.date ?? undefined });
        lines.push(r.ok ? `${m.member.name}: logged ${money(r.charge.amount_cents)}, now owes ${money(r.owed_cents)}` : `${m.member.name}: ${r.error}`);
      }
      return { result: lines.join("\n") };
    },
  }),

  mark_paid: createTool({
    id: "mark_paid",
    description: "Record that a person paid. With no amount, everything they owe is marked paid. With an amount, it is applied to the oldest items first.",
    inputSchema: z.object({ person: z.string(), amount: z.number().nullable() }),
    outputSchema: out,
    execute: async (i, ctx) => {
      const u = await owner(ctx);
      if (!u) return { result: "Not signed in." };
      const m = await resolveMember(u.id, i.person);
      if (!m.ok) return { result: m.error };
      const r = await markPaid(u, m.member.id, cents(i.amount));
      if (!r.ok) return { result: r.error };
      return { result: r.applied_cents === 0 ? `${m.member.name} owed nothing.` : `${m.member.name}: recorded ${money(r.applied_cents)} paid. ${r.remaining_cents ? `Still owes ${money(r.remaining_cents)}.` : "All paid up, and Badger stopped reminding them."}` };
    },
  }),

  pause_reminders: createTool({
    id: "pause_reminders",
    description: "Stop (or resume) Badger's reminders to one person without touching what they owe.",
    inputSchema: z.object({ person: z.string(), paused: z.boolean() }),
    outputSchema: out,
    execute: async (i, ctx) => {
      const u = await owner(ctx);
      if (!u) return { result: "Not signed in." };
      const m = await resolveMember(u.id, i.person);
      if (!m.ok) return { result: m.error };
      const r = await updateMember(u, m.member.id, { reminders_paused: i.paused });
      const owed = await owedCents(m.member.id);
      return { result: r.ok ? `Reminders ${i.paused ? "paused" : "resumed"} for ${m.member.name}${owed ? ` (owes ${money(owed)})` : ""}.` : r.error };
    },
  }),
};

