-- Keeps the Stripe account a physician was moved off, when their payout account is
-- reset.
--
-- A reset is needed because business_type cannot be changed on an Express account
-- once an Account Link exists: a physician who started onboarding as an individual
-- and then wanted to be paid through their corporation needs a new account, not an
-- edited one.
--
-- The old id is kept rather than discarded because the abandoned account still
-- exists at Stripe and will keep appearing in the Connect accounts list. Without
-- this column there is nothing to say why there are two accounts for one person,
-- or which of them is the live one.
--
-- Only ever one deep. A second reset overwrites this with the account being left
-- behind at that point, which is the one anybody looking at the live account would
-- actually be asking about.

ALTER TABLE physicians ADD COLUMN previous_stripe_account_id TEXT;
