-- The client's share of Stripe's cut, shown on the invoice as its own line.
--
-- The client total already carried this amount; it was simply folded into the
-- collaboration fee and invisible. Naming it lets an invoice say what it is:
--
--   Collaboration services — Dr Pallotta    $700.00
--   Processing fee                            $3.94
--                                          ---------
--                                           $703.94
--
-- Stored rather than recomputed at invoice time. The fee estimate depends on rates
-- that can change, and an invoice months from now should show the split that was
-- agreed when the collaboration was priced, not one derived from today's rates.
--
-- Null on every existing row and on any collaboration where the platform absorbs
-- the whole fee -- both mean a single-line invoice, which is what those already
-- produce.
--
-- Does not affect application_fee_amount, which stays the platform's whole share:
-- the physician is paid the same figure either way, only the client's invoice reads
-- differently.

ALTER TABLE collaborations ADD COLUMN processing_fee_cents INTEGER;
ALTER TABLE collaborations ADD COLUMN promo_processing_fee_cents INTEGER;
