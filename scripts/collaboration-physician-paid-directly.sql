-- Marks a collaboration the platform does not pay the physician for.
--
-- Ohio allows a nurse practitioner's practice to pay the collaborating physician
-- itself (ORC 4723.481(C)(2)(n)). When it does, MD-Match bills only its own
-- platform fee: there is no payout to forward, so the invoice must carry no
-- transfer and no application fee, and the whole amount stays with the platform.
--
-- A flag rather than an inference from the amounts. "Nobody is paid" and "the
-- payout happens to be zero" look identical in the numbers, and the second is what
-- a mistyped amount looks like -- so reading intent out of a figure would let a
-- data-entry slip quietly stop paying a physician, with nothing on screen saying
-- so. Keeping the two apart means the amount says how much and this says who pays.
--
-- Additive and defaulted to 0, so every existing collaboration keeps its current
-- behaviour: the transfer and the application fee are added exactly as before.

ALTER TABLE collaborations ADD COLUMN physician_paid_directly INTEGER NOT NULL DEFAULT 0;
