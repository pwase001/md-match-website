-- Excludes a collaboration from the monthly compliance reminder without
-- cancelling it. Cancelling ends the Stripe subscription, which is a billing
-- decision; muting is only about who gets emailed.
ALTER TABLE collaborations ADD COLUMN reminders_muted INTEGER NOT NULL DEFAULT 0;
