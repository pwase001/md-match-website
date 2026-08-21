-- Pairings that receive the monthly compliance reminder without being billed
-- through the platform, so they do not exist in `collaborations`.
CREATE TABLE IF NOT EXISTS reminder_pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  physician_name TEXT NOT NULL,
  physician_email TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  provider_email TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
