// The Hide Totals replacement, end to end.
//
// An invoice finalised while MD-Match's cut was an application fee shows the
// physician the NP's total and MD-Match's margin. It cannot be edited into shape --
// Stripe freezes monetary fields at finalisation -- so it is replaced: a new invoice
// carrying transfer_data[amount], then the old one voided.
//
// That is three writes to Stripe, one of which cannot be undone, which is why these
// tests exist at the level of the whole handler rather than the individual calls.
// What matters is not any one request but what is left behind when one of them
// fails: at no point may the NP end up with nothing payable, two payable invoices
// that nobody is told about, or a physician's share that went unchecked.
//
// Stripe is a stub. The database is real -- node:sqlite in memory, loaded with the
// actual migration -- so the SQL in db.js is exercised rather than imitated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleHideTotals, compareReplacementDraft } from '../src/worker.js';
import * as stripeHelpers from '../src/stripe-helpers.js';
import * as db from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Collaboration 34 as it really stands: Beverly Aiello with Dr Robert Glenn, in an
// introductory period that runs to 2027-02-07. The invoice under test is the
// promotional one, so the share is promo_payout_cents ($325.00) and not the $650.00
// her standard figures would give -- which is more than the invoice even collects.
const COLLAB = {
  id: 34, client_id: 187, physician_id: 41,
  total_amount_cents: 85424, platform_fee_cents: 20424, processing_fee_cents: 424,
  promo_total_cents: 42759, promo_payout_cents: 32500, promo_processing_fee_cents: 259,
  promo_end_date: '2027-02-07',
  physician_paid_directly: 0,
};
const ACCOUNT = 'acct_1UXOyvH3jtC3QXWF';
const TOTAL = 42759;
const SHARE = 32500;
const FEE = 10259;
// 2026-11-07 and 2026-11-21 in Eastern terms, which is what the handler reports.
const CREATED = 1794052830;
const DUE = 1795262430;

// ---- A real database, with the real migration ----

function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE collaborations (
      id INTEGER PRIMARY KEY, client_id INTEGER, physician_id INTEGER,
      total_amount_cents INTEGER, platform_fee_cents INTEGER, processing_fee_cents INTEGER,
      promo_total_cents INTEGER, promo_payout_cents INTEGER, promo_processing_fee_cents INTEGER,
      promo_end_date TEXT, physician_paid_directly INTEGER DEFAULT 0
    );
    CREATE TABLE physicians (id INTEGER PRIMARY KEY, full_name TEXT, stripe_account_id TEXT);
    CREATE TABLE clients (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT);
    CREATE TABLE invoice_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collaboration_id INTEGER NOT NULL, period TEXT NOT NULL,
      stripe_invoice_id TEXT, error TEXT,
      UNIQUE(collaboration_id, period)
    );
  `);
  // The migration exactly as it will be applied to the remote database.
  sqlite.exec(readFileSync(join(ROOT, 'scripts', 'invoice-replacements.sql'), 'utf8'));

  const cols = Object.keys(COLLAB);
  sqlite.prepare(`INSERT INTO collaborations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((k) => COLLAB[k]));
  sqlite.prepare('INSERT INTO physicians (id, full_name, stripe_account_id) VALUES (?, ?, ?)')
    .run(41, 'Robert Glenn', ACCOUNT);
  sqlite.prepare('INSERT INTO clients (id, full_name, email) VALUES (?, ?, ?)')
    .run(187, 'Beverly Aiello', 'aiellob@ymail.com');
  sqlite.prepare('INSERT INTO invoice_runs (collaboration_id, period, stripe_invoice_id) VALUES (?, ?, ?)')
    .run(34, '2026-11', 'in_OLD');

  return { sqlite, DB: d1Shim(sqlite) };
}

// D1's prepare/bind/run/first/all over node:sqlite, close enough for db.js.
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

// ---- A Stripe that can be told to misbehave ----

