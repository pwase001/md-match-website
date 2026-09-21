-- Lets the app issue each month's invoice itself instead of running a Stripe
-- subscription that issues them.
--
-- The motive is the fee. Stripe prices a subscription invoice as Billing (0.7%
-- observed) and a standalone invoice as Invoicing (0.4% observed) -- the same
-- account, the same week, nearly double the rate for the same money moved. Issuing
-- the invoices directly also allows application_fee_amount, an exact figure, where
-- a subscription only takes application_fee_percent and can therefore only
-- approximate a flat fee.
--
-- billing_mode defaults to 'subscription' so every existing collaboration keeps
-- billing exactly as it does today; only rows created from here carry
-- 'app_invoice'. Nothing migrates.
ALTER TABLE collaborations ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'subscription';

-- The day of the month invoices should fall on, kept separately from
-- next_invoice_date so it survives a short month. A collaboration anchored to the
-- 31st bills on the 28th in February and returns to the 31st in March, rather than
-- ratcheting a day earlier every time it meets a shorter month.
ALTER TABLE collaborations ADD COLUMN billing_day INTEGER;

-- The next date an invoice is due to be issued. Null until activation.
ALTER TABLE collaborations ADD COLUMN next_invoice_date TEXT;

-- One row per collaboration per month, claimed before Stripe is called.
--
-- This is the only thing standing between a retried cron, a redeploy mid-run, or a
-- manual run racing the scheduled one, and a client being invoiced twice for the
-- same month. The primary key does the work: a second attempt to claim a month
-- that is already claimed changes no rows and the caller stops.
--
-- A row whose stripe_invoice_id is null and error is set is a month that failed
-- after being claimed. It is deliberately left claimed -- a missed invoice is
-- visible and can be issued by hand, while a duplicate has already asked someone
-- for money twice.
CREATE TABLE IF NOT EXISTS invoice_runs (
  collaboration_id  INTEGER NOT NULL,
  period            TEXT    NOT NULL,
  stripe_invoice_id TEXT,
  error             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collaboration_id, period)
);
