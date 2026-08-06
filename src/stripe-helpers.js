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

// Creates the recurring collaboration subscription. The platform's cut is a flat
// dollar amount (platformFeeCents), implemented as the percentage of totalAmountCents
// that equals it — Stripe subscriptions only support application_fee_percent natively.
export async function createCollaborationSubscription(stripe, {
  customerId, physicianAccountId, totalAmountCents, applicationFeePercent, startDateISO, description,
}) {
  const trialEnd = Math.floor(new Date(startDateISO + 'T12:00:00Z').getTime() / 1000);

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
    trial_end: trialEnd,
    application_fee_percent: applicationFeePercent,
    transfer_data: { destination: physicianAccountId },
    payment_settings: {
      payment_method_types: ['us_bank_account'],
      save_default_payment_method: 'on_subscription',
    },
  });

  return subscription;
}
