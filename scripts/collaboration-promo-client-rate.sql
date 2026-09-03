-- What the client pays during an introductory period.
--
-- The first promotional columns stored only the physician's side, which is enough
-- to tell a physician what they will receive but not enough to tell a client what
-- they will be invoiced. The two are independent figures rather than one derived
-- from the other: the platform fee is halved during a promotion by convention, but
-- the convention is not universal -- some collaborations run a little above the
-- standard fee and some a little below -- so deriving one from the other would
-- quietly print a wrong number on somebody's invoice schedule.
--
-- Null on every existing row, alongside the other promotional columns, which reads
-- as a standard collaboration.

ALTER TABLE collaborations ADD COLUMN promo_total_cents INTEGER;
