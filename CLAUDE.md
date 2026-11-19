# MD-Match

A Cloudflare Worker (`src/worker.js`) serving md-match.com, backed by a D1 database
(`collabmd-db`) and Stripe Connect (CollabMD LLC, `acct_1U0VuAHSjb7Ly53m`). The admin
tool is `admin-collaborations.html`. Pushing to `main` deploys via
`.github/workflows/deploy.yml`.

MD-Match pairs nurse practitioners and PAs ("clients" in the database, "NPs" in
conversation) with collaborating physicians. The NP's practice pays MD-Match a
monthly amount; MD-Match forwards the physician their agreed share and keeps the
rest as its fee.

## Billing

**Physicians must only ever see their own share. Never use
`application_fee_amount` or `application_fee_percent` for physician payouts; always
pay physicians with `transfer_data[amount]` (or a plain transfer for catch-up
payouts). Physician-facing emails and Stripe descriptions must never include the
NP's invoice total or MD-Match's fee. For any billing or payout change, show Philip
the plan and wait for his OK before deploying.**

Why: with an application fee, Stripe shows the connected account both the charge
total and the fee, so Dr Albin's Express Dashboard read "$900 with a $200 fee" —
her NP's price and MD-Match's margin, neither of which is hers. With
`transfer_data[amount]` Stripe shows her only the amount transferred. The two move
identical money; they differ only in what the physician can see.

`npm test` enforces the mechanical half of this rule and runs before every deploy.
A failing test blocks the deploy. See `test/payout-privacy.test.mjs`.

### How money is computed

`grossUpTotalCents(physicianPayoutCents, netFeeCents, clientFeeShare, billingMode)`
derives the NP's total from the two negotiated figures — what the physician is paid
and what the arrangement is worth to MD-Match — adding `clientFeeShare` of Stripe's
cut on top. Every app-invoice collaboration in the book uses `clientFeeShare = 0.5`,
so the NP carries half of Stripe's cut as a visible "Processing fee" line.

`collaborationRateOn(collaboration, invoiceDate)` returns the rate in force on a
date: the promotional pair while `invoiceDate < promo_end_date`, the standard pair
after. The physician's share is always `totalCents - feeCents`, which in a
promotional month is exactly `promo_payout_cents`. Derive it; never pass it
separately, or it can drift from the invoice it belongs to.

### Invoicing

One place creates invoices: `createCollaborationInvoice` in `src/stripe-helpers.js`,
called by the monthly sweep (`runCollaborationBilling`) and by Bill One-Off. Both
get `transfer_data[amount]` for free. Anything new that invoices an NP must go
through it rather than calling `stripe.invoices.create` directly — a hand-built
invoice is how Dr Albin went unpaid for October.

Collaborations marked `physician_paid_directly` carry no transfer at all: Ohio lets
an NP's practice pay the collaborating physician itself (ORC 4723.481(C)(2)(n)), so
MD-Match bills only its own fee and the whole amount settles to the platform.

A finalised invoice cannot be corrected, only replaced. Stripe freezes monetary
fields once an invoice is finalised, and `application_fee_amount` on
`POST /v1/invoices/:id` is a plain integer that cannot be blanked — sending it empty
answers `Invalid integer: `. Leaving it in place while adding a transfer answers
"Only one of `application_fee` and `transfer_data[amount]` can be specified", which
is a complaint about the combination and says nothing about whether the edit is
allowed; reading that as permission is how a Hide Totals button shipped that could
not work. The fix for an invoice with the wrong split is `handleHideTotals`: a new
invoice built the normal way, checked, finalised, and only then the old one voided.
Finalise before voiding, never the reverse — voiding cannot be undone, and the
physician's share is only readable once a PaymentIntent exists, which is to say only
after finalising.

Replacements are finalised with `auto_advance: false`, which makes the invoice
payable without Stripe mailing it. Everywhere else `auto_advance` is true and
finalising is what sends the invoice; a replacement is announced by hand instead,
because an unexplained second invoice for a month already invoiced reads as a double
charge.

Billing never invoices an NP for money it could not forward: the sweep reads the
physician's Connect account live and requires `capabilities.transfers === 'active'`
before creating anything, skipping before the month is claimed so the collaboration
bills itself once onboarding finishes. Blocked collaborations are reported to the
owner once a day.

Subscription mode (`billing_mode = 'subscription'`) is legacy and closed to new
work. Only collaboration 6 still runs on a live Stripe subscription. It predates
this rule and still carries `application_fee_percent` on that subscription; moving
it to app invoices is the fix, not editing the subscription.

### Money that has already moved

`invoice_runs` claims a month before Stripe is called, which is the whole defence
against billing an NP twice. A claimed period can never bill again. One-off
invoices claim `oneoff-YYYY-MM-DD` so they can never consume a monthly period.

`invoice_replacements` claims an invoice before the three Stripe writes that replace
it, one of which — the void — cannot be undone. Its UNIQUE on `old_invoice_id` is
what stops a second click starting a second replacement; the invoice's own status
would not, because two clicks a moment apart both read it as open. A row that stops
short of `stage = 'done'` is the record of a half-finished replacement and says which
of the two invoices needs a person. Replacing an invoice repoints the `invoice_runs`
claim at the new invoice and leaves the month claimed, so the sweep cannot bill it
again.

`catchup_payouts` records a transfer sent by hand to settle a physician's share of
an invoice whose charge paid them nothing. Its UNIQUE constraints on the invoice and
the charge are the real guard against paying twice; every other check reads state
that could be read twice.

## Working here

- Show Philip the plan for any billing or payout change, and wait. Run migrations
  before merging, since deployed code expects its columns to exist.
- Migrations are plain SQL in `scripts/`, applied to the remote D1 database by hand.
  Make them additive and defaulted so existing rows keep their behaviour.
- Comments explain why a thing is the way it is, especially where the obvious
  approach was tried and failed. Keep that.
- Never email an NP or a physician as a side effect of a fix. Email is a deliberate
  act with its own approval.
