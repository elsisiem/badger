-- Every inbound AgentMail message is processed exactly once, whether it arrives by webhook, by the reconcile poll, or both.
CREATE TABLE IF NOT EXISTS seen_messages (
  am_message_id text PRIMARY KEY,
  inbox_id      text NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now()
);