function stubStripe(faults = {}) {
  const state = {
    // Anything Stripe would have mailed the NP. Must stay empty: the replacement is
    // announced by hand, so an invoice that advances itself is a bug.
    emails: [],
    log: [],
    nextId: 1,
    invoices: {
      in_OLD: {
        id: 'in_OLD', object: 'invoice', number: 'GK8SIRSD-0001', status: 'open',
        total: TOTAL, subtotal: TOTAL, amount_due: TOTAL, amount_paid: 0, amount_remaining: TOTAL,
        customer: 'cus_NP', description: null, created: CREATED, due_date: DUE,
        status_transitions: { finalized_at: CREATED, voided_at: null },
        collection_method: 'send_invoice', auto_advance: true, metadata: {},
        payment_settings: { payment_method_types: ['us_bank_account'] },
        lines: {
          data: [
            { description: 'Processing fee', amount: 259, currency: 'usd' },
            { description: 'Collaboration services — Robert Glenn (introductory rate)', amount: 42500, currency: 'usd' },
          ],
        },
        payments: { data: [{ status: 'open', payment: { payment_intent: 'pi_OLD' } }] },
        hosted_invoice_url: 'https://invoice.stripe.com/old',
      },
    },
    intents: {
      pi_OLD: {
        id: 'pi_OLD', status: 'requires_payment_method', amount: TOTAL,
        // The whole problem: the physician can read both of these.
        application_fee_amount: FEE,
        transfer_data: { destination: ACCOUNT },
        latest_charge: null,
      },
    },
  };

  const stripe = {
    state,
    invoices: {
      async create(params) {
        state.log.push('invoices.create');
        if (faults.createFails) throw new Error(faults.createFails);
        const id = `in_NEW${state.nextId++}`;
        state.invoices[id] = {
          id, object: 'invoice', number: null, status: 'draft',
          total: 0, subtotal: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0,
          customer: params.customer, description: params.description ?? null,
          created: CREATED + 10, due_date: params.due_date ?? null,
          status_transitions: { finalized_at: null, voided_at: null },
          collection_method: params.collection_method,
          auto_advance: params.auto_advance,
          metadata: params.metadata || {},
          payment_settings: params.payment_settings || {},
          lines: { data: [] },
          hosted_invoice_url: null,
          // Held the way Stripe holds them -- off the invoice the API returns, to be
          // handed to the PaymentIntent at finalisation. The Invoice object in this
          // API version carries neither field, which is exactly why a draft cannot
          // be checked for them.
          _transfer_data: params.transfer_data || null,
          _application_fee_amount: params.application_fee_amount,
        };
        return { ...state.invoices[id] };
      },
      async retrieve(id) {
        state.log.push(`invoices.retrieve(${id})`);
        const inv = state.invoices[id];
        if (!inv) throw new Error(`No such invoice: ${id}`);
        const { _transfer_data, _application_fee_amount, ...visible } = inv;
        return structuredClone(visible);
      },
      async del(id) {
        state.log.push(`invoices.del(${id})`);
        if (faults.deleteFails) throw new Error(faults.deleteFails);
        if (state.invoices[id].status !== 'draft') throw new Error('Only a draft invoice can be deleted');
        delete state.invoices[id];
        return { id, deleted: true };
      },
      async finalizeInvoice(id, opts = {}) {
        state.log.push(`invoices.finalizeInvoice(${id})`);
        if (faults.finalizeFails) throw new Error(faults.finalizeFails);
        const inv = state.invoices[id];
        inv.status = 'open';
        inv.number = 'GK8SIRSD-0002';
        inv.status_transitions.finalized_at = CREATED + 20;
        inv.amount_due = inv.total;
        inv.amount_remaining = inv.total;
        inv.hosted_invoice_url = `https://invoice.stripe.com/${id}`;
        // Stripe mails a send_invoice invoice as part of automatic collection. An
        // invoice finalised with collection off becomes payable silently.
        if (opts.auto_advance !== false) state.emails.push(id);

        const pi = `pi_${id}`;
        state.intents[pi] = {
          id: pi,
          status: faults.newIntentProcessing ? 'processing' : 'requires_payment_method',
          amount: inv.total,
          transfer_data: faults.dropTransferAmount
            ? { destination: inv._transfer_data?.destination }
            : (inv._transfer_data ? { ...inv._transfer_data } : null),
          latest_charge: null,
        };
        if (inv._application_fee_amount !== undefined || faults.feeSurvives) {
          state.intents[pi].application_fee_amount = faults.feeSurvives
            ? FEE : inv._application_fee_amount;
        }
        inv.payments = { data: [{ status: 'open', payment: { payment_intent: pi } }] };
        return structuredClone({ ...inv, _transfer_data: undefined, _application_fee_amount: undefined });
      },
      async voidInvoice(id) {
        state.log.push(`invoices.voidInvoice(${id})`);
        if (faults.voidOldFails && id === 'in_OLD') throw new Error(faults.voidOldFails);
        if (faults.voidNewFails && id !== 'in_OLD') throw new Error(faults.voidNewFails);
        state.invoices[id].status = 'void';
        state.invoices[id].status_transitions.voided_at = CREATED + 30;
        return { id, status: 'void' };
      },
      async update() { throw new Error('a finalised invoice must never be edited'); },
    },
    invoiceItems: {
      async create(params) {
        state.log.push('invoiceItems.create');
        const inv = state.invoices[params.invoice];
        inv.lines.data.push({
          description: params.description, amount: params.amount, currency: params.currency,
        });
        inv.total += params.amount;
        inv.subtotal = inv.total;
        return { id: `ii_${state.nextId++}` };
      },
    },
    paymentIntents: {
      async retrieve(id) {
        state.log.push(`paymentIntents.retrieve(${id})`);
        // The NP starting an ACH debit part-way through, between the check on submit
        // and the check after the draft is built.
        if (faults.oldIntentBecomes && id === 'pi_OLD') {
          faults.oldIntentReads = (faults.oldIntentReads || 0) + 1;
          if (faults.oldIntentReads > (faults.oldIntentAfter ?? 1)) {
            return { ...state.intents.pi_OLD, status: faults.oldIntentBecomes };
          }
        }
        return structuredClone(state.intents[id]);
      },
    },
  };
  return stripe;
}

