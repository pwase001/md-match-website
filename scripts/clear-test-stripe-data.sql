-- Clears test-mode Stripe linkage from D1 ahead of the switch to live mode.
--
-- Context: the worker ran with an sk_test_ key, so every Stripe ID currently
-- stored in D1 refers to a test-mode object. Those IDs 404 under a live key, so
-- they have to be cleared before going live or the onboarding flows will fail
-- against records that no longer resolve.
--
-- This does NOT wipe the tables. `clients` and `physicians` are populated by the
-- public intake forms (worker.js:159, worker.js:270), so most rows are real leads
-- with no Stripe linkage at all. Only the specific test IDs are touched, matched
-- by exact value, which makes this idempotent and safe to re-run: after go-live
-- the new IDs will be different, so a stray re-run cannot clear live linkage.
--
-- Rows deliberately left alone:
--   clients     3,4,5  Ronald Jeganathan, Carmen Turner, Ebony Price  (no Stripe linkage)
--   physicians  3      Jendayi Olabisi                                (no Stripe linkage)
--   collaborations 2   Kristin MAKINAJYAN -> Igor Shkolnik            (real pairing, see below)
--
-- Run with:
--   npx wrangler d1 execute collabmd-db --remote --file=scripts/clear-test-stripe-data.sql
-- Take a backup first:
--   npx wrangler d1 export collabmd-db --remote --output=backup.sql

-- 1. Remove the self-test collaboration (Philip Wasef as both client and
--    physician, carrying test subscription sub_1U0ZkVHSjb7Ly53mvgw6ROvD).
--    Matched on the subscription ID as well as the row ID so this cannot delete
--    a real collaboration that happens to occupy id 1 later.
DELETE FROM collaborations
WHERE id = 1
  AND stripe_subscription_id = 'sub_1U0ZkVHSjb7Ly53mvgw6ROvD';

-- 2. Unlink test customers so the bank-link checkout creates fresh live ones.
--    cus_V0ZICfF6tpgXLA = Philip Wasef (self-test), cus_V0aslcBKuDXxJc = Kristin MAKINAJYAN (real lead).
UPDATE clients
SET stripe_customer_id = NULL
WHERE stripe_customer_id IN ('cus_V0ZICfF6tpgXLA', 'cus_V0aslcBKuDXxJc');

-- 3. Unlink test Connect accounts and reset onboarding so these physicians are
--    sent through Connect again in live mode. Test accounts do not carry over --
--    live onboarding also collects dob and ssn_last_4, which test mode left in
--    `eventually_due` and never enforced.
--    acct_1U0Y9THIhCUMvPgP = Philip Wasef (self-test, was transfers_active),
--    acct_1U0ZgFHfOBzpQF9h = Igor Shkolnik (real, onboarding was in progress).
UPDATE physicians
SET stripe_account_id = NULL,
    onboarding_status = 'not_started',
    transfers_active = 0
WHERE stripe_account_id IN ('acct_1U0Y9THIhCUMvPgP', 'acct_1U0ZgFHfOBzpQF9h');

-- Collaboration 2 (Kristin -> Igor) is intentionally untouched. It is already
-- `pending_setup` with no subscription, which is the correct starting state for
-- re-running the flow live once Igor has re-onboarded and Kristin has re-linked
-- her bank account.

-- Verify afterwards -- every stripe_* column below should come back NULL:
--   SELECT id, full_name, stripe_customer_id FROM clients;
--   SELECT id, full_name, stripe_account_id, onboarding_status, transfers_active FROM physicians;
--   SELECT id, status, stripe_subscription_id FROM collaborations;
