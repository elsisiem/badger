-- Sandbox-only "fast-forward": when set, Badger skips the waiting and approves its own drafts so a visitor can watch the whole story in about a minute.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS autoplay boolean NOT NULL DEFAULT false;