function postHideTotals(env, stripe, body = { collaborationId: 34, invoiceId: 'in_OLD' }) {
  const request = new Request('https://md-match.com/admin/api/collaborations/hide-totals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return handleHideTotals(request, env, stripe);
}

async function run(faults = {}) {
  const { sqlite, DB } = freshDb();
  const stripe = stubStripe(faults);
  const res = await postHideTotals({ DB }, stripe);
  return { res, body: await res.json(), stripe, sqlite, DB };
}

function replacementRow(sqlite) {
  return sqlite.prepare('SELECT * FROM invoice_replacements WHERE old_invoice_id = ?').get('in_OLD');
}
function invoiceRun(sqlite) {
  return sqlite.prepare('SELECT * FROM invoice_runs WHERE collaboration_id = 34 AND period = ?').get('2026-11');
}
function replacementInvoice(stripe) {
  return Object.values(stripe.state.invoices).find((i) => i.id !== 'in_OLD');
}

// ---- It works ----

test('the replacement pays the physician their share and shows them nothing else', async () => {
  const { res, body, stripe, sqlite } = await run();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);

  // The four figures the review screen promises for collaboration 34.
  assert.equal(body.before.totalCents, 42759);
  assert.equal(body.shareCents, 32500);
  assert.equal(body.promotional, true);
  assert.equal(body.after.destination, ACCOUNT);
  assert.equal(body.after.dueOn, '2026-11-21');
  assert.equal(body.before.dueOn, '2026-11-21');

  // What the physician will actually be able to read, from the PaymentIntent.
  assert.equal(body.after.transferAmountCents, SHARE);
  assert.equal(body.after.applicationFeeCents, null);
  assert.equal(body.after.amountCents, TOTAL);
  assert.equal(body.after.totalCents, TOTAL);
  assert.equal(body.after.status, 'open');

  // The old one is gone and the new one is the only payable invoice.
  assert.equal(stripe.state.invoices.in_OLD.status, 'void');
  const made = replacementInvoice(stripe);
  assert.equal(made.status, 'open');
  assert.equal(made.metadata.replaces_invoice, 'in_OLD');
  assert.equal(made.due_date, DUE, 'the NP keeps the due date she was given');
  assert.equal(made.customer, 'cus_NP');
  assert.equal(made.collection_method, 'send_invoice');
  assert.deepEqual(made.payment_settings.payment_method_types, ['us_bank_account']);
  assert.equal(made._application_fee_amount, undefined, 'no application fee, not even zero');
  assert.deepEqual(made._transfer_data, { destination: ACCOUNT, amount: SHARE });

  // Same lines, same total.
  assert.deepEqual(
    made.lines.data.map((l) => [l.description, l.amount]).sort(),
    stripe.state.invoices.in_OLD.lines.data.map((l) => [l.description, l.amount]).sort()
  );

  // The NP gets the link by hand; nothing is mailed by the app or by Stripe.
  assert.deepEqual(stripe.state.emails, []);
  assert.equal(body.after.hostedInvoiceUrl, `https://invoice.stripe.com/${made.id}`);

  // November stays claimed, so the sweep cannot bill it again, and now names the
  // replacement rather than a voided invoice.
  assert.equal(body.invoiceRunRepointed, true);
  assert.equal(invoiceRun(sqlite).stripe_invoice_id, made.id);
  assert.equal(replacementRow(sqlite).stage, 'done');
  assert.equal(replacementRow(sqlite).new_invoice_number, 'GK8SIRSD-0002');
});

