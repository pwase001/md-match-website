// Dates in outgoing mail read the way a person writes them: "Feb 24, 2027".
//
// Two things are being protected. The obvious one is the format. The other is that
// the day never moves: a date stored as 2027-02-24 is a calendar date, not an
// instant, and formatting it through a timezone is how it ends up reading as the
// 23rd for anyone west of Greenwich. So emailDate builds the date from its three
// numbers and renders it with timeZone 'UTC', and these tests run it under hostile
// timezones to prove it.
//
// No mail is sent: fetch is stubbed, so sendEmail's POST to Resend is captured
// rather than made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emailDate, sendClientBillingEmail, sendCollaborationNoticeEmail,
  sendPhysicianOnboardingEmail, buildPaymentNudge,
} from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- The formatter ----

test('a date reads the way a person writes it', () => {
  // The two the change was asked for by name.
  assert.equal(emailDate('2027-02-24'), 'Feb 24, 2027');
  assert.equal(emailDate('2027-01-01'), 'Jan 1, 2027');

  // No leading zero on the day, short month, year always present.
  assert.equal(emailDate('2026-11-24'), 'Nov 24, 2026');
  assert.equal(emailDate('2026-12-31'), 'Dec 31, 2026');
  assert.equal(emailDate('2028-02-29'), 'Feb 29, 2028');
  assert.equal(emailDate('2026-09-05'), 'Sep 5, 2026');
  assert.equal(emailDate('2027-03-10'), 'Mar 10, 2027');
});

test('every month is spelled the short way', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((name, i) => {
    assert.equal(emailDate(`2027-${String(i + 1).padStart(2, '0')}-15`), `${name} 15, 2027`);
  });
});

test('the day never shifts, whatever timezone the runtime is in', () => {
  // The failure this guards against only appears west of Greenwich, where midnight
  // UTC on the 24th is still the 23rd -- and a Worker runs in UTC, so it would never
  // show up in production until something about the runtime changed.
  const script = "const { emailDate } = await import('./src/worker.js');"
    + "console.log(JSON.stringify(['2027-02-24','2027-01-01','2026-12-31','2026-11-24'].map(emailDate)));";
  const expected = JSON.stringify(['Feb 24, 2027', 'Jan 1, 2027', 'Dec 31, 2026', 'Nov 24, 2026']);

  for (const TZ of ['UTC', 'America/Los_Angeles', 'America/New_York', 'Pacific/Kiritimati',
    'Pacific/Niue', 'Asia/Tokyo', 'Australia/Sydney']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, env: { ...process.env, TZ }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    assert.equal(out, expected, `dates moved under TZ=${TZ}`);
  }
});

test('something that is not a date is left alone rather than printed as Invalid Date', () => {
  for (const value of [null, undefined, '', 'next Tuesday', 'soon']) {
    assert.ok(!/Invalid/.test(emailDate(value)), `${value} produced an Invalid Date`);
  }
  assert.equal(emailDate(null), '');
  assert.equal(emailDate('next Tuesday'), 'next Tuesday');
  // A full timestamp still formats off its date part.
  assert.equal(emailDate('2027-02-24T13:45:00Z'), 'Feb 24, 2027');
});

// ---- The emails themselves ----

const COLLAB = {
  start_date: '2026-11-24', payment_terms_days: 14,
  total_amount_cents: 20123, platform_fee_cents: 15123,
  promo_total_cents: 10063, promo_payout_cents: 2500,
  promo_end_date: '2027-02-24',
};
const CLIENT = { full_name: 'Emilia Garber', email: 'np@example.com' };
const PHYSICIAN = { full_name: 'Dimitris Gerothanassis', email: 'physician@example.com', id: 28 };

// Captures what would have gone to Resend. Nothing leaves the process.
async function render(send) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    await send({ RESEND_API_KEY: 'test', ADMIN_PASSWORD: 'test-secret' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1, 'expected exactly one email');
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  return sent[0].body;
}

// Every date these four emails can print, so a formatted date is not merely present
// somewhere while an ISO one survives elsewhere in the same message.
function assertNoIsoDates(mail, where) {
  const text = `${mail.subject}\n${mail.html || ''}`;
  const iso = text.match(/\d{4}-\d{2}-\d{2}/g);
  assert.equal(iso, null, `${where} still prints an ISO date: ${iso && iso.join(', ')}`);
}

test('the client billing email dates the introductory period in words', async () => {
  const mail = await render((env) => sendClientBillingEmail(env, COLLAB, CLIENT, PHYSICIAN));

  assert.deepEqual(mail.to, ['np@example.com']);
  assert.ok(mail.html.includes('Until Feb 24, 2027: <strong>$100.63</strong> / month'),
    `missing the introductory line:\n${mail.html}`);
  assert.ok(mail.html.includes('From Feb 24, 2027: <strong>$201.23</strong> / month'),
    `missing the standard line:\n${mail.html}`);
  assertNoIsoDates(mail, 'the client billing email');
});

