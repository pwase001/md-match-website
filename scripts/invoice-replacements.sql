-- Invoices reissued to hide an NP's total from their physician.
--
-- An invoice finalised while MD-Match's cut was an application fee shows the
-- physician the NP's total and that fee. It cannot be edited into shape: Stripe
-- freezes monetary fields once an invoice is finalised, and application_fee_amount
-- on POST /v1/invoices/:id is a plain integer that cannot be blanked ("Invalid
-- integer: "). The only route is a new invoice carrying transfer_data[amount] and
-- the old one voided.
--
-- That is three writes to Stripe that have to happen together, and voiding cannot
-- be undone. This table claims the old invoice before any of them run, so a second
-- click cannot start a second replacement, and records how far the first one got.
-- Same reasoning as invoice_runs claiming a month before Stripe is called: the row
-- exists so that money which has already moved can be seen to have moved.
CREATE TABLE IF NOT EXISTS invoice_replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collaboration_id INTEGER NOT NULL,
  -- The invoice_runs period the old invoice was billed for, so the claim on that
  -- month can be repointed at the replacement. Null when the old invoice was not
  -- one of the sweep's (a one-off, say).
  period TEXT,
  -- The real guard. One replacement per invoice, ever.
  old_invoice_id TEXT NOT NULL UNIQUE,
  old_invoice_number TEXT,
  new_invoice_id TEXT,
  new_invoice_number TEXT,
  -- What the physician is to be paid and what the NP owes, as they stood when the
  -- replacement was claimed. Kept so a later reader can tell whether the figures
  -- the replacement was built on still match the collaboration's.
  share_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  -- How far it got: claimed, draft_created, finalized, old_voided, done. A row left
  -- short of done is the record of a half-finished replacement, and says which of
  -- the two invoices needs looking at by hand.
  stage TEXT NOT NULL DEFAULT 'claimed',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoice_replacements_collaboration
  ON invoice_replacements(collaboration_id);