test('the replacement is finalised before the original is voided, never the other way round', async () => {
  const { stripe } = await run();
  const order = stripe.state.log.filter((l) => /finalizeInvoice|voidInvoice/.test(l));
  assert.deepEqual(order, ['invoices.finalizeInvoice(in_NEW1)', 'invoices.voidInvoice(in_OLD)'],
    'voiding first would destroy a payable invoice before knowing its replacement is right');
});

// ---- A void that fails once the replacement exists ----

test('a failed void on the original leaves the replacement payable and says both are open', async () => {
  const { res, body, stripe, sqlite } = await run({ voidOldFails: 'Invoice is already paid' });

  assert.equal(res.status, 500);
  assert.equal(body.success, false);
  assert.match(body.error, /two open invoices/);
  assert.match(body.error, /Void GK8SIRSD-0001 in Stripe by hand/);
  assert.match(body.error, /nothing else needs redoing/);

  // Both really are open, and the report says so rather than guessing.
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementInvoice(stripe).status, 'open');
  assert.equal(body.after.status, 'open');
  assert.equal(body.after.transferAmountCents, SHARE);

  // The claim records where it stopped, so a second click cannot start another
  // replacement on top of the one already sitting in Stripe.
  const row = replacementRow(sqlite);
  assert.equal(row.stage, 'finalized');
  assert.match(row.error, /could not be voided/);

  // November still names the old invoice: nothing is repointed at a replacement
  // while the invoice it replaces is still collectable.
  assert.equal(invoiceRun(sqlite).stripe_invoice_id, 'in_OLD');
});

test('a second attempt after a half-finished replacement is refused, not retried', async () => {
  const { sqlite, DB } = freshDb();
  const first = await postHideTotals({ DB }, stubStripe({ voidOldFails: 'nope' }));
  assert.equal(first.status, 500);

  const res = await postHideTotals({ DB }, stubStripe());
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.error, /already started and stopped at "finalized"/);
  assert.match(body.error, /look at both invoices in Stripe/);
  assert.equal(replacementRow(sqlite).stage, 'finalized');
});

