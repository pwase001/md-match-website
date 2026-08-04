import Stripe from 'stripe';

export function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY);
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

export async function createOrGetCustomer(stripe, client) {
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

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: description },
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
