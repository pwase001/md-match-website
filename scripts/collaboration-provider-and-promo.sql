-- Adds the two things the new-collaboration notice needs and the app never stored.
--
-- provider_name: the NP or PA the physician is actually collaborating with. The
-- clients table holds the paying practice, not the provider, so an email built
-- from existing data could only say "your collaboration with LinqCare" -- unhelpful
-- to a physician who covers two providers at the same practice.
--
-- promo_payout_cents / promo_end_date: an introductory rate. Promotional
-- collaborations were billed by hand in Stripe and only entered here once the
-- promotion ended, so the app had no representation of them at all, and no way to
-- tell whether a physician's new rate is a step up, a step down, or unchanged.
-- Inferring it from the gap between start_date and created_at was considered and
-- rejected: the gap does not survive normal data entry, and guessing wrong means
-- emailing a physician the wrong figure for their own pay.
--
-- promo_end_date being set is what marks a collaboration as promotional;
-- promo_payout_cents is what the physician receives each month until that date.
-- Both are null on every existing row, which reads as "standard" -- correct, since
-- every collaboration in the app today is billing at its full rate.

ALTER TABLE collaborations ADD COLUMN provider_name TEXT;
ALTER TABLE collaborations ADD COLUMN promo_payout_cents INTEGER;
ALTER TABLE collaborations ADD COLUMN promo_end_date TEXT;
