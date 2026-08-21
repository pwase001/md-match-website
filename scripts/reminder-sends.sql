-- Records which pairings have been sent their compliance reminder in a given
-- month, so the scheduled run cannot repeat one that already went out.
CREATE TABLE IF NOT EXISTS reminder_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,               -- 'YYYY-MM', in New York time
  pairing_key TEXT NOT NULL,          -- lowercased physician_email|provider_email
  physician_email TEXT,
  provider_email TEXT,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL,              -- 'scheduled' or 'manual'
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period, pairing_key)
);
