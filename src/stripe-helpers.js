import Stripe from 'stripe';

export function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY);
}

// Returns 'live', 'test', or 'unknown' for the configured secret key. Restricted
// keys (rk_) carry the same mode marker as standard secret keys.
export function stripeKeyMode(env) {
  const key = env.STRIPE_SECRET_KEY || '';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

// business_type is deliberately not set. Stripe's onboarding skips any field the
// platform has already filled in, so pre-setting it to "individual" silently
// decided for every physician that they were being paid personally -- and it
// cannot be changed afterwards once an Account Link exists, which left a
// physician who wanted to be paid through their practice needing a whole new
// account. Leaving it unset makes Stripe ask them, once, at the only point where
// the answer is still free to give.
export async function createPhysicianAccount(stripe, physician) {
  return stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: physician.email,
    capabilities: {
      transfers: { requested: true },
    },
    business_profile: {
      product_description: 'Collaborating physician services for NP/PA collaborative practice agreements',
    },
  });
}

// The email a physician typed at signup is only Stripe's contact and login
// address -- it has no bearing on where payouts land or on tax reporting -- but
// it is where Stripe's own mail goes, so a physician who used the wrong one
// stops hearing from Stripe entirely.
//
// On an Express account this raises StripePermissionError: the field belongs to
// the account holder, and a platform may not edit it. Kept anyway because the
// restriction is per account type rather than per platform, and the caller treats
// that particular refusal as an expected answer rather than a failure.
export async function updatePhysicianAccountEmail(stripe, accountId, email) {
  return stripe.accounts.update(accountId, { email });
}

export async function createPhysicianOnboardingLink(stripe, accountId, refreshUrl, returnUrl) {
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

// Reuses an existing Stripe customer with the same email before creating one. A
// client invoiced by hand before being added here — the usual case when a
// collaboration starts at a promotional rate — already has a customer record,
// and splitting their invoice history across two of them is worse than the
// duplicate itself.
//
// Uses list() rather than search(): the Search API is eventually consistent and
// would miss a customer created moments earlier, which is exactly the window
// this runs in.
export async function createOrGetCustomer(stripe, client) {
  const existing = await stripe.customers.list({ email: client.email, limit: 10 });
  if (existing.data.length > 0) {
    // Stripe lists newest first. Any duplicates predate this call, so prefer the
    // most recent — it is the likeliest to carry current payment details.
    if (existing.data.length > 1) {
      console.warn(
        `Multiple Stripe customers share ${client.email} (${existing.data.length} found); reusing ${existing.data[0].id}`
      );
    }
    return existing.data[0].id;
  }

  const customer = await stripe.customers.create({
    name: client.full_name,
    email: client.email,
  });
  return customer.id;
}

export async function createBankLinkCheckoutSession(stripe, customerId, successUrl, cancelUrl, metadata) {
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: {
        verification_method: 'automatic',
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
  });
  return session.url;
}

export async function attachDefaultPaymentMethodFromSetup(stripe, checkoutSessionId) {
  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
    expand: ['setup_intent'],
  });
  const paymentMethodId = session.setup_intent.payment_method;
  const customerId = session.customer;
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  return { customerId, paymentMethodId };
}

// Fallback payment terms, used when a collaboration predates the per-collaboration
// setting. Matches the net-14 terms originally applied to every collaboration.
export const DEFAULT_PAYMENT_TERMS_DAYS = 14;

// What Stripe takes out of a paid invoice. All of it lands on the platform's side,
// because the physician's share is a fixed dollar figure rather than a percentage --
// so every cent Stripe charges comes out of the platform fee and none out of theirs.
// That is what turned an intended $200 into $188.58 on the first invoice to settle.
//
// Rates are taken from live invoices rather than a pricing page: a $700 invoice cost
// $7.90 and a $900 invoice cost $11.40, itemised in the payout ledger.
//
// The billing rate is the uncertain one, and deliberately the pessimistic reading. A
// one-off invoice was charged 0.4% ("Invoicing Starter") while a subscription invoice
// was charged 0.7% ("Billing - Usage Fee") in the same week on the same account.
// Every invoice the app generates today comes from a subscription, so 0.7% applies;
// if collaborations ever move to standalone invoices this drops to 0.4%.
export const STRIPE_ACH_PERCENT = 0.008;
export const STRIPE_ACH_CAP_CENTS = 500;
export const STRIPE_BILLING_PERCENT = 0.007;   // subscription invoice
export const STRIPE_INVOICING_PERCENT = 0.004; // standalone invoice
export const STRIPE_RADAR_CENTS = 5;

