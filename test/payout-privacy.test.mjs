// Enforces the billing rule in CLAUDE.md: a physician must only ever see their own
// share. These run before every deploy, and a failure blocks it.
//
// Two kinds of check, because either alone is escapable. The behavioural tests call
// the real functions with a stubbed Stripe and assert what would be sent, which
// catches a change in what the existing paths do. The source scan reads the files
// and catches a path nobody thought to write a behavioural test for -- which is how
// this went wrong the first time: the invoice path was reviewed and the
// hand-written prorated invoice was not.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as stripeHelpers from '../src/stripe-helpers.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Records what would have gone to Stripe without going there.
function stubStripe() {
  const calls = { invoices: [], items: [], transfers: [], subscriptions: [], products: [] };
  return {
    calls,
    invoices: {
      create: async (p) => { calls.invoices.push(p); return { id: 'in_TEST', number: 'TEST-0001' }; },
      finalizeInvoice: async (id) => ({ id, number: 'TEST-0001', status: 'open' }),
    },
    invoiceItems: { create: async (p) => { calls.items.push(p); return { id: 'ii_TEST' }; } },
    transfers: { create: async (p, o) => { calls.transfers.push({ params: p, options: o }); return { id: 'tr_TEST' }; } },
    products: { create: async (p) => { calls.products.push(p); return { id: 'prod_TEST' }; } },
    subscriptions: { create: async (p) => { calls.subscriptions.push(p); return { id: 'sub_TEST' }; } },
  };
}

// A regular collaboration and a promotional one, shaped like the real rows. The
// promotional pair is what collaborationRateOn hands the invoice during a promo
// month, so passing it here exercises the same arithmetic.
const REGULAR = { totalAmountCents: 90000, platformFeeCents: 20000, processingFeeCents: 0,
  expectedShare: 70000 };
const PROMO = { totalAmountCents: 32699, platformFeeCents: 10199, processingFeeCents: 199,
  expectedShare: 22500 };

async function createInvoice(stripe, over = {}) {
  return stripeHelpers.createCollaborationInvoice(stripe, {
    customerId: 'cus_TEST',
    physicianAccountId: 'acct_PHYSICIAN',
    paymentTermsDays: 14,
    description: 'Collaboration services — Test Physician',
    ...REGULAR,
    ...over,
  });
}

// ---- The invoice path, which the monthly sweep and Bill One-Off both use ----

for (const [name, shape] of [['a regular month', REGULAR], ['a promotional month', PROMO]]) {
  test(`invoice in ${name} pays by transfer_data.amount and sets no application fee`, async () => {
    const stripe = stubStripe();
    await createInvoice(stripe, shape);
    const [params] = stripe.calls.invoices;

    assert.ok(!('application_fee_amount' in params),
      'application_fee_amount would show the physician the NP total and the fee');
    assert.ok(!('application_fee_percent' in params),
      'application_fee_percent would show the physician the NP total and the fee');

    assert.ok(params.transfer_data, 'a physician payout needs transfer_data');
    assert.equal(params.transfer_data.destination, 'acct_PHYSICIAN');
    assert.equal(params.transfer_data.amount, shape.expectedShare,
      'the transfer must name the physician share exactly');
    assert.ok(Number.isInteger(params.transfer_data.amount) && params.transfer_data.amount > 0,
      'transfer_data.amount must be a positive whole number of cents');
    assert.ok(params.transfer_data.amount <= shape.totalAmountCents,
      'the physician cannot be sent more than the invoice collects');
  });
}

test('invoice line items sum to the invoice total, so the split cannot silently move money', async () => {
  const stripe = stubStripe();
  await createInvoice(stripe, PROMO);
  const total = stripe.calls.items.reduce((sum, i) => sum + i.amount, 0);
  assert.equal(total, PROMO.totalAmountCents);
});

test('a physician-paid-directly invoice creates no transfer and no application fee', async () => {
  const stripe = stubStripe();
  await createInvoice(stripe, {
    totalAmountCents: 20123, platformFeeCents: 20123, processingFeeCents: 123,
    physicianAccountId: null, physicianPaidDirectly: true,
  });
  const [params] = stripe.calls.invoices;
  assert.ok(!('transfer_data' in params), 'the practice pays the physician, so nothing is forwarded');
  assert.ok(!('application_fee_amount' in params));
  assert.ok(!('application_fee_percent' in params));
});

test('an invoice that would pay a physician nothing is refused rather than sent', async () => {
  for (const [label, totalAmountCents, platformFeeCents] of [
    ['fee equal to the total', 50000, 50000],
    ['fee above the total', 50000, 60000],
  ]) {
    const stripe = stubStripe();
    await assert.rejects(
      () => createInvoice(stripe, { totalAmountCents, platformFeeCents, processingFeeCents: 0 }),
      /not a payable part/,
      `${label} should be refused`
    );
    assert.equal(stripe.calls.invoices.length, 0, 'nothing should reach Stripe');
  }
});

test('an invoice with a physician to pay but no account is refused rather than sent bare', async () => {
  const stripe = stubStripe();
  await assert.rejects(
    () => createInvoice(stripe, { physicianAccountId: null }),
    /no physician account to pay/
  );
  assert.equal(stripe.calls.invoices.length, 0);
});

// ---- The catch-up path ----

