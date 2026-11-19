// Creating a collaboration from the admin form.
//
// The case that brought this file into being: a platform-fee-only collaboration,
// where the NP's practice pays the physician directly and MD-Match bills nothing but
// its own fee. The form rejected every one of them with "Invalid amount".
//
// The guard read `total <= platformFee`. With no payout to the physician the
// platform fee IS the whole invoice, so that was unconditionally true and the row
// could never be created. Collaborations 47 and 48 exist only because they were
// inserted into D1 by hand.
//
// Stripe is stubbed and fetch is stubbed, so no customer is created and no mail is
// sent. The database is real -- node:sqlite in memory -- so the INSERT in db.js runs
// for real and the row that comes back is the row that would be stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { handleCreateCollaboration } from '../src/worker.js';
import * as stripeHelpers from '../src/stripe-helpers.js';

// ---- A real database ----

function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, stripe_customer_id TEXT
    );
    CREATE TABLE physicians (
      id INTEGER PRIMARY KEY, full_name TEXT, email TEXT,
      stripe_account_id TEXT, transfers_active INTEGER DEFAULT 0
    );
    CREATE TABLE collaborations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL, physician_id INTEGER NOT NULL,
      total_amount_cents INTEGER NOT NULL,
      platform_fee_cents INTEGER NOT NULL DEFAULT 20000,
      application_fee_percent REAL NOT NULL,
      start_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_setup',
      stripe_subscription_id TEXT,
      client_payment_method_ready INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      payment_terms_days INTEGER NOT NULL DEFAULT 14,
      reminders_muted INTEGER NOT NULL DEFAULT 0,
      provider_name TEXT, promo_payout_cents INTEGER, promo_end_date TEXT,
      promo_total_cents INTEGER,
      billing_mode TEXT NOT NULL DEFAULT 'subscription',
      billing_day INTEGER, next_invoice_date TEXT,
      processing_fee_cents INTEGER, promo_processing_fee_cents INTEGER,
      physician_paid_directly INTEGER NOT NULL DEFAULT 0
    );
  `);
  sqlite.prepare('INSERT INTO clients (id, full_name, email, stripe_customer_id) VALUES (?, ?, ?, ?)')
    .run(306, 'Daniel Riffe', 'np@example.com', null);
  // Already connected, and irrelevant to a direct-pay row: nothing is forwarded.
  sqlite.prepare('INSERT INTO physicians (id, full_name, email, stripe_account_id, transfers_active) VALUES (?, ?, ?, ?, ?)')
    .run(28, 'Dimitris Gerothanassis', 'doc@example.com', 'acct_PHYSICIAN', 1);
  return { sqlite, DB: d1Shim(sqlite) };
}

function d1Shim(sqlite) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args; return stmt; },
        async run() {
          const r = sqlite.prepare(sql).run(...params);
          return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      };
      return stmt;
    },
  };
}

// ---- Stubs for everything outside the process ----

function stubStripe() {
  const calls = { customers: [], accounts: [] };
  return {
    calls,
    customers: {
      list: async () => ({ data: [] }),
      create: async (p) => { calls.customers.push(p); return { id: 'cus_TEST' }; },
    },
    accounts: {
      retrieve: async (id) => { calls.accounts.push(id); return { capabilities: { transfers: 'active' } }; },
    },
  };
}

async function create(body, { DB }, stripe = stubStripe()) {
  const emails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    emails.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  let res;
  try {
    const request = new Request('https://md-match.com/admin/api/collaborations/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    res = await handleCreateCollaboration(request, { DB, RESEND_API_KEY: 't', ADMIN_PASSWORD: 't' }, stripe);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { res, body: await res.json(), emails, stripe };
}

// Daniel Riffe exactly as the form would submit him.
const DIRECT_PAY = {
  clientId: 306, physicianId: 28,
  physicianPayoutUsd: 0, netFeeUsd: 200, stripeFeeShare: 0.5,
  startDate: '2026-11-19', paymentTermsDays: 14,
  providerName: 'Daniel Riffe',
  physicianPaidDirectly: true,
};

// ---- The bug ----

test('a platform-fee-only collaboration with no intro rate can be created from the form', async () => {
  const { sqlite, DB } = freshDb();
  const { res, body } = await create(DIRECT_PAY, { DB });

  assert.equal(res.status, 200, `rejected: ${JSON.stringify(body)}`);
  assert.equal(body.success, true);

  const row = body.collaboration;
  // $200 of fee, grossed up by half of Stripe's cut, is $201.23 -- the same figure
  // collaboration 47 bills.
  assert.equal(row.total_amount_cents, 20123);
  assert.equal(row.processing_fee_cents, 123);
  // The platform fee is the whole invoice, because nothing is forwarded. This is the
  // state the old guard called invalid.
  assert.equal(row.platform_fee_cents, 20123);
  assert.equal(row.total_amount_cents - row.platform_fee_cents, 0, 'there is no physician share');
  assert.equal(row.physician_paid_directly, 1);
  assert.equal(row.promo_end_date, null);
  assert.equal(row.promo_total_cents, null);
  assert.equal(row.promo_payout_cents, null);
  assert.equal(row.billing_mode, 'app_invoice');
  assert.equal(row.billing_day, 19);
  assert.equal(row.payment_terms_days, 14);
  assert.equal(row.provider_name, 'Daniel Riffe');

  // And it really is in the database, not just in the response.
  const stored = sqlite.prepare('SELECT * FROM collaborations WHERE id = ?').get(row.id);
  assert.equal(stored.total_amount_cents, 20123);
  assert.equal(stored.platform_fee_cents, 20123);
  assert.equal(stored.physician_paid_directly, 1);
});

test('a platform-fee-only collaboration with an intro rate can be created too', async () => {
  // The old guard ran on the standard figures, so it rejected these as well --
  // collaboration 48 could not have been created from the form either.
  const { DB } = freshDb();
  const { res, body } = await create({
    ...DIRECT_PAY, promoNetFeeUsd: 100, promoEndDate: '2027-02-19',
  }, { DB });

  assert.equal(res.status, 200, `rejected: ${JSON.stringify(body)}`);
  assert.equal(body.collaboration.promo_total_cents, 10063);
  assert.equal(body.collaboration.promo_processing_fee_cents, 63);
  // Stored as 0 rather than null, or collaborationRateOn would not see a promotion.
  assert.equal(body.collaboration.promo_payout_cents, 0);
  assert.equal(body.collaboration.promo_end_date, '2027-02-19');
});

test('a direct-pay collaboration creates no Connect account and mails no physician', async () => {
  const { DB } = freshDb();
  const { body, emails, stripe } = await create(DIRECT_PAY, { DB });

  assert.equal(body.success, true);
  assert.deepEqual(stripe.calls.accounts, [],
    'nothing is forwarded, so the physician needs no payout onboarding for this row');
  // Exactly one email, to the client. Mailing a payout link or a rate notice for an
  // arrangement that pays the physician nothing would both be wrong.
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['np@example.com']);
  assert.ok(!/doc@example\.com/.test(JSON.stringify(emails)), 'the physician was mailed');
});

test('a payout typed onto a direct-pay row is ignored, so no share can be carved out', async () => {
  // The invariant the guard encodes: direct-pay means no transfer, whatever the form
  // sends. Without this, a payout smuggled through would leave platform_fee_cents
  // short of the total and the invoice would try to forward money nobody agreed to.
  const { DB } = freshDb();
  const { res, body } = await create({ ...DIRECT_PAY, physicianPayoutUsd: 500 }, { DB });

  assert.equal(res.status, 200, `rejected: ${JSON.stringify(body)}`);
  assert.equal(body.collaboration.total_amount_cents, 20123, 'the payout must not reach the gross-up');
  assert.equal(body.collaboration.platform_fee_cents, 20123);
  assert.equal(body.collaboration.total_amount_cents - body.collaboration.platform_fee_cents, 0);
});

test('the row this creates invoices with no transfer and no application fee', async () => {
  // The property the whole arrangement rests on, checked where it actually bites:
  // the invoice built from the stored row.
  const { DB } = freshDb();
  const { body } = await create(DIRECT_PAY, { DB });
  const row = body.collaboration;

  const calls = { invoices: [], items: [] };
  const stripe = {
    invoices: {
      create: async (p) => { calls.invoices.push(p); return { id: 'in_T' }; },
      finalizeInvoice: async (id) => ({ id, number: 'T-0001', status: 'open' }),
    },
    invoiceItems: { create: async (p) => { calls.items.push(p); return { id: 'ii_T' }; } },
  };

  await stripeHelpers.createCollaborationInvoice(stripe, {
    customerId: 'cus_TEST', physicianAccountId: 'acct_PHYSICIAN',
    totalAmountCents: row.total_amount_cents,
    platformFeeCents: row.platform_fee_cents,
    processingFeeCents: row.processing_fee_cents,
    paymentTermsDays: row.payment_terms_days,
    physicianPaidDirectly: !!row.physician_paid_directly,
    description: 'MD-Match platform fee',
  });

  const [params] = calls.invoices;
  assert.equal(params.transfer_data, undefined, 'a direct-pay invoice must carry no transfer');
  assert.ok(!('application_fee_amount' in params), 'and no application fee, not even zero');
  assert.equal(calls.items.reduce((sum, i) => sum + i.amount, 0), 20123);
});

// ---- What the guard is actually for, still guarded ----

test('an ordinary collaboration is unaffected', async () => {
  const { DB } = freshDb();
  const { res, body } = await create({
    ...DIRECT_PAY, physicianPaidDirectly: false, physicianPayoutUsd: 500, netFeeUsd: 200,
  }, { DB });

  assert.equal(res.status, 200, `rejected: ${JSON.stringify(body)}`);
  const row = body.collaboration;
  assert.equal(row.physician_paid_directly, 0);
  assert.equal(row.total_amount_cents - row.platform_fee_cents, 50000, 'the physician keeps $500');
  assert.ok(row.total_amount_cents > row.platform_fee_cents);
});

test('a fee of zero is still refused, direct-pay or not', async () => {
  for (const directPay of [true, false]) {
    const { DB } = freshDb();
    const { res, body } = await create({
      ...DIRECT_PAY, physicianPaidDirectly: directPay,
      physicianPayoutUsd: directPay ? 0 : 500, netFeeUsd: 0,
    }, { DB });
    assert.equal(res.status, 400, `directPay=${directPay} should be refused`);
    assert.match(body.error, /fee must be greater than zero/);
  }
});

test('a payout of zero on a collaboration that is NOT direct-pay is still refused', async () => {
  const { DB } = freshDb();
  const { res, body } = await create({
    ...DIRECT_PAY, physicianPaidDirectly: false, physicianPayoutUsd: 0,
  }, { DB });
  assert.equal(res.status, 400);
  assert.match(body.error, /Physician payout must be greater than zero/);
});

test('the refusal names the figures rather than saying "Invalid amount"', async () => {
  // The message mattered: "Invalid amount" read like a typo in the form and sent the
  // search for this bug to the wrong place entirely.
  const { DB } = freshDb();
  const { body } = await create({ ...DIRECT_PAY, physicianPaidDirectly: false, physicianPayoutUsd: 0 }, { DB });
  assert.ok(!/^Invalid amount$/.test(body.error));
});

test('a half-specified intro rate is refused with the direct-pay wording', async () => {
  const { DB } = freshDb();
  const { res, body } = await create({ ...DIRECT_PAY, promoNetFeeUsd: 100 }, { DB });
  assert.equal(res.status, 400);
  assert.match(body.error, /needs your fee and the date it ends/);
});

test('an intro fee at or above the standard fee is refused', async () => {
  const { DB } = freshDb();
  const { res, body } = await create({
    ...DIRECT_PAY, promoNetFeeUsd: 200, promoEndDate: '2027-02-19',
  }, { DB });
  assert.equal(res.status, 400);
  assert.match(body.error, /Introductory fee must be less than the standard fee/);
});