export function estimateStripeFeeCents(totalAmountCents, billingMode = 'subscription') {
  const ach = Math.min(Math.round(totalAmountCents * STRIPE_ACH_PERCENT), STRIPE_ACH_CAP_CENTS);
  const rate = billingMode === 'app_invoice' ? STRIPE_INVOICING_PERCENT : STRIPE_BILLING_PERCENT;
  return ach + Math.round(totalAmountCents * rate) + STRIPE_RADAR_CENTS;
}

// Advances a YYYY-MM-DD by one month, landing on anchorDay where the month has one
// and on the month's last day where it does not.
//
// Anchored to a stored day rather than derived from the previous date, so a
// collaboration billing on the 31st returns to the 31st after February instead of
// ratcheting a day earlier at every short month until it has walked to the 28th.
export function nextMonthlyDate(isoDate, anchorDay) {
  const [y, m] = isoDate.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(anchorDay || Number(isoDate.slice(8, 10)), lastDayOfMonth);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Every invoice Stripe still considers unpaid. Asked of Stripe rather than
// assembled from the app's own records, because the app only knows about invoices
// it issued -- the collaborations still running on subscriptions have their
// invoices created by Stripe, and those are exactly the ones that have gone
// unchased before.
export async function listOpenInvoices(stripe) {
  const res = await stripe.invoices.list({ status: 'open', limit: 100 });
  return res.data;
}

// Issues one month's invoice directly, rather than letting a subscription do it.
//
// The invoice is created before its line item, with pending items excluded, so the
// item can be bound to this invoice by id. Letting Stripe sweep in whatever items
// are pending would put two collaborations on one invoice for a client who has two.
//
// The physician's share is named as an exact figure in transfer_data.amount, where
// the old subscription path could only express it as a percentage and land a cent or
// two out.
export async function createCollaborationInvoice(stripe, {
  customerId, physicianAccountId, totalAmountCents, platformFeeCents,
  paymentTermsDays, description, processingFeeCents, physicianPaidDirectly = false,
}) {
  const params = {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: paymentTermsDays || DEFAULT_PAYMENT_TERMS_DAYS,
    payment_settings: { payment_method_types: ['us_bank_account'] },
    pending_invoice_items_behavior: 'exclude',
    auto_advance: true,
  };

  // transfer_data is the only thing on this invoice that moves money to a
  // physician. For a collaboration whose physician is paid by the client's own
  // practice it is left off entirely and the whole amount settles to the platform.
  // There is no transfer to make zero, because there is no transfer.
  //
  // Where there is a transfer, the physician's share is named in
  // transfer_data.amount rather than taken back afterwards as an
  // application_fee_amount. The two move identical money -- Stripe adds the charge
  // to the platform, sends the share on, and leaves the rest less its own fees --
  // but they show the physician different things. With an application fee, Stripe's
  // own words are that "your connected account can view both the total amount and
  // the application fee amount": Dr Albin's Express Dashboard read $900 with a $200
  // fee, which is the NP's price and the platform's margin, neither of which is
  // hers to see. With transfer_data[amount] it "can't view the total amount of the
  // charge. They only see the amount transferred" -- her $700, which is the only
  // figure the arrangement is between her and us about.
  //
  // The cost is reporting: no Application Fee objects are created any more, so the
  // Dashboard's application-fee report stops filling up and platform earnings come
  // from the Destination Platform Fee column of the balance export instead.
  if (!physicianPaidDirectly) {
    if (!physicianAccountId) {
      throw new Error('createCollaborationInvoice: no physician account to pay, and the collaboration is not marked as paying the physician directly');
    }
    // Derived here rather than passed in, so it cannot drift from the two figures
    // the invoice is actually built out of. In a promotional month the caller's
    // totalAmountCents and platformFeeCents are the promotional pair, and this
    // subtraction is exactly the promotional payout.
    const physicianShareCents = totalAmountCents - platformFeeCents;
    if (!(physicianShareCents > 0) || physicianShareCents > totalAmountCents) {
      throw new Error(`createCollaborationInvoice: physician share of ${physicianShareCents} is not a payable part of ${totalAmountCents}`);
    }
    params.transfer_data = { destination: physicianAccountId, amount: physicianShareCents };
  }

  const invoice = await stripe.invoices.create(params);

  // The client's share of Stripe's cut is already inside totalAmountCents. Naming
  // it as its own line changes only what the invoice reads: the two items still sum
  // to the same total, and transfer_data.amount is untouched, so the physician is
  // paid the same figure either way.
  const processing = processingFeeCents > 0 ? processingFeeCents : 0;

  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,
    amount: totalAmountCents - processing,
    currency: 'usd',
    description,
  });

  if (processing > 0) {
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: processing,
      currency: 'usd',
      description: 'Processing fee',
    });
  }

  // Finalising is what sends it. Left to auto_advance alone the invoice would sit
  // as a draft for about an hour, which makes the billing date the app promises
  // differ from the one the client sees.
  return stripe.invoices.finalizeInvoice(invoice.id);
}