test('an invoice already replaced cannot be replaced again', async () => {
  const { DB } = freshDb();
  assert.equal((await postHideTotals({ DB }, stubStripe())).status, 200);

  // Claimed in the database, and the old invoice is void in Stripe besides.
  const res = await postHideTotals({ DB }, stubStripe());
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.error, /already replaced by GK8SIRSD-0002/);
});

// ---- An NP who starts paying while the replacement is being built ----

test('a PaymentIntent that starts processing between the checks stops the replacement', async () => {
  // Passes the check on submit, reads as processing on the re-check after the draft
  // is built -- an ACH debit begun in the seconds the draft took.
  const { res, body, stripe, sqlite } = await run({ oldIntentBecomes: 'processing', oldIntentAfter: 1 });

  assert.equal(res.status, 409);
  assert.equal(body.success, false);
  assert.match(body.error, /Payment has started/);
  assert.match(body.error, /the PaymentIntent is processing/);
  assert.match(body.error, /GK8SIRSD-0001 is untouched/);

  // Nothing was finalised and nothing was voided.
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementInvoice(stripe), undefined, 'the draft must be deleted');
  assert.ok(!stripe.state.log.some((l) => l.includes('finalizeInvoice')));
  assert.ok(!stripe.state.log.some((l) => l.includes('voidInvoice')));
  assert.deepEqual(stripe.state.emails, []);

  // Nothing happened in Stripe, so the claim goes too and the button can be used
  // again once the debit has settled.
  assert.equal(replacementRow(sqlite), undefined);
  assert.equal(invoiceRun(sqlite).stripe_invoice_id, 'in_OLD');
});

test('a payment already under way on submit is refused before anything is created', async () => {
  const { res, body, stripe, sqlite } = await run({ oldIntentBecomes: 'processing', oldIntentAfter: 0 });
  assert.equal(res.status, 409);
  assert.match(body.error, /Payment has started/);
  assert.ok(!stripe.state.log.some((l) => l.includes('invoices.create')));
  assert.equal(replacementRow(sqlite), undefined);
});

// ---- A replacement that comes back wrong is rolled back, not kept ----

test('a replacement whose transfer amount is missing is voided and the original kept', async () => {
  const { res, body, stripe, sqlite } = await run({ dropTransferAmount: true });

  assert.equal(res.status, 500);
  assert.match(body.error, /was voided/);
  assert.match(body.error, /still open and unchanged/);
  assert.ok(body.problems.some((p) => /transfer_data\.amount is unset/.test(p)));
  assert.equal(body.replacementVoided, true);

  assert.equal(stripe.state.invoices.in_OLD.status, 'open', 'the NP must still have a payable invoice');
  assert.equal(replacementInvoice(stripe).status, 'void');
  assert.equal(replacementRow(sqlite).stage, 'rolled_back');
  assert.equal(invoiceRun(sqlite).stripe_invoice_id, 'in_OLD');
});

test('a replacement that somehow still carries an application fee is voided', async () => {
  const { res, body, stripe } = await run({ feeSurvives: true });
  assert.equal(res.status, 500);
  assert.ok(body.problems.some((p) => /still carries an application fee/.test(p)));
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementInvoice(stripe).status, 'void');
});

test('a replacement that cannot be rolled back says so in as many words', async () => {
  const { res, body } = await run({ dropTransferAmount: true, voidNewFails: 'Stripe is down' });
  assert.equal(res.status, 500);
  assert.equal(body.replacementVoided, false);
  assert.match(body.error, /could not be voided/);
  assert.match(body.error, /Both GK8SIRSD-0001 and GK8SIRSD-0002 are now open/);
  assert.match(body.error, /void GK8SIRSD-0002/);
});

