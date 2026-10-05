import { q, q1 } from "./db";
import type { CaseRow, Mood, UserRow } from "./types";

export const getCase = (id: string) => q1<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
export const getUser = (id: string) => q1<UserRow>("SELECT * FROM users WHERE id = $1", [id]);

const JSON_COLS = new Set(["research", "plan"]);

/** Partial update. Values for jsonb columns are serialised for you; updated_at is always bumped. */
export async function patchCase(id: string, patch: Record<string, unknown>): Promise<CaseRow> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => (JSON_COLS.has(k) ? `${k} = $${i + 2}::jsonb` : `${k} = $${i + 2}`));
  const vals = keys.map((k) => (JSON_COLS.has(k) ? JSON.stringify(patch[k]) : patch[k]));
  const row = await q1<CaseRow>(`UPDATE cases SET ${sets.join(", ")}${sets.length ? ", " : ""}updated_at = now() WHERE id = $1 RETURNING *`, [id, ...vals]);
  if (!row) throw new Error(`case ${id} not found`);
  return row;
}

export const setMood = (id: string, mood: Mood) => patchCase(id, { mood });

export async function addEvent(caseId: string, type: string, title: string, body?: string | null, meta: Record<string, unknown> = {}) {
  await q("INSERT INTO events (case_id, type, title, body, meta) VALUES ($1, $2, $3, $4, $5::jsonb)", [caseId, type, title, body ?? null, JSON.stringify(meta)]);
}

export interface MessageRow {
  id: number;
  case_id: string;
  direction: "out" | "in";
  from_addr: string;
  to_addrs: string[];
  subject: string | null;
  body: string;
  am_message_id: string | null;
  am_thread_id: string | null;
  ts: string;
}

export const caseMessages = (caseId: string) => q<MessageRow>("SELECT * FROM messages WHERE case_id = $1 ORDER BY id", [caseId]);

export async function addMessage(m: { caseId: string; direction: "out" | "in"; from: string; to: string[]; subject?: string | null; body: string; amMessageId?: string | null; amThreadId?: string | null }) {
  return q1<MessageRow>(
    `INSERT INTO messages (case_id, direction, from_addr, to_addrs, subject, body, am_message_id, am_thread_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (am_message_id) WHERE am_message_id IS NOT NULL DO NOTHING RETURNING *`,
    [m.caseId, m.direction, m.from, JSON.stringify(m.to), m.subject ?? null, m.body, m.amMessageId ?? null, m.amThreadId ?? null],
  );
}

export interface ActionRow {
  id: string;
  case_id: string;
  step_id: string | null;
  kind: string;
  status: "pending" | "approved" | "skipped" | "done" | "expired";
  draft: any;
  run_id: string | null;
  created_at: string;
  decided_at: string | null;
  reminded_at: string | null;
}

export async function createAction(caseId: string, kind: string, draft: unknown, stepId: string | null = null, runId: string | null = null): Promise<ActionRow> {
  return (await q1<ActionRow>("INSERT INTO actions (case_id, step_id, kind, draft, run_id) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *", [caseId, stepId, kind, JSON.stringify(draft), runId]))!;
}
export const getAction = (id: string) => q1<ActionRow>("SELECT * FROM actions WHERE id = $1", [id]);
export const pendingActions = (caseId: string) => q<ActionRow>("SELECT * FROM actions WHERE case_id = $1 AND status = 'pending' ORDER BY created_at", [caseId]);

export async function decideAction(id: string, status: "approved" | "skipped" | "done" | "expired", draft?: unknown): Promise<ActionRow | null> {
  return q1<ActionRow>(
    `UPDATE actions SET status = $2, decided_at = now()${draft !== undefined ? ", draft = $3::jsonb" : ""} WHERE id = $1 AND status = 'pending' RETURNING *`,
    draft !== undefined ? [id, status, JSON.stringify(draft)] : [id, status],
  );
}

export const publicCase = (c: CaseRow) => ({
  id: c.id,
  title: c.title,
  counterparty_name: c.counterparty_name,
  counterparty_email: c.counterparty_email,
  counterparty_type: c.counterparty_type,
  ask: c.ask,
  amount_cents: c.amount_cents,
  currency: c.currency,
  context: c.context,
  tone: c.tone,
  status: c.status,
  mood: c.mood,
  scenario: c.scenario,
  clock_scale: c.clock_scale,
  research: c.research,
  plan: c.plan,
  summary: c.summary,
  next_due_at: c.next_due_at,
  emails_sent: c.emails_sent,
  autoplay: c.autoplay,
  group_id: c.group_id,
  member_id: c.member_id,
  created_at: c.created_at,
  updated_at: c.updated_at,
  resolved_at: c.resolved_at,
});