// The client total that leaves the platform with netFeeCents once Stripe has taken
// its cut, holding the physician's payout at the figure they actually agreed to.
//
// Settled by iteration rather than algebra: the fee depends on the total it is being
// used to compute, and the ACH cap makes that relationship piecewise, so a closed
// form needs a separate branch either side of the cap. Starting below the answer and
// adding the fee each pass gives a sequence that only increases and converges within
// two or three rounds; the loop bound is there so a future rate change cannot spin.
// clientFeeShare is how much of Stripe's cut the client carries: 1 puts all of it
// on the invoice, 0 leaves the platform absorbing it as before, and anything
// between splits it. The platform keeps netFeeCents less whatever share it kept.
export function grossUpTotalCents(physicianPayoutCents, netFeeCents, clientFeeShare = 1,
  billingMode = 'subscription') {
  const share = Math.min(1, Math.max(0, Number(clientFeeShare) || 0));
  let total = physicianPayoutCents + netFeeCents;
  for (let i = 0; i < 8; i++) {
    const next = physicianPayoutCents + netFeeCents
      + Math.round(estimateStripeFeeCents(total, billingMode) * share);
    if (next === total) break;
    total = next;
  }
  return total;
}

// Stops a collaboration billing. Cancels immediately rather than at period end:
// ending a collaboration should not leave one more invoice queued behind it.
// Already-issued invoices are unaffected -- work delivered before the end is
// still owed, and Stripe leaves those open.
// Voiding leaves the invoice on the record as cancelled and kills its payment
// link, which is what an invoice for a month of service that never happened
// should become. Marking it uncollectible instead would record a debt written
// off, which is a different and untrue story.
export async function voidInvoice(stripe, invoiceId) {
  return stripe.invoices.voidInvoice(invoiceId);
}

// Every invoice belonging to one client, newest first.
//
// Asked of the customer rather than of the app's own invoice_runs rows, because the
// invoices this is for are precisely the ones the app did not create -- a prorated
// or one-off invoice issued by hand leaves no row behind. The caller has to filter:
// a customer's list spans all of that client's collaborations, so it can contain
// invoices belonging to a different physician entirely.
export async function listInvoicesForCustomer(stripe, customerId, limit = 100) {
  const res = await stripe.invoices.list({ customer: customerId, limit });
  return res.data;
}

// The charge that settled an invoice, and the intent it came from.
//
// Reached through the invoice's own payment record rather than by searching the
// customer's charges by amount or date, which would be guesswork on a client who
// has several collaborations billing similar figures in the same week.
export async function retrieveInvoicePaymentCharge(stripe, invoiceId) {
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] });
  const payments = invoice.payments?.data || [];
  // The paid record is the one that settled it. Falling back to the first covers
  // older invoices whose payment records predate the status field being set.
  const settled = payments.find((p) => p.status === 'paid') || payments[0] || null;
  const intentId = settled?.payment?.payment_intent || null;
  if (!intentId) return { invoice, charge: null, paymentIntent: null };

  const paymentIntent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
  const charge = paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object'
    ? paymentIntent.latest_charge
    : null;
  return { invoice, charge, paymentIntent };
}

// Whether a charge already sent money to a connected account. Four fields are
// checked rather than one because a destination charge and a direct charge record
// it differently, and an invoice built by hand may carry the fee without the
// destination or the other way round. Any of them means the physician was paid.
//
// Both schemes are covered and both must stay covered: an invoice from before the
// move to transfer_data[amount] carries application_fee_amount, and one from after
// carries transfer_data with an amount inside it. A catch-up payout reads this to
// decide whether anything is owed, so dropping either field would offer to pay a
// physician who has already been paid.
export function chargePaidAConnectedAccount(charge) {
  if (!charge) return false;
  return !!(charge.transfer_data || charge.destination
    || charge.application_fee || charge.application_fee_amount);
}

// Whether this platform has already sent a transfer drawn from one specific charge.
// This is what makes a catch-up payout safe to offer twice and send once: the
// transfer records the charge it came from, so the evidence lives in Stripe rather
// than only in the app's own log.
export async function transferExistsForCharge(stripe, accountId, chargeId) {
  const sent = await listTransfersToAccount(stripe, accountId);
  return sent.some((t) => t.source_transaction === chargeId);
}

// Settles a physician's share of an invoice whose charge paid them nothing.
//
// source_transaction is the point of it: the transfer is drawn from that specific
// charge rather than from the platform's general balance, so Stripe's own records
// tie the money to the invoice the client paid, and the funds come from where they
// should have come from in the first place.
//
// The idempotency key stops a double-click. It is not a substitute for the caller's
// duplicate checks: Stripe forgets these keys after about 24 hours, while the
// catchup_payouts table does not.
export async function createCatchupTransfer(stripe, {
  amountCents, destinationAccountId, sourceChargeId, description, metadata, idempotencyKey,
}) {
  return stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: destinationAccountId,
    source_transaction: sourceChargeId,
    description,
    metadata: metadata || {},
  }, idempotencyKey ? { idempotencyKey } : undefined);
}

