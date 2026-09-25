-- One row per invoice per kind of nudge, claimed before the email is sent.
--
-- The scheduled handler fires more than once a day -- the daily billing tick plus
-- two Monday ticks for compliance reminders -- and all of them would find the same
-- invoice due tomorrow. Without this, a Monday would produce three identical
-- drafts in the inbox and the reminder would start reading as noise.
--
-- Keyed on Stripe's invoice id rather than a collaboration, so it covers invoices
-- the app issued and invoices a Stripe subscription issued alike. The drafts are
-- built from what Stripe reports as open, which is the only view that sees both.
--
-- kind exists so a second nudge can be added later -- an overdue chase, say --
-- without the two competing for the same row.

CREATE TABLE IF NOT EXISTS payment_nudges (
  stripe_invoice_id TEXT NOT NULL,
  kind              TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (stripe_invoice_id, kind)
);