// ---- Stripe refusing at each step ----

test('a draft Stripe will not create leaves the original exactly as it was', async () => {
  const { res, body, stripe, sqlite } = await run({ createFails: 'Invalid integer: ' });
  assert.equal(res.status, 502);
  assert.match(body.error, /GK8SIRSD-0001 is exactly as it was/);
  assert.equal(body.detail, 'Invalid integer: ');
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementRow(sqlite), undefined, 'the claim must not outlive a failure that created nothing');
});

test('a draft Stripe will not finalise is deleted and the original left alone', async () => {
  const { res, body, stripe, sqlite } = await run({ finalizeFails: 'Nothing to invoice' });
  assert.equal(res.status, 502);
  assert.match(body.error, /the draft was deleted/);
  assert.match(body.error, /GK8SIRSD-0001 is exactly as it was/);
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementInvoice(stripe), undefined);
  assert.deepEqual(stripe.state.emails, []);
  assert.equal(replacementRow(sqlite), undefined);
});

test('a draft that can neither be used nor deleted is reported, not swallowed', async () => {
  const { res, body, sqlite } = await run({
    finalizeFails: 'Nothing to invoice', deleteFails: 'Invoice is not a draft',
  });
  assert.equal(res.status, 502);
  assert.match(body.error, /left behind as draft in_NEW1/);
  assert.equal(body.draftLeftBehind, 'in_NEW1');
  assert.equal(body.draftDeleteError, 'Invoice is not a draft');
  // The claim stays, because something is in Stripe that a retry would duplicate.
  assert.equal(replacementRow(sqlite).stage, 'draft_created');
});

// ---- The draft is checked against the original before it is allowed to exist ----

test('a draft that does not match the original is deleted and nothing is voided', async () => {
  // A line item that fails to attach: the draft would collect less than the invoice
  // it replaces, which must never reach the NP.
  const { sqlite, DB } = freshDb();
  const stripe = stubStripe();
  const realCreate = stripe.invoiceItems.create;
  let seen = 0;
  stripe.invoiceItems.create = async (p) => (++seen === 1 ? { id: 'ii_lost' } : realCreate(p));

  const res = await postHideTotals({ DB }, stripe);
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.match(body.error, /did not match the original, so it was deleted/);
  assert.ok(body.problems.some((p) => /totals \$425\.00 but the original is \$427\.59/.test(p)));
  assert.equal(stripe.state.invoices.in_OLD.status, 'open');
  assert.equal(replacementInvoice(stripe), undefined);
  assert.ok(!stripe.state.log.some((l) => l.includes('voidInvoice')));
  assert.equal(replacementRow(sqlite), undefined);
});

test('the draft comparison catches every way a replacement could differ', () => {
  const old = {
    total: TOTAL, due_date: DUE, customer: 'cus_NP',
    lines: { data: [{ description: 'Processing fee', amount: 259 }, { description: 'Services', amount: 42500 }] },
  };
  const good = {
    status: 'draft', total: TOTAL, due_date: DUE, customer: 'cus_NP',
    collection_method: 'send_invoice', auto_advance: false,
    metadata: { replaces_invoice: 'in_OLD' },
    payment_settings: { payment_method_types: ['us_bank_account'] },
    lines: old.lines,
  };
  assert.deepEqual(compareReplacementDraft(good, old, 'in_OLD'), []);

  const cases = [
    [{ status: 'open' }, /is open, not a draft/],
    [{ total: 42500 }, /totals \$425\.00 but the original is \$427\.59/],
    [{ due_date: DUE + 86400 }, /due date does not match/],
    [{ customer: 'cus_OTHER' }, /different customer/],
    [{ collection_method: 'charge_automatically' }, /collection method is charge_automatically/],
    [{ auto_advance: true }, /auto_advance is on/],
    [{ metadata: {} }, /replaces_invoice metadata is missing/],
    [{ payment_settings: { payment_method_types: ['card'] } }, /not us_bank_account alone/],
    [{ lines: { data: [{ description: 'Services', amount: TOTAL }] } }, /lines differ from the original/],
  ];
  for (const [over, pattern] of cases) {
    const problems = compareReplacementDraft({ ...good, ...over }, old, 'in_OLD');
    assert.ok(problems.some((p) => pattern.test(p)),
      `${JSON.stringify(over)} should be caught; got ${JSON.stringify(problems)}`);
  }
});