// The application fee recorded against an invoice, read from its PaymentIntent.
//
// Not from the invoice: in this API version an invoice carries neither
// application_fee_amount nor transfer_data, both of which live on the PaymentIntent
// the invoice generated. Their absence from the invoice JSON is normal and is not
// evidence that a physician's share was left off.
export function applicationFeeOnIntent(paymentIntent) {
  const fee = paymentIntent?.application_fee_amount;
  return Number.isFinite(fee) && fee > 0 ? fee : null;
}

// Rewrites an open invoice so the physician sees only their own share.
//
// Both fields must move in one request. Stripe answers "Only one of
// `application_fee` and `transfer_data[amount]` can be specified" to any attempt to
// add the transfer amount while the fee is still there -- which is also how we know
// a finalised invoice will accept this at all: that is a complaint about the
// combination, not a refusal to edit.
//
// The fee is cleared by sending it empty, which is Stripe's way of unsetting an
// integer. Setting it to 0 would NOT do: an application fee of zero is still an
// application fee, and Stripe shows a connected account the charge total whenever
// one is present. Zero would satisfy the API and defeat the point.
export async function hideInvoiceTotalFromPhysician(stripe, {
  invoiceId, physicianAccountId, physicianShareCents,
}) {
  if (!invoiceId || !physicianAccountId) {
    throw new Error('hideInvoiceTotalFromPhysician: needs an invoice and a physician account');
  }
  if (!Number.isInteger(physicianShareCents) || physicianShareCents <= 0) {
    throw new Error(`hideInvoiceTotalFromPhysician: ${physicianShareCents} is not a payable share`);
  }
  return stripe.invoices.update(invoiceId, {
    transfer_data: { destination: physicianAccountId, amount: physicianShareCents },
    // Empty, not zero. See above.
    application_fee_amount: '',
  });
}

// Whether a connected account can receive a transfer right now.
//
// Read live rather than from the physicians.transfers_active column, which the
// account.updated webhook maintains as a convenience for the admin UI. A stale 1
// there would let an invoice go out carrying a destination the money cannot reach,
// which is the failure this is here to prevent.
export async function accountCanReceiveTransfers(stripe, accountId) {
  if (!accountId) return false;
  const account = await stripe.accounts.retrieve(accountId);
  return account.capabilities?.transfers === 'active';
}

// Every transfer this platform has sent to one connected account, newest first.
// Used to decide whether a physician has actually been paid, which is the thing
// that makes abandoning their account unsafe -- an account that merely looks
// finished has stranded nothing.
export async function listTransfersToAccount(stripe, accountId) {
  const res = await stripe.transfers.list({ destination: accountId, limit: 100 });
  return res.data;
}

export async function retrieveInvoice(stripe, invoiceId) {
  return stripe.invoices.retrieve(invoiceId);
}

export async function listOpenInvoicesForSubscription(stripe, subscriptionId) {
  const res = await stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 100 });
  return res.data;
}

export async function cancelCollaborationSubscription(stripe, subscriptionId) {
  const existing = await stripe.subscriptions.retrieve(subscriptionId);
  if (existing.status === 'canceled') return existing;
  return stripe.subscriptions.cancel(subscriptionId);
}

// Subscription billing, closed rather than converted.
//
// This path paid physicians with application_fee_percent, which is exactly what let
// a physician see the NP's total and MD-Match's fee. A percentage also cannot
// express a flat dollar split exactly: collaboration 6 pays $500 of $700, and the
// nearest amount_percent lands a cent out every month, so converting it would trade
// one wrong thing for another.
//
// Nothing needs it. New collaborations are always app_invoice, and the one live
// subscription -- collaboration 6's -- already exists and is never created again.
// What this refusal actually prevents is a paused subscription-mode collaboration
// being resumed and quietly minting a fresh fee-bearing subscription. Collaboration
// 5 is exactly that: paused, subscription mode, no subscription id, one Resume click
// away.
//
// It throws before touching Stripe rather than creating something that breaks the
// rule in CLAUDE.md. Moving collaboration 6 to app invoices is the fix; the previous
// implementation is in git history if it is ever needed as a reference.
export async function createCollaborationSubscription() {
  throw new Error(
    'createCollaborationSubscription: subscription billing is closed. It paid physicians with '
    + "application_fee_percent, which shows them the NP's total and MD-Match's fee. "
    + "Move this collaboration to billing_mode = 'app_invoice' instead."
  );
}
