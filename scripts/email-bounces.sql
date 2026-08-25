-- Bounces and spam complaints reported by Resend's webhook. Resend accepting a
-- message only means it was handed off; the recipient's server can still reject
-- it afterwards, and without this the app never learns that it did.
CREATE TABLE IF NOT EXISTS email_bounces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,        -- email.bounced | email.complained
  email_id TEXT,                   -- Resend's id for the message
  recipient TEXT NOT NULL,
  subject TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (email_id, event_type)    -- webhooks retry; one row per event
);
