import { q, q1 } from "./db";
import { env } from "./env";
import { runNextStep, resolveCase } from "./engine";
import { checkRecipient, normalizeEmail } from "./safety";
import { scenarioForInbox } from "./sim";
import { addEvent, patchCase } from "./store";
import type { CaseRow, PlanStep, UserRow } from "./types";
import { clip, isoIn } from "./util";

/**
 * Groups ("rosters"): you log what each person owes (a lesson, a rent share, club dues), and Badger runs the reminders.
 * The ledger is the source of truth. Badger keeps ONE collection case per person in step with it:
 *   something overdue    -> open a case (gentle reminders on the group's schedule)
 *   more gets logged     -> the open case is updated, not duplicated
 *   you mark them paid   -> the case closes itself
 */

export interface GroupRow {
  id: string; user_id: string; name: string; kind: string; default_amount_cents: number | null; currency: string;
  grace_days: number; repeat_days: number; max_reminders: number; tone: "polite" | "firm" | "badger";
  auto_send: boolean; payment_note: string | null; consent_at: string | null; archived: boolean; created_at: string;
}
export interface MemberRow {
  id: string; group_id: string; user_id: string; name: string; payer_name: string | null; email: string | null; notes: string | null;
  default_amount_cents: number | null; active: boolean; reminders_paused: boolean; created_at: string;
}
export interface ChargeRow {
  id: string; member_id: string; group_id: string; user_id: string; description: string; amount_cents: number;
  incurred_on: string; status: "owed" | "paid" | "void"; paid_at: string | null; created_at: string;
}
type Res<T> = { ok: true } & T | { ok: false; error: string };