test('the client billing email dates a non-promotional start in words', async () => {
  const plain = { ...COLLAB, promo_end_date: null, promo_total_cents: null };
  const mail = await render((env) => sendClientBillingEmail(env, plain, CLIENT, PHYSICIAN));

  assert.ok(mail.html.includes('Starting Nov 24, 2026, you&#39;ll receive')
    || mail.html.includes("Starting Nov 24, 2026, you'll receive"),
  `missing the start date:\n${mail.html}`);
  assertNoIsoDates(mail, 'the client billing email (no promotion)');
});

test('the physician rate notice dates the introductory period in words', async () => {
  const mail = await render((env) => sendCollaborationNoticeEmail(env, {
    collaboration: COLLAB, client: CLIENT, physician: PHYSICIAN,
    previous: null, alreadyOnboarded: true,
  }));

  assert.deepEqual(mail.to, ['physician@example.com']);
  assert.ok(mail.html.includes('starting Nov 24, 2026'), `missing the start date:\n${mail.html}`);
  assert.ok(mail.html.includes('Until Feb 24, 2027'), `missing the introductory line:\n${mail.html}`);
  assert.ok(mail.html.includes('From Feb 24, 2027'), `missing the standard line:\n${mail.html}`);
  assertNoIsoDates(mail, 'the physician rate notice');
});

test('the physician rate notice dates a standard rate following a promotional one', async () => {
  // The one branch that names the start date outside the opening line.
  const plain = { ...COLLAB, promo_end_date: null, promo_payout_cents: null };
  const mail = await render((env) => sendCollaborationNoticeEmail(env, {
    collaboration: plain, client: CLIENT, physician: PHYSICIAN,
    previous: { promo_end_date: '2027-01-01' }, alreadyOnboarded: true,
  }));

  assert.ok(mail.html.includes('per month from Nov 24, 2026'), `missing the start date:\n${mail.html}`);
  assertNoIsoDates(mail, 'the physician rate notice (standard after promotional)');
});

test('the payout onboarding email dates the payment schedule in words', async () => {
  const mail = await render((env) =>
    sendPhysicianOnboardingEmail(env, 'https://md-match.com', PHYSICIAN, COLLAB));

  assert.deepEqual(mail.to, ['physician@example.com']);
  assert.ok(mail.html.includes('Until Feb 24, 2027'), `missing the introductory line:\n${mail.html}`);
  assert.ok(mail.html.includes('From Feb 24, 2027'), `missing the standard line:\n${mail.html}`);
  assert.ok(mail.html.includes('introductory rate until Feb 24, 2027'),
    `missing the introductory sentence:\n${mail.html}`);
  assert.ok(mail.html.includes('not until Nov 24, 2026'), `missing the start date:\n${mail.html}`);
  assertNoIsoDates(mail, 'the payout onboarding email');
});

test('the payment reminder dates the invoice in words, in the subject and the body', () => {
  // 2027-02-24 12:00 UTC, which is the 24th in Eastern terms too.
  const nudge = buildPaymentNudge({
    id: 'in_X', number: 'GK8SIRSD-0002', amount_remaining: 20123,
    due_date: Math.floor(Date.UTC(2027, 1, 24, 12, 0, 0) / 1000),
    customer_name: 'Emilia Garber', customer_email: 'np@example.com',
    hosted_invoice_url: 'https://invoice.stripe.com/x',
  }, CLIENT);

  assert.equal(nudge.dueOn, 'Feb 24, 2027');
  assert.equal(nudge.subject, 'Invoice GK8SIRSD-0002 — due Feb 24, 2027');
  assert.ok(nudge.body.includes('due tomorrow, Feb 24, 2027'), `missing the due date:\n${nudge.body}`);
  // The old formatter read "Saturday, February 24" -- same date, different shape,
  // and no year on it.
  assert.ok(!/February|Saturday/.test(nudge.subject + nudge.body), 'the old long format survived');
  assert.equal((nudge.subject + nudge.body).match(/\d{4}-\d{2}-\d{2}/), null);
});

// ---- The guard for the next email somebody writes ----

test('every date an email prints goes through the shared formatter', () => {
  const source = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');
  const offenders = [];

  source.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    // A template interpolation naming one of the date columns. These appear only in
    // email text; the billing logic reads them as plain values, not through `${}`.
    for (const m of line.matchAll(/\$\{([^}]*(?:start_date|promo_end_date)[^}]*)\}/g)) {
      if (!m[1].includes('emailDate')) offenders.push(`worker.js:${i + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(offenders, [],
    'a date in an email must be wrapped in emailDate(), or it reaches the reader as 2027-02-24');
});

test('there is one date formatter for emails, not two', () => {
  const source = readFileSync(join(ROOT, 'src', 'worker.js'), 'utf8');
  assert.equal(source.includes('function prettyDate'), false,
    'prettyDate is gone; emailDate is the only formatter for dates people read');
  assert.equal((source.match(/function emailDate\b/g) || []).length, 1);
  // The admin screens and anything stored keep the ISO form, so the formatter must
  // not have been reached for by the collaborations list or the billing maths.
  assert.equal(source.includes("toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short'"), true);
});
