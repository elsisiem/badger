-- Groups ("rosters"): a teacher, coach or landlord logs what each person owes, and Badger runs the reminders.
CREATE TABLE IF NOT EXISTS groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  kind                 text NOT NULL DEFAULT 'students',
  default_amount_cents integer,
  currency             text NOT NULL DEFAULT 'USD',
  grace_days           integer NOT NULL DEFAULT 3,   -- wait this long after a charge before the first reminder
  repeat_days          integer NOT NULL DEFAULT 7,   -- gap between reminders
  max_reminders        integer NOT NULL DEFAULT 3,
  tone                 text NOT NULL DEFAULT 'polite' CHECK (tone IN ('polite', 'firm', 'badger')),
  auto_send            boolean NOT NULL DEFAULT false, -- standing approval for gentle reminders in this group
  payment_note         text,                          -- how to pay: "Venmo @sam-teaches, or cash at the next lesson"
  consent_at           timestamptz,                   -- the owner confirmed these contacts expect reminders
  archived             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS groups_user ON groups(user_id) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS members (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id             uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  payer_name           text,                          -- who actually pays and gets the email (a parent, say)
  email                text,
  notes                text,
  default_amount_cents integer,
  active               boolean NOT NULL DEFAULT true,
  reminders_paused     boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS members_group ON members(group_id) WHERE active;

CREATE TABLE IF NOT EXISTS charges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description  text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  incurred_on  date NOT NULL DEFAULT current_date,
  status       text NOT NULL DEFAULT 'owed' CHECK (status IN ('owed', 'paid', 'void')),
  paid_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS charges_member ON charges(member_id, status);

ALTER TABLE cases ADD COLUMN IF NOT EXISTS group_id  uuid REFERENCES groups(id)  ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cases_member ON cases(member_id) WHERE status NOT IN ('resolved', 'stopped', 'stalled');

-- Chat apps (Telegram, Slack, WhatsApp): text Badger, and Badger texts you.
CREATE TABLE IF NOT EXISTS channel_links (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('telegram', 'slack', 'whatsapp')),
  external_id  text NOT NULL,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS channel_links_user ON channel_links(user_id);

CREATE TABLE IF NOT EXISTS link_codes (
  code        text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_history (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel  text NOT NULL,
  role     text NOT NULL CHECK (role IN ('user', 'assistant')),
  content  text NOT NULL,
  ts       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_history_user ON channel_history(user_id, channel, id DESC);