const MAX_GROUPS = 10;
const MAX_MEMBERS = 40;
const MAX_OPEN_GROUP_CASES = 40;
export const money = (cents: number, cur = "USD") => `${cur === "USD" ? "$" : cur + " "}${(cents / 100).toFixed(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/* ------------------------------------ groups ------------------------------------ */

export interface GroupInput {
  name: string; kind?: string; default_amount_cents?: number | null; currency?: string; grace_days?: number; repeat_days?: number;
  max_reminders?: number; tone?: string; payment_note?: string | null; consent?: boolean;
}
const clampInt = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

export async function createGroup(user: UserRow, i: GroupInput): Promise<Res<{ group: GroupRow }>> {
  const name = (i.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give the group a name, like 'Piano students'." };
  if (!i.consent) return { ok: false, error: "Please confirm that the people in this group expect payment reminders from you. Badger only contacts people you vouch for." };
  // Same name again (a retry, or the user asking twice) returns the existing group rather than making a twin.
  const twin = await q1<GroupRow>("SELECT * FROM groups WHERE user_id = $1 AND NOT archived AND lower(name) = lower($2)", [user.id, name]);
  if (twin) return { ok: true, group: twin };
  const n = await q1<{ n: string }>("SELECT count(*) AS n FROM groups WHERE user_id = $1 AND NOT archived", [user.id]);
  if (Number(n?.n ?? 0) >= MAX_GROUPS) return { ok: false, error: `You have ${MAX_GROUPS} groups already. Archive one first.` };
  const g = await q1<GroupRow>(
    `INSERT INTO groups (user_id, name, kind, default_amount_cents, currency, grace_days, repeat_days, max_reminders, tone, payment_note, consent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING *`,
    [
      user.id, name, (i.kind || "students").slice(0, 30), Number.isInteger(i.default_amount_cents) && i.default_amount_cents! > 0 ? i.default_amount_cents : null,
      (i.currency || "USD").toUpperCase().slice(0, 3), clampInt(i.grace_days, 0, 30, 3), clampInt(i.repeat_days, 1, 30, 7), clampInt(i.max_reminders, 1, 4, 3),
      i.tone === "firm" || i.tone === "badger" ? i.tone : "polite", i.payment_note?.trim().slice(0, 300) || null,
    ],
  );
  return { ok: true, group: g! };
}

export async function updateGroup(user: UserRow, id: string, p: Partial<GroupInput> & { auto_send?: boolean; archived?: boolean }): Promise<Res<{ group: GroupRow }>> {
  const g = await getGroup(user.id, id);
  if (!g) return { ok: false, error: "Group not found." };
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
  if (p.name !== undefined && p.name.trim()) add("name", p.name.trim().slice(0, 60));
  if (p.payment_note !== undefined) add("payment_note", p.payment_note?.trim().slice(0, 300) || null);
  if (p.grace_days !== undefined) add("grace_days", clampInt(p.grace_days, 0, 30, g.grace_days));
  if (p.repeat_days !== undefined) add("repeat_days", clampInt(p.repeat_days, 1, 30, g.repeat_days));
  if (p.max_reminders !== undefined) add("max_reminders", clampInt(p.max_reminders, 1, 4, g.max_reminders));
  if (p.tone === "polite" || p.tone === "firm" || p.tone === "badger") add("tone", p.tone);
  if (p.default_amount_cents !== undefined) add("default_amount_cents", Number.isInteger(p.default_amount_cents) && p.default_amount_cents! > 0 ? p.default_amount_cents : null);
  if (typeof p.auto_send === "boolean") add("auto_send", p.auto_send);
  if (typeof p.archived === "boolean") add("archived", p.archived);
  if (!sets.length) return { ok: true, group: g };
  const row = await q1<GroupRow>(`UPDATE groups SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING *`, [id, user.id, ...vals]);
  return { ok: true, group: row! };
}

export const getGroup = (userId: string, id: string) => (isUuid(id) ? q1<GroupRow>("SELECT * FROM groups WHERE id = $1 AND user_id = $2", [id, userId]) : Promise.resolve(null));

/* ------------------------------------ members ------------------------------------ */

export interface MemberInput { name: string; email?: string | null; payer_name?: string | null; notes?: string | null; default_amount_cents?: number | null }

/** "Sam Lee <sam@x.com>" or "Sam Lee, sam@x.com" or just "Sam Lee" per line. */
export function parseRoster(text: string): MemberInput[] {
  const out: MemberInput[] = [];
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/.exec(line);
    const email = m ? m[1] : null;
    const name = line.replace(email ?? "", "").replace(/[<>(),]+/g, " ").replace(/\s+/g, " ").trim();
    if (name) out.push({ name: name.slice(0, 60), email });
  }
  return out;
}

export async function addMembers(user: UserRow, groupId: string, list: MemberInput[]): Promise<Res<{ added: MemberRow[]; skipped: string[] }>> {
  const g = await getGroup(user.id, groupId);
  if (!g) return { ok: false, error: "Group not found." };
  const have = await q1<{ n: string }>("SELECT count(*) AS n FROM members WHERE group_id = $1 AND active", [groupId]);
  if (Number(have?.n ?? 0) + list.length > MAX_MEMBERS) return { ok: false, error: `A group holds up to ${MAX_MEMBERS} people.` };
  const added: MemberRow[] = [];
  const skipped: string[] = [];
  for (const m of list) {
    const name = m.name?.trim().slice(0, 60);
    if (!name) continue;
    const email = m.email ? normalizeEmail(m.email) : null;
    if (m.email && !email) { skipped.push(`${name}: that email address does not look valid`); continue; }
    if (email) {
      if (user.kind === "demo" && scenarioForInbox(email) !== "parent") { skipped.push(`${name}: demo accounts can only use the sandbox parents`); continue; }
      const ok = await checkRecipient(email, user, user.kind === "demo" ? "parent" : null);
      if (!ok.ok) { skipped.push(`${name}: ${ok.reason}`); continue; }
    }
    const row = await q1<MemberRow>(
      `INSERT INTO members (group_id, user_id, name, payer_name, email, notes, default_amount_cents) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [groupId, user.id, name, m.payer_name?.trim().slice(0, 60) || null, email, m.notes?.trim().slice(0, 300) || null, m.default_amount_cents ?? g.default_amount_cents],
    );
    added.push(row!);
  }
  return { ok: true, added, skipped };
}

