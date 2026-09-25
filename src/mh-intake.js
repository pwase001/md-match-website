// Endpoints for the asynchronous mental health intake: the patient's link
// (start, save each answer, submit, request a video visit) and the provider
// review pages behind the admin login.
//
// The patient's link carries a random token; only its hash is stored. Nothing
// sent by email contains answers or the patient's name: alerts carry the
// patient ID, and the provider reads the intake behind the admin login.

import * as db from './db.js';
import * as tokens from './tokens.js';
import { QUESTION_BY_ID, visibleQuestions, isAnswered } from '../mh-intake-questions.js';
import { evaluate, urgentAlerts, answerTranscript } from './mh-intake-rules.js';

const MAX_ANSWER_BYTES = 20000;
const MAX_CHANGE_LOG = 500;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomPublicId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'MH-' + [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

async function intakeFromToken(env, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  return db.getMhIntakeByTokenHash(env.DB, await sha256(token));
}

function parse(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !to) {
    console.error('Mental health intake email not sent: RESEND_API_KEY or recipient missing', subject);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'MD-Match Mental Health <noreply@md-match.com>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', res.status, await res.text());
  return res.ok;
}

// ------------------------------------------------------------------ Patient

export async function handleMhIntakeApi(request, env, url) {
  try {
    if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
    const body = await request.json().catch(() => ({}));
    const route = url.pathname.slice('/api/mh-intake/'.length);

    if (route === 'start') return start(env);

    const intake = await intakeFromToken(env, body.t);
    if (!intake) return json({ success: false, error: 'This intake link is not valid.' }, 404);

    if (route === 'state') return state(env, intake);
    if (route === 'answer') return saveAnswer(request, env, intake, body);
    if (route === 'submit') return submit(env, intake);
    if (route === 'visit-request') return visitRequest(env, intake, body);
    return json({ success: false, error: 'Not found' }, 404);
  } catch (err) {
    console.error('Mental health intake error:', err);
    return json({ success: false, error: 'Server error' }, 500);
  }
}

async function start(env) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await db.createMhIntake(env.DB, { publicId: randomPublicId(), tokenHash });
      return json({ success: true, token, publicId: row.public_id });
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  return json({ success: false, error: 'Could not start intake' }, 500);
}

function state(env, intake) {
  if (intake.status === 'in_progress') {
    return json({ success: true, status: intake.status, publicId: intake.public_id, answers: parse(intake.answers, {}) });
  }
  // Once submitted, the link no longer returns answers: a forwarded or
  // shoulder-surfed link should not reveal the intake.
  return json({
    success: true,
    status: 'submitted',
    publicId: intake.public_id,
    outcome: intake.outcome,
    visitRequested: !!intake.visit_request,
    schedulingUrl: intake.outcome === 'video_visit' ? env.MH_SCHEDULING_URL || null : null,
  });
}

async function saveAnswer(request, env, intake, body) {
  if (intake.status !== 'in_progress') return json({ success: false, error: 'This intake has already been submitted.' }, 409);
  const q = QUESTION_BY_ID[body.id];
  if (!q || q.type === 'info') return json({ success: false, error: 'Unknown question' }, 400);
  const value = body.value;
  if (JSON.stringify(value ?? null).length > MAX_ANSWER_BYTES) return json({ success: false, error: 'Answer too long' }, 400);
  if (!validShape(q, value)) return json({ success: false, error: 'Invalid answer' }, 400);

  const answers = parse(intake.answers, {});
  const changeLog = parse(intake.change_log, []);
  const before = answers[q.id];
  if (before !== undefined && JSON.stringify(before) !== JSON.stringify(value) && changeLog.length < MAX_CHANGE_LOG) {
    changeLog.push({ id: q.id, from: before, to: value, at: new Date().toISOString() });
  }
  if (value === null || value === undefined) delete answers[q.id];
  else answers[q.id] = q.type === 'consent' ? { ...value, signedAt: new Date().toISOString().slice(0, 10) } : value;
  await db.saveMhIntakeAnswers(env.DB, intake.id, { answers, changeLog });

  await sendUrgentAlerts(request, env, intake, answers);
  return json({ success: true });
}

function validShape(q, v) {
  if (v === null || v === undefined) return true;
  const optionValues = (q.options || []).map((o) => o.value);
  switch (q.type) {
    case 'single':
      return optionValues.includes(v);
    case 'multi':
      return Array.isArray(v) && v.every((x) => optionValues.includes(x));
    case 'height':
      return typeof v === 'object' && Number.isFinite(Number(v.ft)) && Number.isFinite(Number(v.in || 0));
    case 'number':
      return Number.isFinite(Number(v)) && (q.min === undefined || Number(v) >= q.min) && (q.max === undefined || Number(v) <= q.max);
    case 'medlist':
      return Array.isArray(v) && v.length <= 50 && v.every((r) => r && typeof r === 'object');
    case 'consent':
      return typeof v === 'object' && typeof v.agree === 'boolean' && typeof (v.signature ?? '') === 'string';
    default:
      return typeof v === 'string';
  }
}