// ---- The helpers on their own ----

test('a replacement draft is built with a transfer amount and no application fee', async () => {
  const stripe = stubStripe();
  const draft = await stripeHelpers.createReplacementInvoiceDraft(stripe, {
    customerId: 'cus_NP', physicianAccountId: ACCOUNT, physicianShareCents: SHARE,
    replacesInvoiceId: 'in_OLD', dueDate: DUE, description: null,
    lines: [{ amount: 42500, currency: 'usd', description: 'Services' },
      { amount: 259, currency: 'usd', description: 'Processing fee' }],
  });
  const held = stripe.state.invoices[draft.id];
  assert.deepEqual(held._transfer_data, { destination: ACCOUNT, amount: SHARE });
  assert.equal(held._application_fee_amount, undefined);
  assert.equal(held.auto_advance, false, 'a draft that advances itself would mail the NP');
  assert.equal(held.due_date, DUE);
  assert.equal(held.description, null, 'an absent memo is not sent as an explicit null');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.total, TOTAL, 'the draft is read back, so it carries its lines');
  assert.ok(!('transfer_data' in draft), 'the Invoice object does not expose it in this API version');
});

test('a replacement draft refuses bad figures before calling Stripe', async () => {
  const base = {
    customerId: 'cus_NP', physicianAccountId: ACCOUNT, physicianShareCents: SHARE,
    replacesInvoiceId: 'in_OLD', dueDate: DUE,
    lines: [{ amount: TOTAL, currency: 'usd', description: 'Services' }],
  };
  for (const [over, pattern] of [
    [{ physicianShareCents: 0 }, /not a payable share/],
    [{ physicianShareCents: -1 }, /not a payable share/],
    [{ physicianShareCents: 325.5 }, /not a payable share/],
    [{ physicianAccountId: null }, /needs a customer, a physician account/],
    [{ customerId: null }, /needs a customer, a physician account/],
    [{ replacesInvoiceId: null }, /needs a customer, a physician account/],
    [{ lines: [] }, /needs the old invoice lines/],
  ]) {
    const stripe = stubStripe();
    await assert.rejects(
      () => stripeHelpers.createReplacementInvoiceDraft(stripe, { ...base, ...over }),
      pattern, JSON.stringify(over)
    );
    assert.deepEqual(stripe.state.log, [], 'nothing should reach Stripe');
  }
});

test('finalising a replacement turns automatic collection off, which is what keeps it quiet', async () => {
  const stripe = stubStripe();
  const draft = await stripeHelpers.createReplacementInvoiceDraft(stripe, {
    customerId: 'cus_NP', physicianAccountId: ACCOUNT, physicianShareCents: SHARE,
    replacesInvoiceId: 'in_OLD', dueDate: DUE,
    lines: [{ amount: TOTAL, currency: 'usd', description: 'Services' }],
  });
  await stripeHelpers.finalizeInvoiceWithoutSending(stripe, draft.id);
  assert.deepEqual(stripe.state.emails, []);
  assert.equal(stripe.state.invoices[draft.id].status, 'open');
  assert.ok(stripe.state.invoices[draft.id].hosted_invoice_url, 'it still has a payment link');
});

test('the old invoice is never edited, because a finalised invoice cannot be', async () => {
  const { stripe } = await run();
  assert.ok(!stripe.state.log.some((l) => l.includes('invoices.update')),
    'editing it is what failed in production: monetary fields are frozen at finalisation');
});