export async function updateMember(user: UserRow, id: string, p: Partial<MemberInput> & { active?: boolean; reminders_paused?: boolean }): Promise<Res<{ member: MemberRow }>> {
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  const cur = await q1<MemberRow>("SELECT * FROM members WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!cur) return { ok: false, error: "Not found." };
  let email = cur.email;
  if (p.email !== undefined) {
    email = p.email ? normalizeEmail(p.email) : null;
    if (p.email && !email) return { ok: false, error: "That email address does not look valid." };
    if (email) {
      if (user.kind === "demo" && scenarioForInbox(email) !== "parent") return { ok: false, error: "Demo accounts can only use the sandbox parents." };
      const ok = await checkRecipient(email, user, user.kind === "demo" ? "parent" : null);
      if (!ok.ok) return { ok: false, error: ok.reason };
    }
  }
  const row = await q1<MemberRow>(
    `UPDATE members SET name = $3, payer_name = $4, email = $5, notes = $6, default_amount_cents = $7, active = $8, reminders_paused = $9 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, user.id, p.name?.trim().slice(0, 60) || cur.name, p.payer_name !== undefined ? p.payer_name?.trim().slice(0, 60) || null : cur.payer_name, email,
      p.notes !== undefined ? p.notes?.trim().slice(0, 300) || null : cur.notes, p.default_amount_cents !== undefined ? p.default_amount_cents : cur.default_amount_cents, p.active ?? cur.active, p.reminders_paused ?? cur.reminders_paused],
  );
  void syncMember(id).catch((e) => console.error("[sync]", e.message));
  return { ok: true, member: row! };
}

/** Find a person by id or by name across the owner's groups (used by chat tools). */
export async function resolveMember(userId: string, ref: string, groupRef?: string): Promise<Res<{ member: MemberRow }>> {
  if (isUuid(ref)) {
    const m = await q1<MemberRow>("SELECT * FROM members WHERE id = $1 AND user_id = $2 AND active", [ref, userId]);
    return m ? { ok: true, member: m } : { ok: false, error: "No such person." };
  }
  const rows = await q<MemberRow & { group_name: string }>(
    `SELECT m.*, g.name AS group_name FROM members m JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = $1 AND m.active AND NOT g.archived AND (m.name ILIKE $2 OR m.payer_name ILIKE $2)
       AND ($3::text IS NULL OR g.name ILIKE $3 OR g.id::text = $3)`,
    [userId, `%${ref.trim()}%`, groupRef?.trim() || null],
  );
  const exact = rows.filter((r) => r.name.toLowerCase() === ref.trim().toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return { ok: true, member: pick[0] };
  if (!pick.length) return { ok: false, error: `Nobody named "${ref}" in your groups.` };
  return { ok: false, error: `More than one match for "${ref}": ${pick.map((r) => `${r.name} (${r.group_name})`).join(", ")}. Which one?` };
}

/* ------------------------------------ ledger ------------------------------------ */

export async function logCharge(user: UserRow, memberId: string, c: { description?: string; amount_cents?: number; incurred_on?: string }): Promise<Res<{ charge: ChargeRow; owed_cents: number }>> {
  const m = await q1<MemberRow & { default_group: number | null }>("SELECT m.*, g.default_amount_cents AS default_group FROM members m JOIN groups g ON g.id = m.group_id WHERE m.id = $1 AND m.user_id = $2 AND m.active", [memberId, user.id]);
  if (!m) return { ok: false, error: "Person not found." };
  const amount = c.amount_cents ?? m.default_amount_cents ?? m.default_group ?? 0;
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_00) return { ok: false, error: "How much was it? Give an amount, or set a default price for the group." };
  const date = c.incurred_on && /^\d{4}-\d{2}-\d{2}$/.test(c.incurred_on) ? c.incurred_on : today();
  const description = (c.description?.trim() || "Lesson").slice(0, 120);
  // Idempotent against retries and double taps: an identical charge in the last two minutes is the same charge.
  const dupe = await q1<ChargeRow>(
    `SELECT * FROM charges WHERE member_id = $1 AND status = 'owed' AND amount_cents = $2 AND description = $3 AND incurred_on = $4 AND created_at > now() - interval '2 minutes' LIMIT 1`,
    [memberId, amount, description, date],
  );
  const row = dupe ?? (await q1<ChargeRow>(
    "INSERT INTO charges (member_id, group_id, user_id, description, amount_cents, incurred_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [memberId, m.group_id, user.id, description, amount, date],
  ));
  // The ledger is what the user asked for; opening or updating a case is a consequence and must never make the logging fail.
  await syncMember(memberId).catch((e) => console.error("[sync after charge]", e.message));
  return { ok: true, charge: row!, owed_cents: await owedCents(memberId) };
}

export async function owedCents(memberId: string): Promise<number> {
  const r = await q1<{ s: string | null }>("SELECT sum(amount_cents) AS s FROM charges WHERE member_id = $1 AND status = 'owed'", [memberId]);
  return Number(r?.s ?? 0);
}

/** Apply a payment oldest-first. With no amount, everything owed is marked paid. */
export async function markPaid(user: UserRow, memberId: string, amount_cents?: number): Promise<Res<{ applied_cents: number; remaining_cents: number }>> {
  const m = await q1<MemberRow>("SELECT * FROM members WHERE id = $1 AND user_id = $2", [memberId, user.id]);
  if (!m) return { ok: false, error: "Person not found." };
  const owed = await q<ChargeRow>("SELECT * FROM charges WHERE member_id = $1 AND status = 'owed' ORDER BY incurred_on, created_at", [memberId]);
  if (!owed.length) return { ok: true, applied_cents: 0, remaining_cents: 0 };
  let left = amount_cents && amount_cents > 0 ? amount_cents : owed.reduce((s, c) => s + c.amount_cents, 0);
  let applied = 0;
  for (const c of owed) {
    if (left <= 0) break;
    if (left >= c.amount_cents) {
      await q("UPDATE charges SET status = 'paid', paid_at = now() WHERE id = $1", [c.id]);
      left -= c.amount_cents;
      applied += c.amount_cents;
    } else {
      // Part payment: record what was paid, shrink what is still owed.
      await q("INSERT INTO charges (member_id, group_id, user_id, description, amount_cents, incurred_on, status, paid_at) VALUES ($1,$2,$3,$4,$5,$6,'paid',now())", [c.member_id, c.group_id, c.user_id, `Part payment: ${c.description}`.slice(0, 120), left, c.incurred_on]);
      await q("UPDATE charges SET amount_cents = amount_cents - $2 WHERE id = $1", [c.id, left]);
      applied += left;
      left = 0;
    }
  }
  await syncMember(memberId).catch((e) => console.error("[sync after paid]", e.message));
  return { ok: true, applied_cents: applied, remaining_cents: await owedCents(memberId) };
}

export async function voidCharge(user: UserRow, chargeId: string): Promise<Res<{}>> {
  const c = await q1<ChargeRow>("UPDATE charges SET status = 'void' WHERE id = $1 AND user_id = $2 AND status = 'owed' RETURNING *", [chargeId, user.id]);
  if (!c) return { ok: false, error: "That charge is not outstanding." };
  await syncMember(c.member_id).catch((e) => console.error("[sync after void]", e.message));
  return { ok: true };
}

/* ------------------------------------ overview ------------------------------------ */

export interface MemberView extends MemberRow {
  owed_cents: number; owed_count: number; oldest_owed: string | null;
  case_id: string | null; case_status: string | null; case_mood: string | null; reminders_sent: number | null;
}

export async function membersOf(groupId: string): Promise<MemberView[]> {
  const rows = await q<any>(
    `SELECT m.*,
       COALESCE(SUM(c.amount_cents) FILTER (WHERE c.status = 'owed'), 0)::int AS owed_cents,
       COUNT(c.id) FILTER (WHERE c.status = 'owed')::int AS owed_count,
       MIN(c.incurred_on) FILTER (WHERE c.status = 'owed') AS oldest_owed,
       k.id AS case_id, k.status AS case_status, k.mood AS case_mood, k.emails_sent AS reminders_sent
     FROM members m
     LEFT JOIN charges c ON c.member_id = m.id
     LEFT JOIN LATERAL (SELECT id, status, mood, emails_sent FROM cases WHERE member_id = m.id AND status NOT IN ('resolved','stopped','stalled') ORDER BY created_at DESC LIMIT 1) k ON true
     WHERE m.group_id = $1 AND m.active
     GROUP BY m.id, k.id, k.status, k.mood, k.emails_sent
     ORDER BY owed_cents DESC, m.name`,
    [groupId],
  );
  return rows.map((r: any) => ({ ...r, oldest_owed: r.oldest_owed ? String(r.oldest_owed).slice(0, 10) : null }));
}

export async function groupsOverview(userId: string) {
  const groups = await q<GroupRow>("SELECT * FROM groups WHERE user_id = $1 AND NOT archived ORDER BY created_at", [userId]);
  const out = [];
  for (const g of groups) {
    const members = await membersOf(g.id);
    out.push({ ...g, members, owed_cents: members.reduce((s, m) => s + m.owed_cents, 0) });
  }
  return out;
}

export async function recentCharges(groupId: string, limit = 30): Promise<(ChargeRow & { member_name: string })[]> {
  return q("SELECT c.*, m.name AS member_name FROM charges c JOIN members m ON m.id = c.member_id WHERE c.group_id = $1 AND c.status <> 'void' ORDER BY c.created_at DESC LIMIT $2", [groupId, limit]);
}

/* ------------------------------------ keeping cases in step with the ledger ------------------------------------ */

const OPEN = ["resolved", "stopped", "stalled"];

function describe(owed: ChargeRow[], cur: string): { ask: string; context: string; total: number } {
  const total = owed.reduce((s, c) => s + c.amount_cents, 0);
  const lines = owed.map((c) => `- ${c.incurred_on}: ${c.description}, ${money(c.amount_cents, cur)}`);
  return { total, ask: `Pay the ${money(total, cur)} outstanding (${owed.length} item${owed.length === 1 ? "" : "s"})`, context: lines.join("\n") };
}

function reminderPlan(g: GroupRow, createdAt: number, scale: number): PlanStep[] {
  const n = g.max_reminders;
  const steps: PlanStep[] = [];
  for (let i = 0; i < n; i++) {
    const day = i * g.repeat_days;
    const last = i === n - 1 && n > 1;
    steps.push({
      id: `s${i + 1}`, kind: "email", day, level: last && g.tone !== "polite" ? 2 : 1,
      label: i === 0 ? "Friendly reminder" : last ? "Final reminder" : "Gentle nudge",
      intent: i === 0 ? "A friendly first reminder: say what is owed, itemised, and exactly how to pay. Assume it simply slipped their mind."
        : last ? "A kind but direct last reminder before the teacher follows up personally. Restate the amount and how to pay."
        : "A light second nudge. Mention it is still outstanding, with no pressure and no guilt.",
      recipient: null, needs_approval: !g.auto_send, status: "pending", due_at: isoIn(createdAt, day, scale),
    });
  }
  const fd = (n - 1) * g.repeat_days + Math.max(2, Math.round(g.repeat_days / 2));
  steps.push({ id: `s${n + 1}`, kind: "final", day: fd, level: 1, label: "Report back to you", intent: "Summarize and hand it back to the owner.", recipient: null, needs_approval: false, status: "pending", due_at: isoIn(createdAt, fd, scale) });
  return steps;
}

/** Make the member's collection case match their ledger. Idempotent; safe to call after every change and from the sweep. */
export async function syncMember(memberId: string): Promise<void> {
  const m = await q1<MemberRow>("SELECT * FROM members WHERE id = $1", [memberId]);
  if (!m) return;
  const g = await q1<GroupRow>("SELECT * FROM groups WHERE id = $1", [m.group_id]);
  const user = await q1<UserRow>("SELECT * FROM users WHERE id = $1", [m.user_id]);
  if (!g || !user) return;
  const open = await q1<CaseRow>(`SELECT * FROM cases WHERE member_id = $1 AND status NOT IN ('resolved','stopped','stalled') ORDER BY created_at DESC LIMIT 1`, [memberId]);
  const owed = await q<ChargeRow>("SELECT * FROM charges WHERE member_id = $1 AND status = 'owed' ORDER BY incurred_on, created_at", [memberId]);

  if (!owed.length) {
    if (open) await resolveCase(open.id, `${m.name} is all paid up. The ledger is clear, so Badger stopped.`);
    return;
  }
  if (!m.active || m.reminders_paused || g.archived || !g.consent_at || !m.email) return;
  const d = describe(owed, g.currency);

  if (open) {
    if (open.amount_cents !== d.total) {
      await patchCase(open.id, { ask: d.ask, amount_cents: d.total, context: buildContext(g, m, user, d.context), title: caseTitle(m, d.total, g.currency) });
      await addEvent(open.id, "ledger_updated", "The ledger changed", `Now owed: ${money(d.total, g.currency)}. The next reminder will use the new total.`);
    }
    return;
  }

  // Not yet overdue?
  const due = owed.some((c) => addDays(c.incurred_on, g.grace_days) <= today());
  if (!due) return;
  // Do not nag again right after a case ended without payment; wait out two cycles.
  const recent = await q1(`SELECT 1 FROM cases WHERE member_id = $1 AND status IN ('stalled','stopped') AND updated_at > now() - ($2 || ' days')::interval LIMIT 1`, [memberId, String(g.repeat_days * 2)]);
  if (recent && user.kind !== "demo") return;
  const cap = await q1<{ n: string }>("SELECT count(*) AS n FROM cases WHERE user_id = $1 AND group_id IS NOT NULL AND status NOT IN ('resolved','stopped','stalled')", [user.id]);
  if (Number(cap?.n ?? 0) >= MAX_OPEN_GROUP_CASES) return;

  const scenario = user.kind === "demo" ? scenarioForInbox(m.email) : null;
  if (user.kind === "demo" && scenario !== "parent") return;
  const rc = await checkRecipient(m.email, user, scenario);
  if (!rc.ok) return;
  const scale = scenario ? env.demoClockScale : 1;
  const now = Date.now();
  const plan = reminderPlan(g, now, scale);
  const c = await q1<CaseRow>(
    `INSERT INTO cases (user_id, title, counterparty_name, counterparty_email, counterparty_type, ask, amount_cents, currency, context, tone, scenario, clock_scale, status, mood, plan, summary, next_due_at, group_id, member_id)
     VALUES ($1,$2,$3,$4,'person',$5,$6,$7,$8,$9,$10,$11,'waiting','napping',$12::jsonb,$13,$14,$15,$16) RETURNING *`,
    [user.id, caseTitle(m, d.total, g.currency), m.payer_name || m.name, m.email, d.ask, d.total, g.currency, buildContext(g, m, user, d.context), g.tone, scenario, scale,
      JSON.stringify(plan), `Collect ${money(d.total, g.currency)} from ${m.name} with ${g.max_reminders} well-spaced reminders (${g.auto_send ? "sent automatically" : "each one needs your OK"}).`, plan[0].due_at, g.id, m.id],
  );
  await addEvent(c!.id, "created", `Collecting from ${m.name}`, `${owed.length} item${owed.length === 1 ? "" : "s"} outstanding, ${money(d.total, g.currency)}. Opened automatically from the ${g.name} ledger.`);
  void runNextStep(c!.id).catch((e) => console.error("[group first step]", e.message));
}

const caseTitle = (m: MemberRow, total: number, cur: string) => clip(`${m.name}: ${money(total, cur)} owed`, 100);

function buildContext(g: GroupRow, m: MemberRow, user: UserRow, itemised: string): string {
  return [
    `This is a payment reminder from ${user.name || "the teacher"} (group: ${g.name}).`,
    m.payer_name ? `The email goes to ${m.payer_name}, who pays for ${m.name}.` : `The student is ${m.name}.`,
    `Outstanding items:\n${itemised}`,
    g.payment_note ? `How to pay: ${g.payment_note}` : "No payment instructions were given; ask them to pay in the usual way.",
    m.notes ? `Note about this person: ${m.notes}` : "",
    "Tone: warm and respectful. This is an ongoing relationship, so never guilt-trip.",
  ].filter(Boolean).join("\n");
}

/** Called after a case ends in 'resolved': the person paid, so the ledger agrees. */
export async function settleFromCase(c: Pick<CaseRow, "id" | "member_id" | "user_id" | "created_at">): Promise<void> {
  if (!c.member_id) return;
  const owner = await q1<UserRow>("SELECT * FROM users WHERE id = $1", [c.user_id]);
  if (!owner) return;
  await markPaid(owner, c.member_id);
}

/** Cron-ish: open cases for anyone who has become overdue since the last pass. */
export async function sweep(limit = 25): Promise<void> {
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT m.id FROM members m
       JOIN charges c ON c.member_id = m.id AND c.status = 'owed'
       JOIN groups g ON g.id = m.group_id AND NOT g.archived AND g.consent_at IS NOT NULL
      WHERE m.active AND NOT m.reminders_paused AND m.email IS NOT NULL
        AND c.incurred_on + g.grace_days <= current_date
        AND NOT EXISTS (SELECT 1 FROM cases k WHERE k.member_id = m.id AND k.status NOT IN ('resolved','stopped','stalled'))
      LIMIT $1`,
    [limit],
  );
  for (const r of rows) await syncMember(r.id).catch((e) => console.error("[sweep]", e.message));
}