test('a catch-up payout is a plain transfer with an explicit amount and source charge', async () => {
  const stripe = stubStripe();
  await stripeHelpers.createCatchupTransfer(stripe, {
    amountCents: 11290,
    destinationAccountId: 'acct_PHYSICIAN',
    sourceChargeId: 'py_TEST',
    description: 'Catch-up',
    metadata: { collaboration_id: '29' },
    idempotencyKey: 'catchup:in_TEST',
  });
  const [{ params, options }] = stripe.calls.transfers;

  assert.ok(!('application_fee_amount' in params));
  assert.ok(!('application_fee_percent' in params));
  assert.equal(params.amount, 11290, 'the transfer must name the amount explicitly');
  assert.equal(params.destination, 'acct_PHYSICIAN');
  assert.equal(params.source_transaction, 'py_TEST',
    'drawing from the charge is what ties the payout to the invoice the NP paid');
  assert.equal(options.idempotencyKey, 'catchup:in_TEST', 'a double-click must not pay twice');
});

// ---- The subscription path ----

test('subscription billing refuses to run rather than paying by application fee', async () => {
  const stripe = stubStripe();
  await assert.rejects(
    () => stripeHelpers.createCollaborationSubscription(stripe, {
      customerId: 'cus_TEST', physicianAccountId: 'acct_PHYSICIAN',
      totalAmountCents: 70000, applicationFeePercent: 28.57,
      startDateISO: '2026-12-01', description: 'x', paymentTermsDays: 14,
    }),
    /subscription billing is closed/
  );
  assert.equal(stripe.calls.subscriptions.length, 0, 'no subscription should be created');
  assert.equal(stripe.calls.products.length, 0, 'not even the product');
});

// ---- Reading an old charge is still allowed ----

test('a charge is still recognised as already paid under either scheme', () => {
  const paid = [
    ['new scheme', { transfer_data: { destination: 'acct_X', amount: 70000 } }],
    ['old application fee', { transfer_data: { destination: 'acct_X' }, application_fee_amount: 20000 }],
    ['legacy destination', { destination: 'acct_X' }],
    ['fee object only', { application_fee: 'fee_X' }],
  ];
  for (const [label, charge] of paid) {
    assert.equal(stripeHelpers.chargePaidAConnectedAccount(charge), true, label);
  }
  // The one that matters: a charge that paid nobody, so a catch-up is owed.
  assert.equal(stripeHelpers.chargePaidAConnectedAccount({
    transfer_data: null, destination: null, application_fee: null, application_fee_amount: null,
  }), false);
});

// ---- Source scan: catches a path with no behavioural test ----

function sourceFiles() {
  return readdirSync(SRC).filter((f) => f.endsWith('.js'))
    .map((f) => [f, readFileSync(join(SRC, f), 'utf8')]);
}

// Strips // line comments and /* */ blocks so prose about application fees -- of
// which there is a lot, explaining why they are not used -- does not trip the scan.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

test('no source file sets application_fee_amount or application_fee_percent as a parameter', () => {
  const offenders = [];
  for (const [file, source] of sourceFiles()) {
    const code = stripComments(source);
    code.split('\n').forEach((line, i) => {
      // An object key, which is how a Stripe parameter is written. A property read
      // such as charge.application_fee_amount has no colon after it and is the
      // legitimate way to inspect an older charge.
      if (/(^|[^.\w])application_fee_(amount|percent)\s*:/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'application fees show physicians the NP total and MD-Match\'s fee; pay with transfer_data.amount instead');
});

test('every Stripe invoice is created through createCollaborationInvoice', () => {
  const offenders = [];
  for (const [file, source] of sourceFiles()) {
    const code = stripComments(source);
    code.split('\n').forEach((line, i) => {
      if (/\binvoices\s*\.\s*create\s*\(/.test(line) && file !== 'stripe-helpers.js') {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'a hand-built invoice can omit the transfer entirely, which is how a physician went unpaid');
});

test('physician-facing emails quote only the payout, never the NP total or the fee', () => {
  const worker = readFileSync(join(SRC, 'worker.js'), 'utf8');
  const offenders = [];

  for (const fn of ['sendPhysicianOnboardingEmail', 'sendCollaborationNoticeEmail']) {
    const start = worker.indexOf(`async function ${fn}`);
    assert.notEqual(start, -1, `${fn} should exist`);
    // To the start of the next top-level function.
    const rest = worker.slice(start + 1);
    const nextFn = rest.search(/\n(?:async )?function /);
    let body = stripComments(nextFn === -1 ? rest : rest.slice(0, nextFn));

    // The payout is the difference between the two, and the promotional payout is
    // stored outright. Both are the physician's own money, so both are allowed.
    // Remove them, then anything left naming the total or the fee is a leak.
    body = body
      .replace(/collaboration\.total_amount_cents\s*-\s*collaboration\.platform_fee_cents/g, 'PAYOUT')
      .replace(/collaboration\.promo_payout_cents/g, 'PROMO_PAYOUT');

    for (const banned of ['total_amount_cents', 'platform_fee_cents', 'promo_total_cents',
      'processing_fee_cents', 'application_fee_percent']) {
      if (body.includes(banned)) offenders.push(`${fn} references ${banned}`);
    }
  }

  assert.deepEqual(offenders, [],
    'a physician email must not state what the NP pays or what MD-Match keeps');
});
