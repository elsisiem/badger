-- Badger schema. Mastra keeps its own workflow snapshot tables in the same database.

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE,                        -- null for demo users
  name        text,
  kind        text NOT NULL DEFAULT 'real' CHECK (kind IN ('real', 'demo')),
  autopilot   text NOT NULL DEFAULT 'ask' CHECK (autopilot IN ('ask', 'followups')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  text PRIMARY KEY,
  email       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE IF NOT EXISTS cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text NOT NULL,
  counterparty_name   text NOT NULL,
  counterparty_email  text NOT NULL,
  counterparty_type   text NOT NULL DEFAULT 'organization' CHECK (counterparty_type IN ('person', 'organization')),
  ask                 text NOT NULL,
  amount_cents        integer,
  currency            text NOT NULL DEFAULT 'USD',
  context             text NOT NULL DEFAULT '',
  tone                text NOT NULL DEFAULT 'polite' CHECK (tone IN ('polite', 'firm', 'badger')),
  status              text NOT NULL DEFAULT 'planning',
  mood                text NOT NULL DEFAULT 'sniffing',
  scenario            text,                       -- demo scenario key (sandbox counterparties only)
  clock_scale         integer NOT NULL DEFAULT 1, -- >1 = demo clock: one "day" lasts 24h / clock_scale
  research            jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan                jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary             text,
  next_due_at         timestamptz,
  emails_sent         integer NOT NULL DEFAULT 0,
  working_since       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);
CREATE INDEX IF NOT EXISTS cases_user ON cases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cases_due ON cases(next_due_at) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS events (
  id        bigserial PRIMARY KEY,
  case_id   uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  type      text NOT NULL,
  title     text NOT NULL,
  body      text,
  meta      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_case ON events(case_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id            bigserial PRIMARY KEY,
  case_id       uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('out', 'in')),
  from_addr     text NOT NULL,
  to_addrs      jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject       text,
  body          text NOT NULL,
  am_message_id text,
  am_thread_id  text,
  ts            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_case ON messages(case_id, id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(am_thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_am_unique ON messages(am_message_id) WHERE am_message_id IS NOT NULL;

-- Things waiting on a human: approve a draft, answer a question, confirm a win.
CREATE TABLE IF NOT EXISTS actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  step_id     text,
  kind        text NOT NULL,                      -- email | escalate_email | web_form | user_action | need_info | confirm_resolution
  status      text NOT NULL DEFAULT 'pending',    -- pending | approved | skipped | done | expired
  draft       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  reminded_at timestamptz
);
CREATE INDEX IF NOT EXISTS actions_case ON actions(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actions_pending ON actions(status) WHERE status = 'pending';

-- What Badger tells the user. Always shown in-app; emailed too for verified real users.
CREATE TABLE IF NOT EXISTS notifications (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id   uuid REFERENCES cases(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  subject   text NOT NULL,
  body      text NOT NULL,
  link      text,
  read_at   timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id DESC);

-- Anyone who replies STOP is never emailed again, by anyone's case.
CREATE TABLE IF NOT EXISTS suppressions (
  email   text PRIMARY KEY,
  reason  text NOT NULL,
  ts      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  k         text PRIMARY KEY,
  n         integer NOT NULL,
  reset_at  timestamptz NOT NULL
);
