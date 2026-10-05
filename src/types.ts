export type Tone = "polite" | "firm" | "badger";
export type CounterpartyType = "person" | "organization";

export type CaseStatus =
  | "planning" // researching + building the plan
  | "awaiting_approval" // a draft is waiting for the human
  | "working" // a step is running right now
  | "waiting" // nothing to do until the next step is due or a reply arrives
  | "awaiting_confirmation" // they say it is resolved; the human confirms
  | "resolved"
  | "stopped" // the human, or the other side, ended it
  | "stalled"; // plan exhausted without a resolution

export type Mood = "sniffing" | "napping" | "nagging" | "worried" | "grumpy" | "victory";

export type StepKind = "email" | "escalate_email" | "web_form" | "user_action" | "final";

export interface PlanStep {
  id: string;
  kind: StepKind;
  day: number; // offset from the case start, in case-days
  level: 1 | 2 | 3; // 1 polite, 2 firm, 3 formal final notice
  label: string; // short title shown on the timeline
  intent: string; // what this step is for (fed to the drafter)
  recipient: string | null; // email for escalate_email; null = the counterparty
  needs_approval: boolean;
  status: "pending" | "done" | "skipped";
  due_at: string;
  done_at?: string;
}

export interface Clock {
  label: string;
  days: number | null; // length of the window in days, when the source states one
  quote: string;
  url: string;
}

export interface Research {
  contacts: { role: string; email: string | null; url: string; quote: string }[];
  policies: { claim: string; quote: string; url: string }[];
  clocks: Clock[];
  regulators: { name: string; url: string; when: string }[];
  searched_at: string;
  queries: string[];
}

export interface CaseRow {
  id: string;
  user_id: string;
  title: string;
  counterparty_name: string;
  counterparty_email: string;
  counterparty_type: CounterpartyType;
  ask: string;
  amount_cents: number | null;
  currency: string;
  context: string;
  tone: Tone;
  status: CaseStatus;
  mood: Mood;
  scenario: string | null;
  clock_scale: number;
  research: Research | Record<string, never>;
  plan: PlanStep[];
  summary: string | null;
  next_due_at: string | null;
  emails_sent: number;
  working_since: string | null;
  autoplay: boolean;
  group_id: string | null;
  member_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  kind: "real" | "demo";
  autopilot: "ask" | "followups";
  created_at: string;
}

export interface Draft {
  subject: string;
  body: string;
  to: string;
  cc: string[];
  kind: StepKind;
  level: number;
  note?: string; // why Badger is doing this (shown with the draft)
  form_url?: string;
}
