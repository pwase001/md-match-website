import { getStripe, stripeKeyMode } from './stripe-helpers.js';
import * as db from './db.js';

// Stripe splits webhook destinations by scope: platform-account events
// (checkout, subscriptions, invoices) vs connected-account events (account.updated).
// Each scope needs its own destination in the Stripe Dashboard, with its own
// signing secret, so we verify and route them on two separate paths.

export async function handlePlatformWebhook(request, env) {
  return handleWebhook(request, env, env.STRIPE_WEBHOOK_SECRET, handlePlatformEvent);
}

export async function handleConnectWebhook(request, env) {
  return handleWebhook(request, env, env.STRIPE_CONNECT_WEBHOOK_SECRET, handleConnectEvent);
}

async function handleWebhook(request, env, secret, handler) {
  const stripe = getStripe(env);
  const signature = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    // constructEventAsync is required in Workers (no sync Node crypto for signature verification)
    event = await stripe.webhooks.constructEventAsync(body, signature, secret);
  } catch (err) {
    // Key mode is logged here because the usual cause of a sudden burst of
    // signature failures is swapping STRIPE_SECRET_KEY between test and live
    // without replacing the matching webhook signing secret.
    console.error(
      `Webhook signature verification failed (STRIPE_SECRET_KEY mode: ${stripeKeyMode(env)}):`,
      err?.message || err
    );
    return new Response('Invalid signature', { status: 400 });
  }

  // whsec_ signing secrets carry no test/live marker, so a mode mismatch between
  // STRIPE_SECRET_KEY and the webhook secrets cannot be detected from config alone.
  // The verified event's own livemode flag is unambiguous: if it disagrees with the
  // mode the API key implies, the handlers would write rows keyed by IDs from the
  // other mode into D1, so refuse the event instead.
  const expectedMode = stripeKeyMode(env);
  const eventMode = event.livemode ? 'live' : 'test';
  if (expectedMode !== 'unknown' && eventMode !== expectedMode) {
    console.error(
      `Stripe mode mismatch: ${eventMode}-mode event ${event.id} (${event.type}) received ` +
      `while STRIPE_SECRET_KEY is ${expectedMode}-mode. Refusing to process.`
    );
    // Deliberately non-2xx, unlike a handler error below: this is a misconfiguration
    // that needs to surface as a failing delivery in the Stripe Dashboard, and the
    // event should still be waiting once the secrets are corrected.
    return new Response('Stripe mode mismatch', { status: 500 });
  }

  try {
    await handler(event, env);
  } catch (err) {
    console.error('Webhook handler error:', event.type, err?.message || err);
    // Return 200 anyway so Stripe doesn't endlessly retry on our internal bug;
    // the error is logged for follow-up.
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handlePlatformEvent(event, env) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode === 'setup' && session.metadata?.collaboration_id) {
        await db.setCollaborationClientPaymentReady(env.DB, Number(session.metadata.collaboration_id), true);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const collaboration = await db.getCollaborationBySubscriptionId(env.DB, subscription.id);
      if (collaboration) {
        await db.setCollaborationStatus(env.DB, collaboration.id, 'canceled');
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.error('Invoice payment failed:', invoice.id, invoice.customer);
      break;
    }

    default:
      break;
  }
}

async function handleConnectEvent(event, env) {
  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object;
      const transfersActive = account.capabilities?.transfers === 'active';
      await db.setPhysicianTransfersActive(env.DB, account.id, transfersActive);
      break;
    }

    default:
      break;
  }
}
