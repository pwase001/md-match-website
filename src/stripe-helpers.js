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

export async function createPhysicianAccount(stripe, physician) {
  return stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: physician.email,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
    },
    business_profile: {
      product_description: 'Collaborating physician services for NP/PA collaborative practice agreements',
    },
  });
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

// Issues one month's invoice directly, rather than letting a subscription do it.
//
// The invoice is created before its line item, with pending items excluded, so the
// item can be bound to this invoice by id. Letting Stripe sweep in whatever items
// are pending would put two collaborations on one invoice for a client who has two.
//
// Takes application_fee_amount, an exact figure, where the subscription path could
// only pass application_fee_percent and land a cent or two out.
export async function createCollaborationInvoice(stripe, {
  customerId, physicianAccountId, totalAmountCents, platformFeeCents,
  paymentTermsDays, description, processingFeeCents,
}) {
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: paymentTermsDays || DEFAULT_PAYMENT_TERMS_DAYS,
    application_fee_amount: platformFeeCents,
    transfer_data: { destination: physicianAccountId },
    payment_settings: { payment_method_types: ['us_bank_account'] },
    pending_invoice_items_behavior: 'exclude',
    auto_advance: true,
  });

  // The client's share of Stripe's cut is already inside totalAmountCents. Naming
  // it as its own line changes only what the invoice reads: the two items still sum
  // to the same total, and application_fee_amount is untouched, so the physician is
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
export async function cancelCollaborationSubscription(stripe, subscriptionId) {
  const existing = await stripe.subscriptions.retrieve(subscriptionId);
  if (existing.status === 'canceled') return existing;
  return stripe.subscriptions.cancel(subscriptionId);
}

// Creates the recurring collaboration subscription. The platform's cut is a flat
// dollar amount (platformFeeCents), implemented as the percentage of totalAmountCents
// that equals it — Stripe subscriptions only support application_fee_percent natively.
export async function createCollaborationSubscription(stripe, {
  customerId, physicianAccountId, totalAmountCents, applicationFeePercent, startDateISO, description,
  paymentTermsDays,
}) {
  // trial_end exists only to hold the first invoice until a start date that has
  // not arrived yet. Once that date is here, the collaboration should bill now --
  // and Stripe rejects a trial_end in the past outright, which would otherwise
  // make a collaboration unactivatable from its own start date onward.
  //
  // Omitting trial_end starts the subscription immediately: the first invoice
  // issues right away and the monthly cycle anchors to activation. A start date
  // further in the past is deliberately not back-billed -- months nobody invoiced
  // for at the time are not owed retroactively.
  //
  // The 60s margin absorbs clock skew between here and Stripe; without it a start
  // date landing within the same minute could still be rejected as past.
  const startTs = Math.floor(new Date(startDateISO + 'T12:00:00Z').getTime() / 1000);
  const deferToStartDate = startTs > Math.floor(Date.now() / 1000) + 60;

  // Subscription price_data requires an existing product — unlike Checkout Session
  // line_items.price_data, it does not accept inline product_data.
  const product = await stripe.products.create({ name: description });

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [
      {
        price_data: {
          currency: 'usd',
          product: product.id,
          unit_amount: totalAmountCents,
          recurring: { interval: 'month' },
        },
      },
    ],
    ...(deferToStartDate ? { trial_end: startTs } : {}),
    application_fee_percent: applicationFeePercent,
    transfer_data: { destination: physicianAccountId },
    // Invoice the client rather than debiting a saved payment method. Asking a
    // solo practice to pre-authorise a monthly debit to a new vendor is a large
    // trust ask; an emailed invoice they choose to pay is not. The cost is that
    // unpaid invoices have to be chased.
    //
    // collection_method and transfer_data are orthogonal -- the destination
    // transfer is a property of the charge, and the charge happens when the
    // client pays the hosted invoice -- so the split should still apply. That is
    // reasoned from the docs, not observed; see the note in the commit message.
    collection_method: 'send_invoice',
    days_until_due: paymentTermsDays || DEFAULT_PAYMENT_TERMS_DAYS,
    payment_settings: {
      // Governs what the hosted invoice page offers.
      payment_method_types: ['us_bank_account'],
    },
  });

  return subscription;
}
