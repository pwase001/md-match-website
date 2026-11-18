-- Two tables for payouts that did not happen when they should have.
--
-- catchup_payouts records a transfer sent by hand to settle a physician's share of
-- an invoice whose charge paid them nothing. That happens when an invoice is
-- created while the physician's payout account cannot yet receive transfers: the
-- charge carries no transfer_data, the client pays in full, and the whole amount
-- settles to the platform with nothing marking the debt.
--
-- The two UNIQUE constraints are the real protection. Every other check -- the
-- charge's state, an existing transfer with that source_transaction, the share
-- ceiling -- reads state that could in principle be read twice before either write
-- lands. These cannot: a second catch-up for the same invoice or the same charge
-- fails in the database, whatever the application believed.
--
-- stripe_account_id is stored alongside physician_id rather than looked up through
-- it, because a physician's account can be reset (previous_stripe_account_id) and
-- this row has to keep saying which account the money actually went to.

CREATE TABLE catchup_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collaboration_id INTEGER NOT NULL REFERENCES collaborations(id),
  physician_id INTEGER NOT NULL REFERENCES physicians(id),
  stripe_account_id TEXT NOT NULL,
  stripe_invoice_id TEXT NOT NULL,
  stripe_charge_id TEXT NOT NULL,
  stripe_transfer_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stripe_invoice_id),
  UNIQUE (stripe_charge_id)
);

-- billing_block_alerts stops the daily sweep mailing the same warning three times
-- on a Monday, when it fires at 12:00, 13:00 and 14:00.
--
-- Keyed by date and collaboration rather than by collaboration alone, deliberately:
-- a collaboration blocked for a fortnight should say so once a day rather than once
-- ever, because the thing being reported is money not moving today. The rows also
-- leave a record of how long a physician was blocked, which is the question anybody
-- asks afterwards.
CREATE TABLE billing_block_alerts (
  alert_date TEXT NOT NULL,
  collaboration_id INTEGER NOT NULL REFERENCES collaborations(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (alert_date, collaboration_id)
);
