-- Asynchronous mental health intakes. One row per patient link: answers are
-- saved as the patient goes, so an intake can be resumed and so urgent safety
-- answers reach the clinical lead before the patient finishes.
CREATE TABLE IF NOT EXISTS mh_intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,          -- 'MH-XXXXXX', the patient ID staff refer to
  token_hash TEXT NOT NULL UNIQUE,         -- SHA-256 of the patient's resume token
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | submitted | reviewed
  answers TEXT NOT NULL DEFAULT '{}',      -- JSON: question id -> answer
  change_log TEXT NOT NULL DEFAULT '[]',   -- JSON: answers the patient went back and changed
  alerts_sent TEXT NOT NULL DEFAULT '[]',  -- JSON: urgent alert kinds already emailed
  evaluation TEXT,                         -- JSON: rules result, frozen at submission
  outcome TEXT,                            -- async | video_visit
  visit_request TEXT,                      -- JSON: availability a referred patient sent
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS mh_intakes_status ON mh_intakes (status, updated_at);