async function sendUrgentAlerts(request, env, intake, answers) {
  const sent = parse(intake.alerts_sent, []);
  const due = urgentAlerts(answers).filter((a) => !sent.includes(a.kind));
  if (!due.length) return;
  const reviewUrl = `${new URL(request.url).origin}/admin-mh-intakes#${intake.public_id}`;
  for (const alert of due) {
    const ok = await sendEmail(env, {
      to: env.CLINICAL_LEAD_EMAIL,
      subject: `${alert.subject} – ${intake.public_id}`,
      html: `<p><strong>${alert.subject}</strong></p>
        <p>Patient ID: <strong>${intake.public_id}</strong></p>
        <p>${alert.detail}</p>
        <p>The patient was shown crisis resources (911 / 988) on screen. They may still be completing the intake.</p>
        <p><a href="${reviewUrl}">Open the intake</a> (requires admin login).</p>`,
    });
    // Recorded only once delivered, so a failed send is retried on the
    // patient's next saved answer.
    if (ok) sent.push(alert.kind);
  }
  await db.setMhIntakeAlertsSent(env.DB, intake.id, sent);
}

async function submit(env, intake) {
  if (intake.status !== 'in_progress') return state(env, intake);
  const answers = parse(intake.answers, {});
  const missing = visibleQuestions(answers).find((q) => !isAnswered(q, answers[q.id]));
  if (missing) return json({ success: false, error: 'Please answer every question before submitting.', missing: missing.id }, 400);

  const evaluation = evaluate(answers);
  const submitted = await db.submitMhIntake(env.DB, intake.id, { evaluation, outcome: evaluation.outcome });
  if (!submitted) return state(env, await db.getMhIntakeByPublicId(env.DB, intake.public_id));

  if (env.MH_INTAKE_NOTIFY_EMAIL) {
    await sendEmail(env, {
      to: env.MH_INTAKE_NOTIFY_EMAIL,
      subject: `New mental health intake – ${intake.public_id}`,
      html: `<p>Intake <strong>${intake.public_id}</strong> was submitted and is ready for review.</p>
        <p>Outcome: ${evaluation.outcome === 'video_visit' ? 'Video visit' : 'Asynchronous review'}</p>
        <p>Open the provider review page to read it (requires admin login).</p>`,
    });
  }
  return json({ success: true, status: 'submitted', publicId: intake.public_id, outcome: evaluation.outcome, schedulingUrl: env.MH_SCHEDULING_URL || null });
}

async function visitRequest(env, intake, body) {
  if (intake.status === 'in_progress' || intake.outcome !== 'video_visit') {
    return json({ success: false, error: 'A video visit is not available for this intake.' }, 409);
  }
  const clean = (v, n) => String(v || '').trim().slice(0, n);
  const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, 40)).filter(Boolean).slice(0, 20) : []);
  const request = {
    days: list(body.days),
    times: list(body.times),
    timezone: clean(body.timezone, 60),
    phone: clean(body.phone, 40),
    notes: clean(body.notes, 1000),
    requestedAt: new Date().toISOString(),
  };
  if (!request.days.length || !request.times.length) {
    return json({ success: false, error: 'Please choose at least one day and one time of day.' }, 400);
  }
  await db.setMhIntakeVisitRequest(env.DB, intake.id, request);
  return json({ success: true });
}

// ---------------------------------------------------------------- Providers

export async function handleMhIntakeAdmin(request, env, url) {
  if (!(await tokens.isAdminRequest(request, env))) return json({ success: false, error: 'Unauthorized' }, 401);

  if (url.pathname === '/admin/api/mh-intakes' && request.method === 'GET') {
    const rows = await db.listMhIntakes(env.DB);
    return json({
      success: true,
      intakes: rows.map((r) => ({ ...r, alerts_sent: parse(r.alerts_sent, []), visit_request: parse(r.visit_request, null) })),
    });
  }

  const match = url.pathname.match(/^\/admin\/api\/mh-intakes\/(MH-[A-Z0-9]+)(\/review)?$/);
  if (!match) return json({ success: false, error: 'Not found' }, 404);
  const publicId = match[1];

  if (match[2] && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    await db.setMhIntakeReviewed(env.DB, publicId, { reviewed: !!body.reviewed, note: String(body.note || '').slice(0, 5000) });
    return json({ success: true });
  }

  if (!match[2] && request.method === 'GET') {
    const row = await db.getMhIntakeByPublicId(env.DB, publicId);
    if (!row) return json({ success: false, error: 'Not found' }, 404);
    const answers = parse(row.answers, {});
    return json({
      success: true,
      intake: {
        publicId: row.public_id,
        status: row.status,
        outcome: row.outcome,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        reviewNote: row.review_note,
        alertsSent: parse(row.alerts_sent, []),
        visitRequest: parse(row.visit_request, null),
        changeLog: parse(row.change_log, []).map((c) => ({ ...c, question: QUESTION_BY_ID[c.id]?.prompt || c.id })),
        // An in-progress intake has no frozen evaluation yet; show the rules
        // as they stand so an alerted provider sees the same picture.
        evaluation: parse(row.evaluation, null) || evaluate(answers),
        transcript: answerTranscript(answers),
      },
    });
  }
  return json({ success: false, error: 'Method not allowed' }, 405);
}
