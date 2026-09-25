import { generateDocx, generatePhysicianDocx, generateNpPaIntakeDocx } from './docx-generator.js';
import * as db from './db.js';
import * as tokens from './tokens.js';
import * as stripeHelpers from './stripe-helpers.js';
import { handlePlatformWebhook, handleConnectWebhook } from './stripe-webhook.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/np-pa-submit') {
      return handleNpPaSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/np-pa-intake-step1') {
      return handleNpPaIntakeStep1(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/np-pa-intake-step2') {
      return handleNpPaIntakeStep2(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/physician-submit') {
      return handlePhysicianSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/physician-licensure-submit') {
      return handlePhysicianLicensureSubmit(request, env);
    }

    // The compliance pages are also handed to providers as a saved file, so
    // these two answer cross-origin as well as same-origin.
    if (
      url.pathname === '/compliance-submit' ||
      url.pathname === '/np-compliance-submit' ||
      url.pathname === '/physician-survey-submit'
    ) {
      if (request.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }));
      }
      if (request.method === 'POST') {
        const handlers = {
          '/compliance-submit': handleComplianceSubmit,
          '/np-compliance-submit': handleNpComplianceSubmit,
          '/physician-survey-submit': handlePhysicianSurveySubmit,
        };
        return withCors(await handlers[url.pathname](request, env));
      }
    }

    if (request.method === 'POST' && url.pathname === '/send-licensure-email') {
      return handleSendLicensureEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/resend-webhook') {
      return handleResendWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/stripe-webhook') {
      return handlePlatformWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/stripe-webhook-connect') {
      return handleConnectWebhook(request, env);
    }

    if (url.pathname === '/admin/login' && request.method === 'POST') {
      return handleAdminLogin(request, env);
    }

    if (url.pathname.startsWith('/admin/api/')) {
      return handleAdminApi(request, env, url);
    }

    if (url.pathname === '/physician-onboard/start') {
      return handlePhysicianOnboardStart(request, env, url);
    }

    if (url.pathname === '/physician-onboard/complete') {
      return handlePhysicianOnboardComplete(request, env, url);
    }

    if (url.pathname === '/client/add-bank/start') {
      return handleClientAddBankStart(request, env, url);
    }

    if (url.pathname === '/client/add-bank/complete') {
      return handleClientAddBankComplete(request, env, url);
    }

    // Serve static assets for all other requests
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    const now = new Date(event.scheduledTime);

    // Runs on every firing, not just the daily one. It is idempotent -- a month
    // already billed is claimed and skipped -- so an extra tick costs a query, and
    // a missed daily tick is covered by the next firing of anything.
    const billed = await runCollaborationBilling(env, easternDateString(now));
    if (billed.length) console.log('Collaboration billing:', JSON.stringify(billed));

    // Drafted rather than sent, so it can go out from a person's own address.
    // Wrapped because a Stripe outage should not also stop the billing tick above
    // from having counted, nor stop the compliance reminders below from running.
    try {
      const nudged = await runPaymentNudges(env, now);
      if (nudged.length) console.log('Payment reminder drafts:', JSON.stringify(nudged));
    } catch (err) {
      console.error('Payment reminder drafts failed:', err?.message || String(err));
    }

    const { weekday, day, hour, monthLabel } = easternParts(now);
    const proceeding = isFourthMondayAt9amEastern(now);
    // Logged on every firing, not just the ones that send. A schedule pointed at
    // the wrong day then shows up here the same week, rather than as an email
    // nobody received a month later.
    console.log(
      'Compliance reminder tick:',
      JSON.stringify({ eastern: `${weekday} ${day} ${hour}:00`, monthLabel, proceeding })
    );
    if (!proceeding) return;
    const result = await sendMonthlyComplianceReminders(env, now);
    console.log('Monthly compliance reminders:', JSON.stringify(result));
  },
};

// Stores a pairing that is not billed through the platform so the schedule
// reaches it every month, the same as a collaboration.
async function handleSaveReminderPairing(request, env) {
  try {
    const body = await request.json();
    const fields = {
      physicianName: String(body.physicianName || '').trim(),
      physicianEmail: String(body.physicianEmail || '').trim(),
      providerName: String(body.providerName || '').trim(),
      providerEmail: String(body.providerEmail || '').trim(),
    };
    if (Object.values(fields).some((v) => !v)) {
      return jsonResponse({ success: false, error: 'All four fields are required' }, 400);
    }

    const existing = await db.listReminderPairings(env.DB);
    const duplicate = existing.some(
      (r) =>
        r.physician_email.toLowerCase() === fields.physicianEmail.toLowerCase() &&
        r.provider_email.toLowerCase() === fields.providerEmail.toLowerCase()
    );
    if (duplicate) {
      return jsonResponse({ success: false, error: 'That pairing is already saved' }, 409);
    }

    const row = await db.createReminderPairing(env.DB, fields);
    return jsonResponse({ success: true, pairing: row });
  } catch (err) {
    console.error('Save reminder pairing error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// Sends only the pairings the admin selected, so the first run can be checked by
// hand before the schedule is trusted to pick recipients on its own.
async function handleSendComplianceReminders(request, env) {
  try {
    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const { pairings, monthLabel } = await request.json();
    if (!Array.isArray(pairings) || pairings.length === 0) {
      return jsonResponse({ success: false, error: 'No recipients selected' }, 400);
    }

    const now = new Date();
    const label = monthLabel || easternParts(now).monthLabel;
    const period = easternPeriod(now);
    const report = [];
    for (const pairing of pairings) {
      const results = await sendPairingReminders(env, pairing, label);
      await logPairingSend(env, period, pairing, results.filter((r) => r.ok).length, 'manual');
      report.push({
        physicianName: pairing.physicianName,
        providerName: pairing.providerName,
        results,
      });
    }

    const sent = report.reduce((n, r) => n + r.results.filter((x) => x.ok).length, 0);
    const failed = report.reduce((n, r) => n + r.results.filter((x) => !x.ok).length, 0);
    console.log('Manual compliance reminders:', JSON.stringify({ label, sent, failed }));
    return jsonResponse({ success: true, monthLabel: label, sent, failed, report });
  } catch (err) {
    console.error('Manual compliance reminder error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// ---- Monthly compliance reminders ----

const EASTERN_TZ = 'America/New_York';

function easternParts(date) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  });
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  return {
    weekday: parts.weekday,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    monthLabel: `${parts.month} ${parts.year}`,
  };
}

// The cron fires every Monday at both 13:00 and 14:00 UTC so that one of them is
// always 9am in New York, on either side of daylight saving. The 4th Monday is
// the only Monday that can land between the 22nd and the 28th.
function isFourthMondayAt9amEastern(date) {
  const { weekday, day, hour } = easternParts(date);
  return weekday === 'Mon' && day >= 22 && day <= 28 && hour === 9;
}

// The log is keyed by calendar month in New York, which is the unit the
// reminder is described in ("your August review").
function easternPeriod(date) {
  return easternDateISO(date).slice(0, 7);
}

function easternDateISO(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function firstName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return parts[0] || 'there';
}

// Physician records carry credentials, with or without a comma ("Jane Smith, MD",
// "Ana Maria Ruiz DO"), and a plain last-word split would greet them as "Dr. MD".
// Returns '' when no usable surname is left, so the caller can fall back.
const CREDENTIAL = /^(MD|DO|NP|PA|PA-C|DNP|PHD|PSYD|FNP|FNP-C|APRN|RN|MPH|MBA|FAAP|FACP|JR|SR|I{1,3})\.?$/i;

function physicianSurname(fullName) {
  const parts = String(fullName || '').replace(/,.*$/, '').trim().split(/\s+/).filter(Boolean);
  while (parts.length && CREDENTIAL.test(parts[parts.length - 1])) parts.pop();
  return parts.length ? parts[parts.length - 1] : '';
}

// The compliance obligation follows the clinical collaboration, not the billing
// arrangement: a promotional collaboration invoiced by hand never reaches
// status 'active', so gate on having started and not having been cancelled.
function isDueForReminder(collaboration, today) {
  if (collaboration.reminders_muted) return false;
  if (collaboration.status === 'canceled') return false;
  if (!collaboration.start_date) return true;
  return collaboration.start_date <= today;
}

function reminderEmail({ greeting, counterpartLine, formUrl, monthLabel }) {
  return `
<div style="max-width:600px;margin:0 auto;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e2530">
  <p>${greeting}</p>
  <p>It's time for your ${esc(monthLabel)} collaboration compliance review. ${counterpartLine}</p>
  <p style="margin:24px 0">
    <a href="${formUrl}" style="background:#1a3a5c;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;display:inline-block">Complete your ${esc(monthLabel)} review</a>
  </p>
  <p style="font-size:13px;color:#555">The form takes about two minutes. If the button doesn't work, paste this into your browser:<br>
    <a href="${formUrl}" style="color:#1B6CA8">${formUrl}</a>
  </p>
  <p>Warm regards,<br>MD-Match</p>
</div>`;
}

// One pairing, in the shape both the scheduled run and the manual admin tool use.
function pairingFromCollaboration(c, today) {
  return {
    collaborationId: c.id,
    physicianName: c.physician_name,
    physicianEmail: c.physician_email,
    providerName: c.client_name,
    providerEmail: c.client_email,
    status: c.status,
    startDate: c.start_date,
    muted: !!c.reminders_muted,
    due: isDueForReminder(c, today),
  };
}

// A saved pairing and a collaboration can describe the same two people, so key
// on the pair of addresses and let the collaboration win — it carries a status
// and a start date the saved row does not.
function pairingKey(pairing) {
  return `${String(pairing.physicianEmail || '').toLowerCase()}|${String(pairing.providerEmail || '').toLowerCase()}`;
}

async function listCompliancePairings(env, now) {
  const today = easternDateISO(now);
  const period = easternPeriod(now);
  const sends = await db.listReminderSends(env.DB, period);
  const sentAt = new Map(sends.map((r) => [r.pairing_key, r.sent_at]));

  // Bounces from this month, newest first, keyed by address. A reminder Resend
  // accepted can still have failed at the recipient's server afterwards.
  const bounces = await db.listEmailBouncesSince(env.DB, `${period}-01`);
  const bounceFor = new Map();
  for (const b of bounces) {
    if (!bounceFor.has(b.recipient)) bounceFor.set(b.recipient, { at: b.occurred_at, reason: b.reason });
  }
  const bounceOf = (email) => bounceFor.get(String(email || '').toLowerCase()) || null;
  const collaborations = await db.listCollaborations(env.DB);
  const pairings = collaborations.map((c) => ({ source: 'collaboration', ...pairingFromCollaboration(c, today) }));
  const seen = new Set(pairings.map(pairingKey));

  for (const row of await db.listReminderPairings(env.DB)) {
    const pairing = {
      source: 'saved',
      reminderPairingId: row.id,
      physicianName: row.physician_name,
      physicianEmail: row.physician_email,
      providerName: row.provider_name,
      providerEmail: row.provider_email,
      status: null,
      startDate: null,
      due: true,
    };
    if (seen.has(pairingKey(pairing))) continue;
    seen.add(pairingKey(pairing));
    pairings.push(pairing);
  }

  return pairings.map((p) => ({
    ...p,
    alreadySentAt: sentAt.get(pairingKey(p)) || null,
    physicianBounce: bounceOf(p.physicianEmail),
    providerBounce: bounceOf(p.providerEmail),
  }));
}

// Sends both halves of one pairing. Returns a result per message so the caller
// can report exactly who was reached.
async function sendPairingReminders(env, pairing, monthLabel) {
  const physicianLast = physicianSurname(pairing.physicianName);
  const providerFirst = firstName(pairing.providerName);
  const subject = `Monthly compliance review — ${monthLabel}`;

  const messages = [
    {
      role: 'physician',
      to: pairing.physicianEmail,
      html: reminderEmail({
        greeting: physicianLast ? `Hi Dr. ${esc(physicianLast)},` : 'Hello,',
        counterpartLine: `This one covers your collaboration with ${esc(pairing.providerName)}.`,
        formUrl: 'https://md-match.com/md-compliance-intake',
        monthLabel,
      }),
    },
    {
      role: 'provider',
      to: pairing.providerEmail,
      html: reminderEmail({
        greeting: `Hi ${esc(providerFirst)},`,
        counterpartLine: physicianLast
          ? `This one covers your collaboration with Dr. ${esc(physicianLast)}.`
          : `This one covers your collaboration with ${esc(pairing.physicianName)}.`,
        formUrl: 'https://md-match.com/np-compliance-intake',
        monthLabel,
      }),
    },
  ];

  const results = [];
  for (const message of messages) {
    if (!message.to) {
      results.push({ role: message.role, to: null, ok: false, reason: 'missing_email' });
      continue;
    }
    const ok = await sendEmail(env, {
      from: 'MD-Match <noreply@md-match.com>',
      to: [message.to],
      subject,
      html: message.html,
      // A reminder invites questions, so send them somewhere a person reads.
      replyTo: 'philipwasef@md-match.com',
    });
    results.push({ role: message.role, to: message.to, ok });
  }
  return results;
}

async function sendMonthlyComplianceReminders(env, now) {
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY secret is not set; skipping compliance reminders');
    return { error: 'missing_api_key' };
  }

  const { monthLabel } = easternParts(now);
  const period = easternPeriod(now);
  const pairings = await listCompliancePairings(env, now);
  const due = pairings.filter((p) => p.due);
  // Anything already logged for this month has had its reminder, whether from an
  // earlier firing or from a manual send.
  const toSend = due.filter((p) => !p.alreadySentAt);

  let sent = 0;
  const failures = [];
  for (const pairing of toSend) {
    const results = await sendPairingReminders(env, pairing, monthLabel);
    const ok = results.filter((r) => r.ok).length;
    sent += ok;
    for (const result of results) if (!result.ok) failures.push({ collaboration: pairing.collaborationId, ...result });
    await logPairingSend(env, period, pairing, ok, 'scheduled');
  }

  return {
    monthLabel,
    pairings: pairings.length,
    due: due.length,
    skippedAlreadySent: due.length - toSend.length,
    sent,
    failed: failures.length,
    failures,
  };
}

// Never let a logging failure look like a send failure, but say so loudly: an
// unlogged send is one that could go out again.
async function logPairingSend(env, period, pairing, emailsSent, trigger) {
  try {
    await db.recordReminderSend(env.DB, {
      period,
      pairingKey: pairingKey(pairing),
      physicianEmail: pairing.physicianEmail,
      providerEmail: pairing.providerEmail,
      emailsSent,
      trigger,
    });
  } catch (err) {
    console.error('Failed to log reminder send:', pairingKey(pairing), err?.message || err);
  }
}

async function handleNpPaSubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) {
      // Merge multi-value fields (checkboxes) with comma separation
      if (key in fields) {
        fields[key] = fields[key] + ', ' + value;
      } else {
        fields[key] = value;
      }
    }

    // Normalize field names from form to friendly display names
    const patientSettingMap = {
      'in-person': 'In-Person Only',
      'virtual': 'Telehealth / Virtual Only',
      'both': 'Both In-Person & Virtual',
    };
    const practiceSettingMap = {
      'private-solo': 'Private Practice — Solo',
      'private-group': 'Private Practice — Group',
      'community': 'Community Mental Health',
      'integrated': 'Integrated Primary Care',
      'telehealth-platform': 'Telehealth Platform',
      'hospital': 'Hospital / Health System',
      'other-setting': 'Other',
    };
    const tmsMap = {
      'yes-current': 'Yes — currently offering',
      'yes-planned': 'Yes — planning to offer',
      'no': 'No',
    };
    const providerTypeMap = { 'np': 'Nurse Practitioner (NP / APRN)', 'pa': 'Physician Assistant (PA)' };

    const whyReasonMap = {
      'new-practice': 'Opening a new private practice',
      'joining-group': 'Joining a group practice',
      'switching': 'Switching collaborating physicians',
      'adding': 'Adding a collaborator (expanding)',
      'first-time': 'First time ever — new to practice',
      'other': 'Other',
    };

    const f = {
      'Full Name': [fields['First Name'], fields['Last Name']].filter(Boolean).join(' ') || '—',
      'Email': fields['Professional Email'] || '—',
      'Phone': fields['Phone Number'] || '—',
      'Provider Type': providerTypeMap[fields['Provider Type']] || fields['Provider Type'] || '—',
      'Specialty': fields['Specialty / Certification'] || '—',
      'Medical Degree': fields['Highest Degree Earned'] || '—',
      'Years of Clinical Experience': fields['Years of Clinical Experience'] || '—',
      'Years of Psychiatry Experience': fields['Years of Psychiatry-Specific Experience'] || '—',
      'Why Seeking Collaboration': whyReasonMap[fields['whyReason']] || fields['whyReason'] || '—',
      'Why Switching Details': fields['Why Switching'] || '',
      'Other Reason Details': fields['Other Reason'] || '',
      'States Needing Collaboration': fields['States Needing Collaboration'] || '—',
      'DEA States': fields['DEA States'] || 'None specified',
      'Patient Setting': patientSettingMap[fields['patientSetting']] || fields['patientSetting'] || '—',
      'Practice Setting': practiceSettingMap[fields['practiceSetting']] || fields['practiceSetting'] || '—',
      'Patient Population': fields['Patient Population'] || '—',
      'Weekly Hours': fields['Weekly Hours'] || '—',
      'Controlled Substances': fields['controlled'] === 'no' ? 'No' : fields['controlled'] === 'unsure' ? 'Unsure / Not yet' : 'Yes',
      'Controlled Substance Schedule': fields['controlled_substance_scope'] || '—',
      'MAT Services': fields['mat_services'] || '—',
      'Interventional Route': fields['interventional_route'] || '—',
      'Interventional Practice Notes': fields['Interventional Practice Notes'] || '',
      'TMS': tmsMap[fields['tms']] || fields['tms'] || '—',
      'TMS Program Details': fields['TMS Program Details'] || '',
      'Board Action': fields['boardAction'] === 'yes' ? 'Yes' : 'No',
      'Board Action Details': fields['Board Action Details'] || '',
      'License Suspension': fields['licenseSuspension'] === 'yes' ? 'Yes' : 'No',
      'License Suspension Details': fields['License Suspension Details'] || '',
      'DEA Action': fields['deaAction'] === 'yes' ? 'Yes' : 'No',
      'DEA Action Details': fields['DEA Action Details'] || '',
      'Malpractice': fields['malpractice'] === 'yes' ? 'Yes' : 'No',
      'Malpractice Details': fields['Malpractice Details'] || '',
      'Practice Site Address': fields['Practice Site Address'] || '',
      'Ideal Start Date': formatDate(fields['Ideal Start Date']),
      'First Patient Timeline': fields['First Patient Timeline'] || '—',
      'Additional Information': fields['Anything Else We Should Know'] || '—',
      'How Did You Hear About MD-Match': fields['How Did You Hear About MD-Match'] || '—',
      'Referred By': fields['Referred By'] || '',
    };

    const providerName = f['Full Name'] !== '—' ? f['Full Name'] : 'Unknown';

    // Persist a client record for admin matching (non-fatal if it fails)
    try {
      if (f['Email'] !== '—') {
        const existing = await db.getClientByEmail(env.DB, f['Email']);
        if (!existing) {
          await db.createClient(env.DB, { fullName: providerName, email: f['Email'], phone: f['Phone'] !== '—' ? f['Phone'] : null });
        }
      }
    } catch (dbErr) {
      console.error('DB error saving client:', dbErr?.message || dbErr);
    }

    // Generate Word document
    let docxResult;
    try {
      docxResult = await generateDocx(f);
    } catch (docxErr) {
      console.error('DOCX generation error:', docxErr?.message || docxErr);
      return jsonResponse({ success: false, error: 'Document generation failed' }, 500);
    }
    const base64Docx = docxResult.base64;
    const filename = `NP-PA-Profile-${providerName.replace(/[^a-zA-Z0-9]/g, '-')}.docx`;

    // Build plain-text summary for email body
    const summary = buildSummary(f);

    // Send via Resend
    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY secret is not set');
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    const resendPayload = {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
      reply_to: f['Email'] !== '—' ? f['Email'] : undefined,
      subject: `New NP/PA Application — ${providerName}`,
      html: summary,
      attachments: [{ filename, content: base64Docx }],
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error status:', resendRes.status, 'body:', errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed', detail: errBody }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handlePhysicianSubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key in fields) {
        fields[key] = fields[key] + ', ' + value;
      } else {
        fields[key] = value;
      }
    }

    const comfortMap = { yes: 'Yes', no: 'No', case: 'Case-by-case' };
    const yesNoMap = { yes: 'Yes', no: 'No' };

    const f = {
      'Full Name': [fields['First Name'], fields['Last Name']].filter(Boolean).join(' ') || '—',
      'Email': fields['Professional Email'] || '—',
      'Phone': fields['Phone Number'] || '—',
      'Medical Degree': fields['Medical Degree'] || '—',
      'Specialty': fields['Specialty'] || '—',
      'Board Certification Status': fields['Board Certification Status'] || '—',
      'NPI Number': fields['NPI Number'] || '—',
      'Years in Practice': fields['Years in Practice'] || '—',
      'State of Residence': fields['State of Residence'] || '—',
      'Licensed States': fields['licensed_states'] || '—',
      'Collab States': fields['collab_states'] || '—',
      'DEA States': fields['dea_states'] || 'None specified',
      'Willing to Get Additional Licenses': comfortMap[fields['willGetLicense']] || fields['willGetLicense'] || '—',
      'Willing to Get Additional DEAs': comfortMap[fields['willGetDEA']] || fields['willGetDEA'] || '—',
      'Controlled Substances Comfort': comfortMap[fields['controlledSub']] || fields['controlledSub'] || '—',
      'Schedule II Signoff': comfortMap[fields['scheduleIISignoff']] || fields['scheduleIISignoff'] || '—',
      'IV Ketamine Comfort': comfortMap[fields['ketamineIV']] || fields['ketamineIV'] || '—',
      'IM Ketamine Comfort': comfortMap[fields['ketamineIM']] || fields['ketamineIM'] || '—',
      'Intranasal Esketamine Comfort': comfortMap[fields['ketamineIN']] || fields['ketamineIN'] || '—',
      'TMS Comfort': comfortMap[fields['tms']] || fields['tms'] || '—',
      'Credentialing Willingness': comfortMap[fields['credentialing']] || fields['credentialing'] || '—',
      'Collaboration Modalities': fields['modalities'] || 'None selected',
      'Medical Director Roles': yesNoMap[fields['medicalDirector']] || fields['medicalDirector'] || '—',
      'Physician-Owned Arrangements': yesNoMap[fields['physicianOwned']] || fields['physicianOwned'] || '—',
      'Insurance Credentialing': fields['Insurance Credentialing'] || '—',
      'Mental Health Collaboration Experience': fields['Mental Health Collaboration Experience'] || '—',
      'Board Action': yesNoMap[fields['boardAction']] || 'No',
      'Board Action Details': fields['Board Action Details'] || '',
      'License Suspension': yesNoMap[fields['licenseSuspension']] || 'No',
      'License Suspension Details': fields['License Suspension Details'] || '',
      'DEA Action': yesNoMap[fields['deaAction']] || 'No',
      'DEA Action Details': fields['DEA Action Details'] || '',
      'Malpractice': yesNoMap[fields['malpractice']] || 'No',
      'Malpractice Details': fields['Malpractice Details'] || '',
      'How Did You Hear About MD-Match': fields['How Did You Hear About MD-Match'] || '—',
    };

    const providerName = f['Full Name'] !== '—' ? f['Full Name'] : 'Unknown';

    // Persist a physician record for admin matching (non-fatal if it fails)
    try {
      if (f['Email'] !== '—') {
        const existing = await db.getPhysicianByEmail(env.DB, f['Email']);
        if (!existing) {
          await db.createPhysician(env.DB, { fullName: providerName, email: f['Email'], phone: f['Phone'] !== '—' ? f['Phone'] : null });
        }
      }
    } catch (dbErr) {
      console.error('DB error saving physician:', dbErr?.message || dbErr);
    }

    let docxResult;
    try {
      docxResult = await generatePhysicianDocx(f);
    } catch (docxErr) {
      console.error('DOCX generation error:', docxErr?.message || docxErr);
      return jsonResponse({ success: false, error: 'Document generation failed' }, 500);
    }
    const base64Docx = docxResult.base64;
    const filename = `Physician-Profile-${providerName.replace(/[^a-zA-Z0-9]/g, '-')}.docx`;

    const summary = buildPhysicianSummary(f);

    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY secret is not set');
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    const resendPayload = {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
      reply_to: f['Email'] !== '—' ? f['Email'] : undefined,
      subject: `New Physician Application — ${providerName}`,
      html: summary,
      attachments: [{ filename, content: base64Docx }],
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error status:', resendRes.status, 'body:', errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed', detail: errBody }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handleSendLicensureEmail(request, env) {
  try {
    const { first, last, email } = await request.json();
    if (!email) return jsonResponse({ success: false, error: 'Missing email' }, 400);
    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const lastName = last || '';
    const salutation = lastName ? `Dr. ${lastName}` : 'Doctor';

    const html = `
<div style="max-width:600px;margin:0 auto;font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a3333">
  <p>Dear ${salutation},</p>
  <p>As we begin matching NPs and PAs with collaborating physicians, we want to make sure we have your most up-to-date information on file. Unfortunately, a technical issue with our original intake form prevented all 50 states from loading correctly, which may have limited your selections.</p>
  <p>Could you take just one minute to complete this quick form with your current states of licensure, collaboration availability, and DEA registration?</p>
  <p><a href="https://md-match.com/physician-licensure.html" style="color:#1a6b6b;font-weight:700">https://md-match.com/physician-licensure.html</a></p>
  <p>We appreciate your time and are looking forward to making several successful matches with you soon.</p>
  <p>Warm regards,<br><strong>Philip Wasef, MD</strong><br>MD-Match</p>
</div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Philip Wasef, MD <philipwasef@md-match.com>',
        to: [email],
        subject: 'Quick Update — State Licensure & Availability',
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', res.status, err);
      return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);
    }
    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handlePhysicianLicensureSubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) fields[key] = value;

    const name = [fields['First Name'], fields['Last Name']].filter(Boolean).join(' ') || 'Unknown';

    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const row = (label, val) =>
      `<tr><td style="padding:6px 12px;font-weight:600;color:#1e2530;background:#f2f4f6;width:38%;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${label}</td><td style="padding:6px 12px;color:#1e2530;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${val || '—'}</td></tr>`;
    const section = (title) =>
      `<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">${title}</td></tr>`;

    const html = `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">Physician Licensure — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${section('Contact')}
    ${row('Full Name', name)}
    ${row('Email', fields['Professional Email'] || '—')}
    ${row('Phone', fields['Phone Number'] || '—')}
    ${row('State of Residence', fields['State of Residence'] || '—')}
    ${section('Licensure & Collaboration')}
    ${row('Licensed States', fields['licensed_states'] || '—')}
    ${row('Available to Collaborate', fields['collab_states'] || '—')}
    ${row('DEA States', fields['dea_states'] || 'None')}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">MD-Match.com</p>
</div>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MD-Match Intake <noreply@md-match.com>',
        to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
        reply_to: fields['Professional Email'] || undefined,
        subject: `Physician Licensure Submission — ${name}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error:', resendRes.status, errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handleComplianceSubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) fields[key] = value;

    const name = fields['Physician_Name'] || 'Unknown';
    const month = formatMonth(fields['Submission_Month']);

    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const html = `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">Monthly Compliance Review — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${emailSection('Physician Information')}
    ${emailRow('Physician Name', name)}
    ${emailRow('NPI Number', fields['Physician_NPI'])}
    ${emailRow('Collaborator Name', fields['Collaborator_Name'])}
    ${emailRow('Submission Month', month)}
    ${emailSection('Collaboration')}
    ${emailRow('Collaboration State(s)', fields['Q1_States'])}
    ${emailRow('Patients Seen This Month', fields['Q2_PatientsSeen'])}
    ${followUp(fields['Q2_PatientsSeen'], '', emailRow('Why Not', fields['Q2_WhyNot']))}
    ${emailRow('Check-In This Month', fields['Q3_CheckIn'])}
    ${followUp(fields['Q3_CheckIn'], emailRow('Date of Meeting', formatDate(fields['Q3_MeetingDate'])), emailRow('Why Not', fields['Q3_WhyNot']))}
    ${emailSection('Quality Assurance')}
    ${emailRow('QA Occurred This Month', fields['Q4_QA'])}
    ${followUp(fields['Q4_QA'], emailRow('QA Activities', fields['Q4_QA_Items_Selected']), emailRow('Why Not', fields['Q4_WhyNot']))}
    ${emailSection('Chart Review')}
    ${emailRow('Charts Reviewed This Month', fields['Q5_ChartReview'])}
    ${followUp(fields['Q5_ChartReview'], emailRow('Number of Charts', fields['Q5_ChartCount']), emailRow('Why Not', fields['Q5_WhyNot']))}
    ${emailSection('Attestation')}
    ${emailRow('Attested', fields['Attestation'] ? 'Yes' : 'No')}
    ${emailRow('Digital Signature', fields['Digital_Signature'])}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">MD-Match.com</p>
</div>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MD-Match Intake <noreply@md-match.com>',
        to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
        subject: `Monthly Compliance Review — ${name}${month !== '—' ? ` (${month})` : ''}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error:', resendRes.status, errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handleNpComplianceSubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) fields[key] = value;

    const name = fields['Provider_Name'] || 'Unknown';
    const month = formatMonth(fields['Submission_Month']);

    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const html = `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">Monthly Compliance Review (NP/PA) — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${emailSection('Provider Information')}
    ${emailRow('Provider Name', name)}
    ${emailRow('NPI Number', fields['Provider_NPI'])}
    ${emailRow('Collaborating Physician', fields['Collaborating_Physician'])}
    ${emailRow('Submission Month', month)}
    ${emailSection('Collaboration')}
    ${emailRow('Collaboration State(s)', fields['Q1_States'])}
    ${emailRow('Patients Seen This Month', fields['Q2_PatientsSeen'])}
    ${followUp(fields['Q2_PatientsSeen'], emailRow('Estimated Patients Seen', fields['Q2_PatientCount']), emailRow('Why Not', fields['Q2_WhyNot']))}
    ${emailRow('Check-In With Physician', fields['Q3_CheckIn'])}
    ${followUp(fields['Q3_CheckIn'], emailRow('Date of Meeting', formatDate(fields['Q3_MeetingDate'])), emailRow('Why Not', fields['Q3_WhyNot']))}
    ${emailSection('Quality Assurance')}
    ${emailRow('QA Occurred This Month', fields['Q4_QA'])}
    ${followUp(fields['Q4_QA'], emailRow('QA Activities', fields['Q4_QA_Items_Selected']), emailRow('Why Not', fields['Q4_WhyNot']))}
    ${emailSection('Chart Review')}
    ${emailRow('Charts Provided for Review', fields['Q5_ChartReview'])}
    ${followUp(fields['Q5_ChartReview'], emailRow('Number of Charts', fields['Q5_ChartCount']), emailRow('Why Not', fields['Q5_WhyNot']))}
    ${emailRow('Chart Log Kept', fields['Q6_ChartLog'])}
    ${fields['Q6_ChartLog'] === 'No' ? emailRow('Why Not', fields['Q6_WhyNot']) : ''}
    ${emailSection('Attestation')}
    ${emailRow('Attested', fields['Attestation'] ? 'Yes' : 'No')}
    ${emailRow('Digital Signature', fields['Digital_Signature'])}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">MD-Match.com</p>
</div>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MD-Match Intake <noreply@md-match.com>',
        to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
        subject: `Monthly Compliance Review (NP/PA) — ${name}${month !== '—' ? ` (${month})` : ''}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error:', resendRes.status, errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// ---- Compliance email helpers ----

function esc(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function emailRow(label, val) {
  return `<tr><td style="padding:6px 12px;font-weight:600;color:#1e2530;background:#f2f4f6;width:38%;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${label}</td><td style="padding:6px 12px;color:#1e2530;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${esc(val) || '—'}</td></tr>`;
}

function emailSection(title) {
  return `<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">${title}</td></tr>`;
}

// Only report the follow-up that matches the answer given — collapsed sub-fields
// still submit whatever was typed before the answer changed.
function followUp(answer, yes, no) {
  return answer === 'Yes' ? yes : answer === 'No' ? no : '';
}

// ---- Physician interest and experience survey ----

// Invites one physician to the survey. Behind the admin gate: it sends mail as
// philipwasef@md-match.com to an address of the caller's choosing, which is not
// something an anonymous request should be able to do.
async function handleSendSurveyEmail(request, env) {
  try {
    const { first, last, email } = await request.json();
    if (!email) return jsonResponse({ success: false, error: 'Missing email' }, 400);
    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const surname = physicianSurname([first, last].filter(Boolean).join(' '));
    const salutation = surname ? `Dr. ${esc(surname)}` : 'Doctor';
    const link = 'https://md-match.com/physician-survey';

    const html = `
<div style="max-width:600px;margin:0 auto;font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a3333">
  <p>Hi ${salutation},</p>
  <p>We're expanding the kinds of opportunities we bring to physicians in the MD-Match network — medical director roles and physician-owned arrangements alongside the collaborations you already know us for.</p>
  <p>To match you with the right ones, it helps to know two things: what you're open to, and which clinical areas you practice in or have supervised.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#0b3535;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;display:inline-block">Take the two-minute survey</a>
  </p>
  <p style="font-size:13px;color:#4a6b6b">Twelve questions, most of them yes or no. The only thing we ask you to type is your name — we already have everything else on file. If the button doesn't work, paste this into your browser:<br>
    <a href="${link}" style="color:#1a6b6b">${link}</a>
  </p>
  <p>No obligation attached to any answer. Saying you're open to something just means we'll bring you the opportunity when it comes up.</p>
  <p>Thank you,<br><strong>Philip Wasef, MD</strong><br>MD-Match</p>
</div>`;

    const ok = await sendEmail(env, {
      from: 'Philip Wasef, MD <philipwasef@md-match.com>',
      to: [email],
      subject: "Quick question about the work you're open to",
      html,
    });
    if (!ok) return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Survey invite error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// Sent to physicians already on file, so it asks for a name and nothing else
// that a previous intake already captured.
const SURVEY_AREAS = [
  ['Q4_HRT', 'Hormone Replacement Therapy (HRT)'],
  ['Q5_TRT', 'Testosterone Replacement Therapy (TRT)'],
  ['Q6_WeightLoss', 'Weight loss treatment'],
  ['Q7_Aesthetics', 'Aesthetic services'],
  ['Q8_IVHydration', 'IV hydration'],
  ['Q9_PeptideTherapy', 'Peptide therapy'],
  ['Q10_SexualHealth', "Sexual health / men's health"],
  ['Q11_FunctionalLongevity', 'Functional / longevity medicine'],
  ['Q12_RegenerativeMedicine', 'Regenerative medicine (PRP, stem cells)'],
];

async function handlePhysicianSurveySubmit(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) fields[key] = value;

    const name = fields['Physician_Name'] || 'Unknown';
    if (!env.RESEND_API_KEY) return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);

    const areas = SURVEY_AREAS.map(([key, label]) => emailRow(label, fields[key])).join('\n    ');
    const yesCount = SURVEY_AREAS.filter(([key]) => fields[key] === 'Yes').length;

    const html = `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">Physician Interest &amp; Experience Survey — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${emailSection('Physician')}
    ${emailRow('Name', name)}
    ${emailSection('Opportunities')}
    ${emailRow('Open to Medical Director Roles', fields['Q1_MedicalDirectorInterest'])}
    ${emailRow('Open to Physician-Owned Arrangements', fields['Q2_PhysicianOwnedInterest'])}
    ${emailRow('Current Medical Director Roles', fields['Q3_CurrentMedicalDirectorRoles'])}
    ${emailSection(`Clinical Areas — ${yesCount} of ${SURVEY_AREAS.length}`)}
    ${areas}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">MD-Match.com</p>
</div>`;

    const ok = await sendEmail(env, {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
      subject: `Physician Survey — ${name}`,
      html,
    });
    if (!ok) return jsonResponse({ success: false, error: 'Email delivery failed' }, 500);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Physician survey error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// ---- Resend webhook ----

// Resend signs with the Standard Webhooks scheme: HMAC-SHA256 over
// "<id>.<timestamp>.<body>", keyed by the secret's base64 body, sent as a
// space-separated list of "v1,<signature>". Headers arrive svix-prefixed or
// webhook-prefixed depending on the sender, so accept either.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function webhookHeader(request, name) {
  return request.headers.get(`svix-${name}`) || request.headers.get(`webhook-${name}`);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Length-independent compare, so a mismatch reveals nothing through timing.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyResendSignature(request, env, body) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 500, reason: 'RESEND_WEBHOOK_SECRET is not set' };

  const id = webhookHeader(request, 'id');
  const timestamp = webhookHeader(request, 'timestamp');
  const signatureHeader = webhookHeader(request, 'signature');
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, status: 400, reason: 'Missing signature headers' };
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, status: 400, reason: 'Timestamp outside tolerance' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = bytesToBase64(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  );

  // The header can carry several signatures during a secret rotation.
  const provided = signatureHeader.split(' ').map((part) => part.split(',')[1]).filter(Boolean);
  if (!provided.some((sig) => safeEqual(sig, expected))) {
    return { ok: false, status: 401, reason: 'Signature mismatch' };
  }
  return { ok: true };
}

async function handleResendWebhook(request, env) {
  try {
    const body = await request.text();
    const verified = await verifyResendSignature(request, env, body);
    if (!verified.ok) {
      console.error('Resend webhook rejected:', verified.reason);
      return jsonResponse({ success: false, error: verified.reason }, verified.status);
    }

    const event = JSON.parse(body);
    // Only the failures are stored. Deliveries and opens would be noise here,
    // and Resend's own dashboard already holds them.
    if (event.type !== 'email.bounced' && event.type !== 'email.complained') {
      return jsonResponse({ success: true, ignored: event.type });
    }

    const data = event.data || {};
    const recipients = Array.isArray(data.to) ? data.to : [data.to].filter(Boolean);
    const reason =
      data.bounce?.message || data.bounce?.subType || data.reason || (event.type === 'email.complained' ? 'Marked as spam' : null);
    const occurredAt = event.created_at || new Date().toISOString();

    for (const recipient of recipients) {
      await db.recordEmailBounce(env.DB, {
        eventType: event.type,
        emailId: data.email_id,
        recipient: String(recipient).toLowerCase(),
        subject: data.subject,
        reason,
        occurredAt,
      });
    }

    console.log('Resend webhook:', JSON.stringify({ type: event.type, recipients, reason }));
    return jsonResponse({ success: true });
  } catch (err) {
    console.error('Resend webhook error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// ---- Admin ----

async function handleAdminLogin(request, env) {
  try {
    const { password } = await request.json();
    if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
      return jsonResponse({ success: false, error: 'Invalid password' }, 401);
    }
    const cookie = await tokens.createAdminSessionCookie(env);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
    });
  } catch (err) {
    console.error('Admin login error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handleAdminApi(request, env, url) {
  if (!(await tokens.isAdminRequest(request, env))) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  if (url.pathname === '/admin/api/data' && request.method === 'GET') {
    const [clients, physicians, collaborations] = await Promise.all([
      db.listClients(env.DB),
      db.listPhysicians(env.DB),
      db.listCollaborations(env.DB),
    ]);
    return jsonResponse({ success: true, clients, physicians, collaborations });
  }

  if (url.pathname === '/admin/api/collaborations' && request.method === 'POST') {
    return handleCreateCollaboration(request, env);
  }

  if (url.pathname === '/admin/api/collaborations/activate' && request.method === 'POST') {
    return handleActivateCollaboration(request, env);
  }

  // What the scheduled handler would do today, and anything it failed at before.
  // Failed months stay claimed and stop that collaboration billing, so they need a
  // place a person actually looks.
  if (url.pathname === '/admin/api/billing/preview' && request.method === 'GET') {
    const today = easternDateString(new Date());
    const [due, failed] = await Promise.all([
      db.listCollaborationsDueForInvoice(env.DB, today),
      db.listFailedInvoiceRuns(env.DB),
    ]);
    return jsonResponse({ success: true, today, due, failed });
  }

  // The drafts for anything falling due tomorrow, without claiming them, so the
  // panel can show what is coming and the button below can still send it.
  if (url.pathname === '/admin/api/nudges/preview' && request.method === 'GET') {
    const nudges = await findPaymentNudges(env, new Date());
    return jsonResponse({
      success: true,
      nudges: nudges.map((n) => ({
        invoiceId: n.invoice.id, number: n.invoice.number,
        client: n.invoice.customer_name, email: n.invoice.customer_email,
        amount: n.amount, dueOn: n.dueOn, gmailUrl: n.gmailUrl, body: n.body,
      })),
    });
  }

  // Runs the sweep by hand. Safe to press: the same per-month claim that protects
  // the scheduled run protects this one, so pressing it twice bills nobody twice.
  if (url.pathname === '/admin/api/billing/run' && request.method === 'POST') {
    const results = await runCollaborationBilling(env, easternDateString(new Date()));
    return jsonResponse({ success: true, results });
  }

  // Releases a month that failed, so it can be attempted again. Deliberately
  // manual: only safe once somebody has confirmed in Stripe that the failed
  // attempt left no invoice behind.
  if (url.pathname === '/admin/api/billing/clear-failure' && request.method === 'POST') {
    const { collaborationId, period } = await request.json();
    if (!collaborationId || !period) {
      return jsonResponse({ success: false, error: 'Missing collaborationId or period' }, 400);
    }
    await db.clearInvoiceRun(env.DB, collaborationId, period);
    return jsonResponse({ success: true });
  }

  if (url.pathname === '/admin/api/collaborations/cancel' && request.method === 'POST') {
    return handleCancelCollaboration(request, env);
  }

  if (url.pathname === '/admin/api/collaborations/resend-onboarding' && request.method === 'POST') {
    return handleResendOnboarding(request, env);
  }

  if (url.pathname === '/admin/api/collaborations/resend-client-email' && request.method === 'POST') {
    return handleResendClientEmail(request, env);
  }

  if (url.pathname === '/admin/api/compliance-reminders/preview' && request.method === 'GET') {
    const now = new Date();
    const { monthLabel } = easternParts(now);
    return jsonResponse({ success: true, monthLabel, pairings: await listCompliancePairings(env, now) });
  }

  if (url.pathname === '/admin/api/compliance-reminders/send' && request.method === 'POST') {
    return handleSendComplianceReminders(request, env);
  }

  if (url.pathname === '/admin/api/survey-email' && request.method === 'POST') {
    return handleSendSurveyEmail(request, env);
  }

  if (url.pathname === '/admin/api/compliance-reminders/pairings' && request.method === 'POST') {
    return handleSaveReminderPairing(request, env);
  }

  if (url.pathname === '/admin/api/compliance-reminders/mute' && request.method === 'POST') {
    const { collaborationId, muted } = await request.json();
    if (!collaborationId) return jsonResponse({ success: false, error: 'Missing collaborationId' }, 400);
    await db.setCollaborationRemindersMuted(env.DB, collaborationId, muted);
    return jsonResponse({ success: true });
  }

  if (url.pathname === '/admin/api/compliance-reminders/pairings/remove' && request.method === 'POST') {
    const { id } = await request.json();
    if (!id) return jsonResponse({ success: false, error: 'Missing id' }, 400);
    await db.deactivateReminderPairing(env.DB, id);
    return jsonResponse({ success: true });
  }

  return jsonResponse({ success: false, error: 'Not found' }, 404);
}

// Shared by collaboration creation and the resend action. Reads the figures from
// the stored collaboration rather than the creation request, so a resend months
// later still describes the arrangement as it actually stands.
function usd(cents) {
  return '$' + (cents / 100).toFixed(2);
}

const RATE_RAIL = 'margin:0 0 16px;padding:2px 0 2px 14px;border-left:2px solid #d0d7d4';

async function sendClientBillingEmail(env, collaboration, client, physician) {
  const termsDays = collaboration.payment_terms_days || stripeHelpers.DEFAULT_PAYMENT_TERMS_DAYS;
  const standard = usd(collaboration.total_amount_cents);
  // A promotion is marked by its end date; the client's promotional figure is stored
  // separately from the physician's because the two move independently.
  const isPromo = !!collaboration.promo_end_date && collaboration.promo_total_cents != null;

  const scheduleHtml = isPromo
    ? `<div style="${RATE_RAIL}">`
      + `<p style="margin:0 0 4px">Until ${collaboration.promo_end_date}: <strong>${usd(collaboration.promo_total_cents)}</strong> / month</p>`
      + `<p style="margin:0">From ${collaboration.promo_end_date}: <strong>${standard}</strong> / month</p>`
      + `</div>`
      + `<p>There is nothing to set up. You'll receive an invoice by email each month with a secure link to pay by bank transfer, ${termsDays}-day terms. Nothing is ever charged automatically — you pay each invoice when you're ready.</p>`
    : `<p>There is nothing to set up. Starting ${collaboration.start_date}, you'll receive an invoice by email each month for <strong>${standard}</strong>, with a secure link to pay by bank transfer. Payment terms are ${termsDays} days.</p>`
      + `<p>Nothing is ever charged automatically — no card or bank details held on file, no surprise debits. You review each invoice and pay it when you're ready.</p>`;

  return sendEmail(env, {
    to: [client.email],
    from: 'MD-Match <noreply@md-match.com>',
    replyTo: 'philipwasef@md-match.com',
    subject: isPromo ? 'Your billing schedule' : 'How your monthly billing works',
    html: `<p>Hi ${client.full_name.split(' ')[0]},</p>`
      + `<p>A quick note on billing so you know what to expect.</p>`
      + scheduleHtml
      + `<p>Any questions, just reply here.</p>`
      + `<p>Best,<br>Philip</p>`,
  });
}

// Tells a physician that a new collaboration exists and what it pays.
//
// Nothing else in the app did this. The payout onboarding link was doubling as the
// announcement, so once it was suppressed for physicians who are already connected,
// they had no word at all -- they would have found out when money arrived.
//
// The wording turns on two things: whether this collaboration is promotional, and
// whether the physician's previous one was. What a physician needs told is the
// change, not the number. A rate below the one they are used to has to say so
// plainly; a rate identical to it is better off saying that nothing has changed
// than restating the arrangement as though it were news.
async function sendCollaborationNoticeEmail(env, { collaboration, client, physician, previous, alreadyOnboarded }) {
  const firstName = physician.full_name.split(' ')[0];
  const practice = client.full_name;
  // The provider is who the physician actually collaborates with; the client is who
  // pays. Rows created before provider_name existed have none, so fall back to
  // naming the practice alone rather than printing an empty phrase.
  const withWhom = collaboration.provider_name
    ? `${collaboration.provider_name} at ${practice}`
    : practice;
  const standardPayout = usd(collaboration.total_amount_cents - collaboration.platform_fee_cents);

  const newIsPromo = !!collaboration.promo_end_date;
  const prevIsPromo = !!(previous && previous.promo_end_date);
  const rail = 'margin:0 0 16px;padding:2px 0 2px 14px;border-left:2px solid #d0d7d4';

  let rateHtml;
  if (newIsPromo) {
    const rates =
      `<p style="margin:0 0 4px">Until ${collaboration.promo_end_date}: <strong>${usd(collaboration.promo_payout_cents)}</strong> per month</p>`
      + `<p style="margin:0">From ${collaboration.promo_end_date}: <strong>${standardPayout}</strong> per month</p>`;
    if (prevIsPromo) {
      rateHtml = `<p>This one also starts on an introductory rate, on its own timeline:</p>`
        + `<div style="${rail}">${rates}</div>`
        + `<p>That date is independent of your other collaboration — each one steps up to its full rate on its own schedule.</p>`;
    } else if (previous) {
      rateHtml = `<p>One difference from your existing collaboration worth flagging: ${practice} is starting on an introductory rate, so this one pays less to begin with.</p>`
        + `<div style="${rail}">${rates}</div>`
        + `<p>Your existing collaboration is unaffected and continues at its current rate.</p>`;
    } else {
      rateHtml = `<p>This collaboration starts on an introductory rate:</p><div style="${rail}">${rates}</div>`;
    }
  } else if (prevIsPromo) {
    rateHtml = `<p>Unlike your existing collaboration, this one has no introductory period. It pays <strong>${standardPayout}</strong> per month from ${collaboration.start_date}.</p>`;
  } else if (previous) {
    rateHtml = `<p>Nothing changes in how you're paid. This one runs at <strong>${standardPayout}</strong> per month, on the same terms as your existing collaboration.</p>`;
  } else {
    rateHtml = `<p>It pays <strong>${standardPayout}</strong> per month.</p>`;
  }

  return sendEmail(env, {
    to: [physician.email],
    from: 'MD-Match <noreply@md-match.com>',
    replyTo: 'philipwasef@md-match.com',
    subject: newIsPromo
      ? `Your new collaboration with ${withWhom} — introductory rate`
      : `Your new collaboration with ${withWhom}`,
    html: `<p>Hi ${firstName},</p>`
      + `<p>You're set up for a new collaboration with ${withWhom}, starting ${collaboration.start_date}.</p>`
      + rateHtml
      + `<p>The transfer goes out once ${practice} pays their monthly invoice.</p>`
      // Only true for someone already connected. A physician who still has to
      // onboard is getting the setup link alongside this, and telling them there
      // is nothing to do would contradict it.
      + (alreadyOnboarded ? `<p>No action needed on your end; your payout account is already connected.</p>` : '')
      + `<p>Best,<br>Philip</p>`,
  });
}

// Shared by collaboration creation and the resend action so the two cannot drift.
// The token is minted fresh on every send: an earlier link may have expired, and
// a physician chasing a missing email should not be given a dead one.
// Carries the payout link and what the physician will be paid, in one email rather
// than two. The hand-written version of this told them a setup link was arriving
// separately and was legitimate; now that the link is in the same message, the
// reassurance is about Stripe rather than about a second email that no longer
// exists -- promising one that never arrives is worse than not reassuring at all.
//
// Takes the collaboration so it can state the rate. When called from the resend
// action months later that comes from the stored row, so a resent link describes
// the arrangement as it stands rather than as it was first typed.
async function sendPhysicianOnboardingEmail(env, origin, physician, collaboration) {
  const onboardToken = await tokens.createMagicToken(env, { pid: physician.id });
  const onboardStartUrl = `${origin}/physician-onboard/start?pid=${physician.id}&t=${encodeURIComponent(onboardToken)}`;
  const lastName = physician.full_name.split(' ').pop();

  const standardPayout = collaboration
    ? usd(collaboration.total_amount_cents - collaboration.platform_fee_cents)
    : null;
  const isPromo = !!(collaboration && collaboration.promo_end_date && collaboration.promo_payout_cents != null);

  let scheduleHtml = '';
  if (isPromo) {
    scheduleHtml =
      `<p>Your payment schedule:</p>`
      + `<div style="${RATE_RAIL}">`
      + `<p style="margin:0 0 4px">Until ${collaboration.promo_end_date}: <strong>${usd(collaboration.promo_payout_cents)}</strong> / month</p>`
      + `<p style="margin:0">From ${collaboration.promo_end_date}: <strong>${standardPayout}</strong> / month</p>`
      + `</div>`
      + `<p>The provider is on an introductory rate until ${collaboration.promo_end_date}.</p>`
      + `<p>Please complete the setup now even though the first standard payment is not until ${collaboration.start_date}, so there is no delay when payments begin. You will receive the introductory rate in the interim.</p>`;
  } else if (standardPayout) {
    scheduleHtml =
      `<p>You'll receive <strong>${standardPayout}</strong> per month, sent automatically once the provider's monthly invoice is settled — nothing to invoice or chase on your end.</p>`;
  }

  return sendEmail(env, {
    to: [physician.email],
    from: 'MD-Match <noreply@md-match.com>',
    // Someone who replies asking why they cannot find this email should reach a
    // person rather than the unmonitored sending address.
    replyTo: 'philipwasef@md-match.com',
    subject: 'Setting up your payouts (5 minutes)',
    html: `<p>Hi Dr. ${lastName},</p>`
      + `<p>To receive your monthly collaboration payment, please complete a short payout setup with Stripe, the payment processor we use to pay you directly:</p>`
      + `<p><a href="${onboardStartUrl}">${onboardStartUrl}</a></p>`
      + `<p>Stripe will ask for your legal name, date of birth, the last 4 of your SSN, and the bank account you'd like to be paid into. That's their legal requirement for anyone receiving payouts through the platform, not something we're asking for ourselves. It takes about five minutes.</p>`
      + scheduleHtml
      + `<p>Any questions, just reply here.</p>`
      + `<p>Best,<br>Philip</p>`,
  });
}

async function handleCreateCollaboration(request, env) {
  try {
    const {
      clientId, physicianId, physicianPayoutUsd, netFeeUsd, stripeFeeShare,
      startDate, paymentTermsDays,
      providerName, promoPayoutUsd, promoNetFeeUsd, promoEndDate, notes,
    } = await request.json();

    // The form asks for the two figures that are actually negotiated -- what the
    // physician is paid, and what this is worth to the platform -- and the client's
    // total is derived from them. It used to ask for the total and the fee, which
    // meant the platform's real earnings were whatever was left after Stripe took
    // its cut, discovered weeks later in a payout rather than at creation.
    //
    // stripeFeeShare decides who carries Stripe's cut: 1 adds all of it to the
    // client's total so the stated fee is what the platform keeps, 0 leaves the
    // platform absorbing it as before, and 0.5 splits it. Anything in between works;
    // the figure is a proportion, not a menu.
    const physicianPayoutCents = Math.round(Number(physicianPayoutUsd) * 100);
    const netFeeCents = Math.round(Number(netFeeUsd ?? 200) * 100);
    if (!Number.isFinite(physicianPayoutCents) || physicianPayoutCents <= 0) {
      return jsonResponse({ success: false, error: 'Physician payout must be greater than zero' }, 400);
    }
    if (!Number.isFinite(netFeeCents) || netFeeCents <= 0) {
      return jsonResponse({ success: false, error: 'Your fee must be greater than zero' }, 400);
    }

    // Every collaboration created from here is billed by the app rather than by a
    // Stripe subscription, which prices the same invoice at 0.4% instead of 0.7%.
    // Existing rows stay on 'subscription' and are untouched.
    const billingMode = 'app_invoice';
    const totalAmountCents = stripeHelpers.grossUpTotalCents(
      physicianPayoutCents, netFeeCents, stripeFeeShare ?? 1, billingMode
    );
    // Stored as the gross fee, since that is what Stripe is instructed to collect.
    // The net the platform keeps is this less Stripe's cut.
    const platformFeeCents = totalAmountCents - physicianPayoutCents;
    // Whatever the gross-up added on top of the payout and the stated fee is the
    // client's share of Stripe's cut, and it gets its own line on the invoice so it
    // can be named rather than buried in the collaboration fee. Zero when the
    // platform absorbs the whole fee, which leaves a single-line invoice.
    const processingFeeCents = totalAmountCents - (physicianPayoutCents + netFeeCents);
    if (!totalAmountCents || totalAmountCents <= platformFeeCents) {
      return jsonResponse({ success: false, error: 'Invalid amount' }, 400);
    }

    // Stripe requires days_until_due to be a non-negative integer. Validate here
    // rather than at activation, which happens days later and would surface the
    // problem long after the value was entered.
    const termsDays = Math.round(Number(paymentTermsDays ?? stripeHelpers.DEFAULT_PAYMENT_TERMS_DAYS));
    if (!Number.isFinite(termsDays) || termsDays < 0 || termsDays > 365) {
      return jsonResponse({ success: false, error: 'Payment terms must be between 0 and 365 days' }, 400);
    }
    // Stripe's application_fee_percent accepts at most 2 decimal places, so the flat
    // platform fee can be off by a cent or two — acceptable for this fee structure.
    const applicationFeePercent = Math.round((platformFeeCents / totalAmountCents) * 100 * 100) / 100;

    // An introductory rate is the two fields together or neither. Half of it would
    // produce a notice quoting a promotional rate with no end date, or an end date
    // with no rate -- worse than not offering the option at all.
    const toCents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
    const promoPayoutCents = toCents(promoPayoutUsd);
    const promoNetFeeCents = toCents(promoNetFeeUsd);
    const promoEnd = promoEndDate || null;
    const promoParts = [promoPayoutCents, promoNetFeeCents, promoEnd];
    if (promoParts.some((p) => p === null) && promoParts.some((p) => p !== null)) {
      return jsonResponse({
        success: false,
        error: 'An introductory rate needs the physician payout, your fee, and the date it ends',
      }, 400);
    }

    let promoTotalCents = null;
    let promoProcessingFeeCents = null;
    if (promoPayoutCents !== null) {
      if (!Number.isFinite(promoPayoutCents) || promoPayoutCents <= 0
        || !Number.isFinite(promoNetFeeCents) || promoNetFeeCents <= 0) {
        return jsonResponse({ success: false, error: 'Introductory amounts must be greater than zero' }, 400);
      }
      // The promotional client total is derived the same way the standard one is,
      // and carries the same share of Stripe's cut -- a promotional invoice costs
      // the platform a fee too, and leaving it out would quietly make the
      // promotional months less profitable than the figure entered for them.
      promoTotalCents = stripeHelpers.grossUpTotalCents(
        promoPayoutCents, promoNetFeeCents, stripeFeeShare ?? 1, billingMode
      );
      promoProcessingFeeCents = promoTotalCents - (promoPayoutCents + promoNetFeeCents);
      // The promotional payout is what the physician receives instead of the full
      // amount, so a figure at or above the standard payout is a typo rather than a
      // generous promotion -- and the notice would tell them their rate improves
      // when the promotion ends.
      if (promoPayoutCents >= physicianPayoutCents) {
        return jsonResponse({
          success: false,
          error: 'Introductory payout must be less than the standard payout',
        }, 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(promoEnd)) {
        return jsonResponse({ success: false, error: 'Introductory end date must be a valid date' }, 400);
      }
      // The introductory period runs from the start date up to, but not including,
      // this date -- which is the first invoice charged at the standard rate. An end
      // date on or before the start date would describe a promotion with no months
      // in it while still telling both parties there was one.
      if (promoEnd <= startDate) {
        return jsonResponse({
          success: false,
          error: 'The introductory rate must end after the billing start date',
        }, 400);
      }
    }

    const client = await db.getClient(env.DB, clientId);
    const physician = await db.getPhysician(env.DB, physicianId);
    if (!client || !physician) {
      return jsonResponse({ success: false, error: 'Client or physician not found' }, 404);
    }

    // Read before the new row exists so it cannot match itself, and so a physician's
    // first collaboration is correctly seen as having no predecessor.
    const previous = await db.getPreviousCollaborationForPhysician(env.DB, physicianId, 0);

    const collaboration = await db.createCollaboration(env.DB, {
      clientId, physicianId, totalAmountCents, platformFeeCents, applicationFeePercent, startDate,
      paymentTermsDays: termsDays, providerName, promoPayoutCents, promoTotalCents,
      processingFeeCents, promoProcessingFeeCents,
      promoEndDate: promoEnd, notes,
      // The billing day is taken from the start date and then held, so 9/20 bills
      // on 10/20 and 11/20 rather than drifting.
      billingMode, billingDay: Number(String(startDate).slice(8, 10)),
    });

    const stripe = stripeHelpers.getStripe(env);
    const origin = new URL(request.url).origin;

    // Ensure the physician has a Connect account, and send the onboarding link only
    // to someone who still needs it. A physician on their second collaboration is
    // already connected, and mailing them a setup link they have to be told to
    // ignore teaches them that mail from us can be ignored.
    let stripeAccountId = physician.stripe_account_id;
    let needsOnboarding = true;
    if (!stripeAccountId) {
      const account = await stripeHelpers.createPhysicianAccount(stripe, physician);
      stripeAccountId = account.id;
      await db.setPhysicianStripeAccountId(env.DB, physician.id, stripeAccountId);
    } else {
      // Read live rather than trusting transfers_active: that column is maintained by
      // the account.updated webhook, which is a convenience for the admin UI rather
      // than a source of truth, and a stale 1 would withhold the link from someone
      // who still needs it.
      //
      // Any failure here falls through to sending. The two mistakes are not
      // symmetric: a duplicate email costs an explanation, while a missing one
      // leaves a physician unable to be paid with nothing telling them why.
      try {
        const account = await stripe.accounts.retrieve(stripeAccountId);
        const transfersActive = account.capabilities?.transfers === 'active';
        if (transfersActive !== !!physician.transfers_active) {
          await db.setPhysicianTransfersActive(env.DB, stripeAccountId, transfersActive);
        }
        needsOnboarding = !transfersActive;
      } catch (err) {
        console.error(`Could not read payout status for ${stripeAccountId}; sending onboarding email anyway:`, err);
      }
    }
    // Exactly one physician email, never both. The payout email now states the rate
    // itself, so sending the notice alongside it would repeat the figure in two
    // messages arriving together and leave the physician working out whether they
    // are two arrangements or one.
    if (needsOnboarding) {
      await sendPhysicianOnboardingEmail(env, origin, physician, collaboration);
    } else {
      await sendCollaborationNoticeEmail(env, {
        collaboration, client, physician, previous, alreadyOnboarded: true,
      });
    }

    // Ensure the client has a Stripe Customer for the monthly invoices to bill.
    // No payment method is collected: collaborations are invoiced rather than
    // charged automatically, so there is nothing for the client to authorise
    // up front.
    let stripeCustomerId = client.stripe_customer_id;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripeHelpers.createOrGetCustomer(stripe, client);
      await db.setClientStripeCustomerId(env.DB, client.id, stripeCustomerId);
    }
    await sendClientBillingEmail(env, collaboration, client, physician);

    return jsonResponse({ success: true, collaboration });
  } catch (err) {
    console.error('Create collaboration error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

// Ends a collaboration. The Stripe subscription is cancelled before the row is
// marked, and a Stripe failure aborts without touching the database: a row that
// reads cancelled while Stripe keeps issuing invoices would bill the client every
// month with nothing in the app showing it.
async function handleCancelCollaboration(request, env) {
  try {
    const { collaborationId } = await request.json();
    const collaboration = await db.getCollaboration(env.DB, collaborationId);
    if (!collaboration) return jsonResponse({ success: false, error: 'Not found' }, 404);

    if (collaboration.status === 'canceled') {
      return jsonResponse({ success: false, error: 'This collaboration is already cancelled' }, 400);
    }

    // pending_setup collaborations have no subscription, so there is nothing in
    // Stripe to unwind and this is a database-only change.
    let subscriptionCancelled = false;
    if (collaboration.stripe_subscription_id) {
      const stripe = stripeHelpers.getStripe(env);
      await stripeHelpers.cancelCollaborationSubscription(stripe, collaboration.stripe_subscription_id);
      subscriptionCancelled = true;
    }

    await db.setCollaborationStatus(env.DB, collaboration.id, 'canceled');
    return jsonResponse({ success: true, subscriptionCancelled });
  } catch (err) {
    console.error('Cancel collaboration error:', err);
    return jsonResponse({
      success: false,
      error: 'Could not cancel the Stripe subscription — the collaboration was left unchanged',
      detail: err?.message || String(err),
    }, 500);
  }
}

// Re-sends the client's billing confirmation. Nothing depends on the client
// reading it, but a bounced one leaves them unaware of what they will be invoiced
// and when, which is how a first invoice turns into a surprise.
async function handleResendClientEmail(request, env) {
  try {
    const { collaborationId } = await request.json();
    const collaboration = await db.getCollaboration(env.DB, collaborationId);
    if (!collaboration) return jsonResponse({ success: false, error: 'Not found' }, 404);

    const client = await db.getClient(env.DB, collaboration.client_id);
    const physician = await db.getPhysician(env.DB, collaboration.physician_id);
    if (!client || !physician) {
      return jsonResponse({ success: false, error: 'Client or physician not found' }, 404);
    }

    const sent = await sendClientBillingEmail(env, collaboration, client, physician);
    if (!sent) {
      return jsonResponse({ success: false, error: 'Email delivery failed — check the Resend logs' }, 502);
    }

    return jsonResponse({ success: true, email: client.email });
  } catch (err) {
    console.error('Resend client email error:', err);
    return jsonResponse({ success: false, error: 'Server error', detail: err?.message || String(err) }, 500);
  }
}

// Re-sends the payout onboarding email for a collaboration that already exists.
// Without this the only way to get a physician another link was to create a second
// collaboration, which would bill the client twice.
async function handleResendOnboarding(request, env) {
  try {
    const { collaborationId } = await request.json();
    const collaboration = await db.getCollaboration(env.DB, collaborationId);
    if (!collaboration) return jsonResponse({ success: false, error: 'Not found' }, 404);

    const physician = await db.getPhysician(env.DB, collaboration.physician_id);
    if (!physician) return jsonResponse({ success: false, error: 'Physician not found' }, 404);

    // The account is created when the collaboration is, so a missing one means
    // that step failed rather than that the physician has not finished onboarding.
    if (!physician.stripe_account_id) {
      return jsonResponse({
        success: false,
        error: 'This physician has no Stripe account yet — the collaboration may not have been created successfully',
      }, 400);
    }

    const origin = new URL(request.url).origin;
    const sent = await sendPhysicianOnboardingEmail(env, origin, physician, collaboration);
    if (!sent) {
      return jsonResponse({ success: false, error: 'Email delivery failed — check the Resend logs' }, 502);
    }

    return jsonResponse({ success: true, email: physician.email });
  } catch (err) {
    console.error('Resend onboarding error:', err);
    return jsonResponse({ success: false, error: 'Server error', detail: err?.message || String(err) }, 500);
  }
}

// Today in Eastern, as YYYY-MM-DD. Billing dates are calendar dates a person chose
// from a calendar, so they have to be compared in the timezone that person is in --
// UTC would bill a day early every evening after 8pm.
function easternDateString(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// The address the drafts are written to be sent from, and sent to.
const OWNER_EMAIL = 'philipwasef@md-match.com';

function easternDateFromUnix(seconds) {
  return easternDateString(new Date(seconds * 1000));
}

function prettyDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
  });
}

// A reminder written to come from a person rather than from Stripe.
//
// Clients ignore Stripe's own dunning mail and answer a note from someone they
// have met, so the app does not send this: it drafts it and hands it over. The
// Gmail compose link opens the draft already addressed and written, in the
// account the client recognises, one review and one click from sent.
function buildPaymentNudge(invoice) {
  const firstName = String(invoice.customer_name || '').trim().split(' ')[0] || 'there';
  const amount = '$' + (invoice.amount_remaining / 100).toFixed(2);
  const dueOn = prettyDate(easternDateFromUnix(invoice.due_date));

  const subject = `Invoice ${invoice.number || ''} — due ${dueOn}`.replace('  ', ' ');
  const body = [
    `Hi ${firstName},`,
    '',
    `Quick note that your invoice for ${amount} is due tomorrow, ${dueOn}.`,
    '',
    'You can pay it here:',
    invoice.hosted_invoice_url || '',
    '',
    'If you have already sent it, please ignore this. If anything looks wrong, just reply and I will sort it out.',
    '',
    'Best,',
    'Philip',
  ].join('\n');

  const gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1'
    + `&to=${encodeURIComponent(invoice.customer_email || '')}`
    + `&su=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;

  return { invoice, firstName, amount, dueOn, subject, body, gmailUrl };
}

// Finds invoices falling due tomorrow that nobody has paid, and drafts one
// reminder each. Returns what it found whether or not it sent, so the admin page
// can show the same list without claiming anything.
async function findPaymentNudges(env, now) {
  const stripe = stripeHelpers.getStripe(env);
  const tomorrow = easternDateString(new Date(now.getTime() + 86400000));
  const open = await stripeHelpers.listOpenInvoices(stripe);

  return open
    .filter((inv) => inv.due_date && inv.amount_remaining > 0
      && easternDateFromUnix(inv.due_date) === tomorrow)
    .map(buildPaymentNudge);
}

async function runPaymentNudges(env, now) {
  const nudges = await findPaymentNudges(env, now);
  const sent = [];

  for (const n of nudges) {
    if (!(await db.claimPaymentNudge(env.DB, n.invoice.id, 'due_tomorrow'))) continue;
    sent.push(n);
  }
  if (!sent.length) return [];

  const blocks = sent.map((n) => `
    <div style="margin:0 0 28px;padding:16px 18px;border:1px solid #d5ded9;border-radius:6px">
      <p style="margin:0 0 4px;font-size:15px"><strong>${n.invoice.customer_name || n.invoice.customer_email}</strong>
        &mdash; ${n.amount}, due ${n.dueOn}</p>
      <p style="margin:0 0 14px;font-size:13px;color:#6b7b76">${n.invoice.number || ''} &middot; ${n.invoice.customer_email}</p>
      <p style="margin:0 0 14px">
        <a href="${n.gmailUrl}" style="background:#0b3535;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block">Open this draft in Gmail</a>
      </p>
      <pre style="margin:0;padding:12px;background:#f4f7f6;border-radius:4px;font-family:inherit;font-size:13px;white-space:pre-wrap">${esc(n.body)}</pre>
    </div>`).join('');

  await sendEmail(env, {
    to: [OWNER_EMAIL],
    from: 'MD-Match <noreply@md-match.com>',
    replyTo: OWNER_EMAIL,
    subject: sent.length === 1
      ? `Due tomorrow: ${sent[0].invoice.customer_name || sent[0].invoice.customer_email} (${sent[0].amount})`
      : `${sent.length} invoices due tomorrow`,
    html: `<p>These invoices fall due tomorrow and are still unpaid. The button opens each
      draft in Gmail, already addressed and written &mdash; review it and press send.</p>${blocks}`,
  });

  return sent.map((n) => ({
    invoiceId: n.invoice.id, number: n.invoice.number,
    client: n.invoice.customer_name, amount: n.amount, dueOn: n.dueOn,
  }));
}

// What a given invoice date should charge.
//
// The introductory period runs from the start date up to but NOT including
// promo_end_date, so that date is the first invoice at the standard rate. Handling
// it this way means a promotion is described by one date rather than by counting
// months, and the emails can name the same date as the changeover.
//
// Dates are ISO strings, so a plain string comparison orders them correctly and
// avoids constructing Date objects whose timezone would have to be reasoned about.
function collaborationRateOn(collaboration, invoiceDate) {
  const promotional = !!collaboration.promo_end_date
    && collaboration.promo_total_cents != null
    && collaboration.promo_payout_cents != null
    && invoiceDate < collaboration.promo_end_date;

  return promotional
    ? {
      promotional: true,
      totalCents: collaboration.promo_total_cents,
      feeCents: collaboration.promo_total_cents - collaboration.promo_payout_cents,
      processingFeeCents: collaboration.promo_processing_fee_cents || 0,
    }
    : {
      promotional: false,
      totalCents: collaboration.total_amount_cents,
      feeCents: collaboration.platform_fee_cents,
      processingFeeCents: collaboration.processing_fee_cents || 0,
    };
}

// Issues every invoice that is due, one collaboration at a time.
//
// The month is claimed in the database before Stripe is called, and the claim is
// kept even when the call fails. The two failures are not symmetric: a missed
// invoice shows up in the billing panel and can be issued by hand, while a
// duplicate has already asked a client for money twice and needs a credit note and
// an apology. So a failure stops that month rather than leaving it open to a retry
// that cannot tell whether the first attempt reached Stripe.
//
// Anything checkable is checked before the claim, so the recoverable failures --
// a client with no customer record, a physician who never finished onboarding --
// leave the month open to try again rather than burning it.
async function runCollaborationBilling(env, today) {
  const due = await db.listCollaborationsDueForInvoice(env.DB, today);
  const results = [];

  for (const c of due) {
    const period = c.next_invoice_date.slice(0, 7);
    const rate = collaborationRateOn(c, c.next_invoice_date);
    const entry = {
      collaborationId: c.id, period, client: c.client_name, physician: c.physician_name,
      amount: rate.totalCents, promotional: rate.promotional,
    };

    if (!c.stripe_customer_id || !c.stripe_account_id) {
      entry.error = !c.stripe_customer_id
        ? 'client has no Stripe customer'
        : 'physician has no connected account';
      console.error(`Billing skipped for collaboration ${c.id} (${period}): ${entry.error}`);
      results.push(entry);
      continue;
    }

    if (!(await db.claimInvoiceRun(env.DB, c.id, period))) {
      entry.skipped = 'already billed for this period';
      results.push(entry);
      continue;
    }

    try {
      const stripe = stripeHelpers.getStripe(env);
      const invoice = await stripeHelpers.createCollaborationInvoice(stripe, {
        customerId: c.stripe_customer_id,
        physicianAccountId: c.stripe_account_id,
        totalAmountCents: rate.totalCents,
        platformFeeCents: rate.feeCents,
        paymentTermsDays: c.payment_terms_days,
        processingFeeCents: rate.processingFeeCents,
        description: rate.promotional
          ? `Collaboration services — ${c.physician_name} (introductory rate)`
          : `Collaboration services — ${c.physician_name}`,
      });
      await db.recordInvoiceRunResult(env.DB, c.id, period, { invoiceId: invoice.id });
      await db.setCollaborationBillingSchedule(env.DB, c.id, {
        billingDay: c.billing_day,
        nextInvoiceDate: stripeHelpers.nextMonthlyDate(c.next_invoice_date, c.billing_day),
      });
      entry.invoiceId = invoice.id;
      entry.number = invoice.number;
    } catch (err) {
      const message = err?.message || String(err);
      // Loud, because the month stays claimed and this collaboration will not bill
      // again until somebody clears it.
      console.error(`Billing FAILED for collaboration ${c.id} (${period}):`, message);
      await db.recordInvoiceRunResult(env.DB, c.id, period, { error: message });
      entry.error = message;
    }
    results.push(entry);
  }

  return results;
}

async function handleActivateCollaboration(request, env) {
  try {
    const { collaborationId } = await request.json();
    const collaboration = await db.getCollaboration(env.DB, collaborationId);
    if (!collaboration) return jsonResponse({ success: false, error: 'Not found' }, 404);

    const physician = await db.getPhysician(env.DB, collaboration.physician_id);
    const client = await db.getClient(env.DB, collaboration.client_id);

    const stripe = stripeHelpers.getStripe(env);

    // Check the physician's Connect account status live rather than trusting the
    // account.updated webhook to have already flipped transfers_active — the webhook
    // is a convenience for the admin UI, not the source of truth for this gate.
    const account = await stripe.accounts.retrieve(physician.stripe_account_id);
    const transfersActive = account.capabilities?.transfers === 'active';
    if (transfersActive !== !!physician.transfers_active) {
      await db.setPhysicianTransfersActive(env.DB, physician.stripe_account_id, transfersActive);
    }
    if (!transfersActive) {
      return jsonResponse({ success: false, error: 'Physician has not completed payout onboarding yet' }, 400);
    }
    // No client-side gate: the subscription invoices the client rather than
    // charging a saved payment method, so there is nothing they must complete
    // before it can be activated.

    // App-billed collaborations have no subscription to create. Activation just
    // opens the billing schedule; the scheduled handler issues the invoices, and
    // is called straight away so a start date that has already arrived bills now
    // rather than waiting for tomorrow's tick.
    if (collaboration.billing_mode === 'app_invoice') {
      await db.activateCollaboration(env.DB, collaboration.id, null);
      await db.setCollaborationBillingSchedule(env.DB, collaboration.id, {
        billingDay: collaboration.billing_day || Number(collaboration.start_date.slice(8, 10)),
        nextInvoiceDate: collaboration.start_date,
      });
      const billed = await runCollaborationBilling(env, easternDateString(new Date()));
      const mine = billed.find((r) => r.collaborationId === collaboration.id);
      return jsonResponse({ success: true, billingMode: 'app_invoice', firstInvoice: mine || null });
    }

    const subscription = await stripeHelpers.createCollaborationSubscription(stripe, {
      customerId: client.stripe_customer_id,
      physicianAccountId: physician.stripe_account_id,
      totalAmountCents: collaboration.total_amount_cents,
      applicationFeePercent: collaboration.application_fee_percent,
      startDateISO: collaboration.start_date,
      description: `Collaboration services — ${physician.full_name}`,
      paymentTermsDays: collaboration.payment_terms_days,
    });

    await db.activateCollaboration(env.DB, collaboration.id, subscription.id);
    return jsonResponse({ success: true, subscriptionId: subscription.id });
  } catch (err) {
    console.error('Activate collaboration error:', err);
    return jsonResponse({ success: false, error: 'Server error', detail: err?.message || String(err) }, 500);
  }
}

// ---- Physician Connect onboarding ----

async function handlePhysicianOnboardStart(request, env, url) {
  const pid = Number(url.searchParams.get('pid'));
  const t = url.searchParams.get('t');
  const payload = await tokens.verifyMagicToken(env, t);
  if (!payload || payload.pid !== pid) {
    return new Response('Invalid or expired link.', { status: 403 });
  }

  const physician = await db.getPhysician(env.DB, pid);
  if (!physician) return new Response('Not found.', { status: 404 });

  const stripe = stripeHelpers.getStripe(env);
  let stripeAccountId = physician.stripe_account_id;
  if (!stripeAccountId) {
    const account = await stripeHelpers.createPhysicianAccount(stripe, physician);
    stripeAccountId = account.id;
    await db.setPhysicianStripeAccountId(env.DB, physician.id, stripeAccountId);
  }

  const origin = url.origin;
  const refreshUrl = `${origin}/physician-onboard/start?pid=${pid}&t=${encodeURIComponent(t)}`;
  const returnUrl = `${origin}/physician-onboard/complete?pid=${pid}`;
  const onboardingUrl = await stripeHelpers.createPhysicianOnboardingLink(stripe, stripeAccountId, refreshUrl, returnUrl);

  return Response.redirect(onboardingUrl, 302);
}

async function handlePhysicianOnboardComplete(request, env, url) {
  const pid = Number(url.searchParams.get('pid'));
  try {
    const physician = await db.getPhysician(env.DB, pid);
    if (physician?.stripe_account_id) {
      const stripe = stripeHelpers.getStripe(env);
      const account = await stripe.accounts.retrieve(physician.stripe_account_id);
      const transfersActive = account.capabilities?.transfers === 'active';
      await db.setPhysicianTransfersActive(env.DB, physician.stripe_account_id, transfersActive);
    }
  } catch (err) {
    console.error('Physician onboard complete status check error:', err);
  }
  return new Response(
    '<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center"><h2>Thanks!</h2><p>Your payout setup is being reviewed. We\'ll notify you once your collaboration is active.</p></body></html>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}

// ---- Client ACH bank linking ----

async function handleClientAddBankStart(request, env, url) {
  const collabId = Number(url.searchParams.get('collab'));
  const t = url.searchParams.get('t');
  const payload = await tokens.verifyMagicToken(env, t);
  if (!payload || payload.cid !== collabId) {
    return new Response('Invalid or expired link.', { status: 403 });
  }

  const collaboration = await db.getCollaboration(env.DB, collabId);
  if (!collaboration) return new Response('Not found.', { status: 404 });
  const client = await db.getClient(env.DB, collaboration.client_id);

  const stripe = stripeHelpers.getStripe(env);
  let stripeCustomerId = client.stripe_customer_id;
  if (!stripeCustomerId) {
    stripeCustomerId = await stripeHelpers.createOrGetCustomer(stripe, client);
    await db.setClientStripeCustomerId(env.DB, client.id, stripeCustomerId);
  }

  const origin = url.origin;
  const successUrl = `${origin}/client/add-bank/complete?collab=${collabId}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/client/add-bank/start?collab=${collabId}&t=${encodeURIComponent(t)}`;
  const checkoutUrl = await stripeHelpers.createBankLinkCheckoutSession(stripe, stripeCustomerId, successUrl, cancelUrl, { collaboration_id: String(collabId) });

  return Response.redirect(checkoutUrl, 302);
}

async function handleClientAddBankComplete(request, env, url) {
  const collabId = Number(url.searchParams.get('collab'));
  const sessionId = url.searchParams.get('session_id');
  try {
    const stripe = stripeHelpers.getStripe(env);
    await stripeHelpers.attachDefaultPaymentMethodFromSetup(stripe, sessionId);
    await db.setCollaborationClientPaymentReady(env.DB, collabId, true);
  } catch (err) {
    console.error('Bank link complete error:', err);
  }
  return new Response(
    '<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center"><h2>Bank account connected</h2><p>Thanks! Your payment method is on file. We\'ll be in touch once your collaboration is active.</p></body></html>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}

async function sendEmail(env, { to, from, subject, html, attachments, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, attachments, reply_to: replyTo }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error('Resend error:', res.status, errBody);
  }
  return res.ok;
}

function buildPhysicianSummary(f) {
  const row = (label, val) =>
    `<tr><td style="padding:6px 12px;font-weight:600;color:#1e2530;background:#f2f4f6;width:38%;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${label}</td><td style="padding:6px 12px;color:#1e2530;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${val || '—'}</td></tr>`;

  const section = (title) =>
    `<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">${title}</td></tr>`;

  return `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">Physician Application — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${section('Personal & Credentials')}
    ${row('Full Name', f['Full Name'])}
    ${row('Email', f['Email'])}
    ${row('Phone', f['Phone'])}
    ${row('Medical Degree', f['Medical Degree'])}
    ${row('Specialty', f['Specialty'])}
    ${row('Board Certification Status', f['Board Certification Status'])}
    ${row('NPI Number', f['NPI Number'])}
    ${row('Years in Practice', f['Years in Practice'])}
    ${row('State of Residence', f['State of Residence'])}
    ${section('Licensure, Collaboration & DEA')}
    ${row('Licensed States', f['Licensed States'])}
    ${row('Available to Collaborate', f['Collab States'])}
    ${row('DEA States', f['DEA States'])}
    ${row('Willing to Get Additional Licenses', f['Willing to Get Additional Licenses'])}
    ${row('Willing to Get Additional DEAs', f['Willing to Get Additional DEAs'])}
    ${section('Clinical Preferences')}
    ${row('Controlled Substances Comfort', f['Controlled Substances Comfort'])}
    ${f['Controlled Substances Comfort'] !== 'No' ? row('Schedule II Signoff', f['Schedule II Signoff']) : ''}
    ${row('IV Ketamine Comfort', f['IV Ketamine Comfort'])}
    ${row('IM Ketamine Comfort', f['IM Ketamine Comfort'])}
    ${row('Intranasal Esketamine Comfort', f['Intranasal Esketamine Comfort'])}
    ${row('TMS Comfort', f['TMS Comfort'])}
    ${row('Credentialing Willingness', f['Credentialing Willingness'])}
    ${row('Collaboration Modalities', f['Collaboration Modalities'])}
    ${row('Open to Medical Director Roles', f['Medical Director Roles'])}
    ${row('Open to Physician-Owned Arrangements', f['Physician-Owned Arrangements'])}
    ${row('Insurance Credentialing', f['Insurance Credentialing'])}
    ${row('Mental Health Collaboration Experience', f['Mental Health Collaboration Experience'])}
    ${section('Legal & Board Standing')}
    ${row('Board Disciplinary Action', f['Board Action'])}
    ${f['Board Action'] === 'Yes' ? row('Board Action Details', f['Board Action Details']) : ''}
    ${row('License Suspension', f['License Suspension'])}
    ${f['License Suspension'] === 'Yes' ? row('License Suspension Details', f['License Suspension Details']) : ''}
    ${row('DEA Action', f['DEA Action'])}
    ${f['DEA Action'] === 'Yes' ? row('DEA Action Details', f['DEA Action Details']) : ''}
    ${row('Malpractice', f['Malpractice'])}
    ${f['Malpractice'] === 'Yes' ? row('Malpractice Details', f['Malpractice Details']) : ''}
    ${section('Referral')}
    ${row('How Did You Hear About Us', f['How Did You Hear About MD-Match'])}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">Word document attached · MD-Match.com</p>
</div>`;
}

function buildSummary(f) {
  const row = (label, val) =>
    `<tr><td style="padding:6px 12px;font-weight:600;color:#1e2530;background:#f2f4f6;width:38%;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${label}</td><td style="padding:6px 12px;color:#1e2530;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${val || '—'}</td></tr>`;

  const section = (title) =>
    `<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">${title}</td></tr>`;

  return `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">NP / PA Application — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${section('Provider Information')}
    ${row('Full Name', f['Full Name'])}
    ${row('Email', f['Email'])}
    ${row('Phone', f['Phone'])}
    ${row('Provider Type', f['Provider Type'])}
    ${row('Highest Degree Earned', f['Medical Degree'])}
    ${row('Specialty', f['Specialty'])}
    ${row('Years of Experience', f['Years of Clinical Experience'])}
    ${row('Years of Psychiatry Experience', f['Years of Psychiatry Experience'])}
    ${f['Practice Site Address'] ? row('Practice Site Address', f['Practice Site Address']) : ''}
    ${section('Reason for Seeking Collaboration')}
    ${row('Why Seeking Collaboration', f['Why Seeking Collaboration'])}
    ${f['Why Switching Details'] ? row('Why Switching', f['Why Switching Details']) : ''}
    ${f['Other Reason Details'] ? row('Other Reason', f['Other Reason Details']) : ''}
    ${section('Collaboration & Licensure')}
    ${row('States Needing Collaboration', f['States Needing Collaboration'])}
    ${row('DEA States', f['DEA States'])}
    ${section('Practice Details')}
    ${row('Patient Setting', f['Patient Setting'])}
    ${row('Practice Setting', f['Practice Setting'])}
    ${row('Patient Population', f['Patient Population'])}
    ${row('Weekly Hours', f['Weekly Hours'])}
    ${section('Clinical Services')}
    ${row('Controlled Substances', f['Controlled Substances'])}
    ${f['Controlled Substances'] === 'Yes' ? row('Controlled Substance Schedule', f['Controlled Substance Schedule']) : ''}
    ${f['Controlled Substances'] === 'Yes' ? row('MAT Services', f['MAT Services']) : ''}
    ${row('Interventional Route', f['Interventional Route'])}
    ${f['Interventional Practice Notes'] ? row('Interventional Notes', f['Interventional Practice Notes']) : ''}
    ${row('TMS', f['TMS'])}
    ${section('Legal & Board Standing')}
    ${row('Board Disciplinary Action', f['Board Action'])}
    ${f['Board Action'] === 'Yes' ? row('Board Action Details', f['Board Action Details']) : ''}
    ${row('License Suspension', f['License Suspension'])}
    ${f['License Suspension'] === 'Yes' ? row('License Suspension Details', f['License Suspension Details']) : ''}
    ${row('DEA Action', f['DEA Action'])}
    ${f['DEA Action'] === 'Yes' ? row('DEA Action Details', f['DEA Action Details']) : ''}
    ${row('Malpractice', f['Malpractice'])}
    ${f['Malpractice'] === 'Yes' ? row('Malpractice Details', f['Malpractice Details']) : ''}
    ${section('Availability')}
    ${row('Ideal Start Date', f['Ideal Start Date'])}
    ${row('First Patient Timeline', f['First Patient Timeline'])}
    ${row('Additional Information', f['Additional Information'])}
    ${section('Referral')}
    ${row('How Did You Hear About Us', f['How Did You Hear About MD-Match'])}
    ${f['Referred By'] ? row('Referred By', f['Referred By']) : ''}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">Word document attached · MD-Match.com</p>
</div>`;
}

async function handleNpPaIntakeStep1(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key in fields) {
        fields[key] = fields[key] + ', ' + value;
      } else {
        fields[key] = value;
      }
    }

    const id = crypto.randomUUID();

    // Persist step 1 data in D1
    try {
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS intake_drafts (id TEXT PRIMARY KEY, data TEXT, created_at INTEGER)`);
      await env.DB.prepare(`INSERT INTO intake_drafts (id, data, created_at) VALUES (?, ?, ?)`)
        .bind(id, JSON.stringify(fields), Date.now())
        .run();
    } catch (dbErr) {
      console.error('DB error saving intake draft:', dbErr?.message || dbErr);
      return jsonResponse({ success: false, error: 'Failed to save draft' }, 500);
    }

    // Also create a client record for admin matching
    const fullName = [fields['First Name'], fields['Last Name']].filter(Boolean).join(' ');
    const email = fields['Professional Email'] || '';
    try {
      if (email) {
        const existing = await db.getClientByEmail(env.DB, email);
        if (!existing) {
          await db.createClient(env.DB, { fullName, email, phone: fields['Phone Number'] || null });
        }
      }
    } catch (dbErr) {
      console.error('DB error saving client:', dbErr?.message || dbErr);
    }

    // Send step-1 notification email (no docx — just contact details)
    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set');
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    const statesList = fields['States of Practice'] || fields['States Needing Collaboration'] || '—';
    const providerType = fields['Provider Type'] === 'np' ? 'NP' : fields['Provider Type'] === 'pa' ? 'PA' : fields['Provider Type'] || '—';
    const nameDisplay = fullName || 'Unknown';
    const stateDisplay = statesList;

    const step1Html = `
<div style="max-width:600px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8">New intake started — ${nameDisplay}</h2>
  <p style="color:#555;font-size:13px">Step 1 complete. This provider has NOT yet submitted clinical details (Step 2).</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;width:38%;font-size:13px;border-bottom:1px solid #ddd">Name</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${nameDisplay}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Credential</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${providerType}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Email</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${email || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Phone</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Phone Number'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">State(s)</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${statesList}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Specialty</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${resolveSpecialty(fields) || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Years of Experience</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Years of Experience'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Practice Setting</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['practice_setting_step1'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Patient Population</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Patient Population'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Weekly Hours</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Weekly Hours Per Week'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Practice Site Address</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Practice Site Address'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Ideal Start Date</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Ideal Start Date'] || '—'}</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">First Patient Timeline</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['First Patient Timeline'] || '—'}</td></tr>
    ${fields['Why Seeking Collaboration'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">What Brings Them</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Why Seeking Collaboration']}</td></tr>` : ''}
    ${fields['Why Switching'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Reason for Switching</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Why Switching']}</td></tr>` : ''}
    ${fields['Referred By'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Referred By</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Referred By']}</td></tr>` : ''}
    <tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">Background Screening</td></tr>
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Board Disciplinary Action</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['boardAction'] === 'yes' ? 'Yes' : 'No'}</td></tr>
    ${fields['boardAction'] === 'yes' && fields['Board Action Details'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Board Action Details</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Board Action Details']}</td></tr>` : ''}
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">License Suspension</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['licenseSuspension'] === 'yes' ? 'Yes' : 'No'}</td></tr>
    ${fields['licenseSuspension'] === 'yes' && fields['License Suspension Details'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">License Suspension Details</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['License Suspension Details']}</td></tr>` : ''}
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">DEA Action</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['deaAction'] === 'yes' ? 'Yes' : 'No'}</td></tr>
    ${fields['deaAction'] === 'yes' && fields['DEA Action Details'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">DEA Action Details</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['DEA Action Details']}</td></tr>` : ''}
    <tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Malpractice</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['malpractice'] === 'yes' ? 'Yes' : 'No'}</td></tr>
    ${fields['malpractice'] === 'yes' && fields['Malpractice Details'] ? `<tr><td style="padding:6px 12px;font-weight:600;background:#f2f4f6;font-size:13px;border-bottom:1px solid #ddd">Malpractice Details</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #ddd">${fields['Malpractice Details']}</td></tr>` : ''}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">Submission ID: ${id} · MD-Match.com</p>
</div>`;

    const resendPayload = {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
      reply_to: email || undefined,
      subject: `New intake started — ${nameDisplay}, ${stateDisplay}`,
      html: step1Html,
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(resendPayload),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error (step1):', resendRes.status, errBody);
      // Don't fail — the draft is saved, return the id so the user can proceed
    }

    return jsonResponse({ success: true, id });
  } catch (err) {
    console.error('handleNpPaIntakeStep1 error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

async function handleNpPaIntakeStep2(request, env) {
  try {
    const formData = await request.formData();
    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key in fields) {
        fields[key] = fields[key] + ', ' + value;
      } else {
        fields[key] = value;
      }
    }

    const submissionId = fields['submission_id'];
    if (!submissionId) {
      return jsonResponse({ success: false, error: 'Missing submission ID' }, 400);
    }

    // Look up step 1 data
    let step1Fields = {};
    try {
      const row = await env.DB.prepare(`SELECT data FROM intake_drafts WHERE id = ?`).bind(submissionId).first();
      if (row) {
        step1Fields = JSON.parse(row.data);
      }
    } catch (dbErr) {
      console.error('DB error fetching draft:', dbErr?.message || dbErr);
    }

    // Merge step 1 + step 2 fields
    const providerTypeMap = { 'np': 'Nurse Practitioner (NP / APRN)', 'pa': 'Physician Assistant (PA)' };
    const practiceSettingMap = {
      'solo': 'Solo Practice',
      'group': 'Group Practice',
      'telehealth': 'Telehealth',
      'med-spa': 'Med Spa',
      'other': 'Other',
    };
    const timelineMap = {
      'immediately': 'Immediately',
      '1-3-months': '1–3 months',
      'exploring': 'Just exploring',
    };
    const controlledMap = { 'yes': 'Yes', 'no': 'No', 'unsure': 'Unsure / Not yet' };
    const yesNoMap = { 'yes': 'Yes', 'no': 'No', 'planning': 'Planning to' };

    const fullName = [step1Fields['First Name'], step1Fields['Last Name']].filter(Boolean).join(' ') || '—';
    const email = step1Fields['Professional Email'] || '—';
    const statesList = step1Fields['States of Practice'] || '—';

    const f = {
      'Full Name': fullName,
      'Email': email,
      'Phone': step1Fields['Phone Number'] || '—',
      'Provider Type': providerTypeMap[step1Fields['Provider Type']] || step1Fields['Provider Type'] || '—',
      'Specialty': resolveSpecialty(step1Fields),
      'States Needing Collaboration': statesList,
      'Years of Experience': step1Fields['Years of Experience'] || '—',
      'Practice Setting': step1Fields['practice_setting_step1'] || '—',
      'Patient Population': step1Fields['Patient Population'] || '—',
      'Weekly Hours Per Week': step1Fields['Weekly Hours Per Week'] || '—',
      'Practice Site Address': step1Fields['Practice Site Address'] || '',
      'Ideal Start Date': step1Fields['Ideal Start Date'] || '—',
      'First Patient Timeline': step1Fields['First Patient Timeline'] || '—',
      'Why Seeking Collaboration': step1Fields['Why Seeking Collaboration'] || '',
      'Why Switching': step1Fields['Why Switching'] || '',
      'Referred By': step1Fields['Referred By'] || '',
      // Background screening (step 1 — email only, not in docx)
      'Board Action': step1Fields['boardAction'] === 'yes' ? 'Yes' : 'No',
      'Board Action Details': step1Fields['Board Action Details'] || '',
      'License Suspension': step1Fields['licenseSuspension'] === 'yes' ? 'Yes' : 'No',
      'License Suspension Details': step1Fields['License Suspension Details'] || '',
      'DEA Action': step1Fields['deaAction'] === 'yes' ? 'Yes' : 'No',
      'DEA Action Details': step1Fields['DEA Action Details'] || '',
      'Malpractice': step1Fields['malpractice'] === 'yes' ? 'Yes' : 'No',
      'Malpractice Details': step1Fields['Malpractice Details'] || '',
      // Step 2 clinical fields
      'Controlled Substances': controlledMap[fields['controlled']] || fields['controlled'] || '—',
      'Stimulants Frequency': fields['Stimulants Frequency'] || '',
      'Benzodiazepines Frequency': fields['Benzodiazepines Frequency'] || '',
      'Buprenorphine / Suboxone': yesNoMap[fields['buprenorphine']] || fields['buprenorphine'] || '—',
      'IV Ketamine': yesNoMap[fields['iv_ketamine']] || fields['iv_ketamine'] || '—',
      'IM Ketamine': yesNoMap[fields['im_ketamine']] || fields['im_ketamine'] || '—',
      'Intranasal Ketamine': yesNoMap[fields['intranasal_ketamine']] || fields['intranasal_ketamine'] || '—',
      'TMS': yesNoMap[fields['tms_clinical']] || fields['tms_clinical'] || '—',
      'Family Medicine Services': fields['Family Medicine Services'] || '',
      'Additional Information': fields['Anything Else We Should Know'] || '',
    };

    // Generate merged Word document
    let docxResult;
    try {
      docxResult = await generateNpPaIntakeDocx(f);
    } catch (docxErr) {
      console.error('DOCX generation error (step2):', docxErr?.message || docxErr);
      return jsonResponse({ success: false, error: 'Document generation failed' }, 500);
    }

    const providerName = fullName !== '—' ? fullName : 'Unknown';
    const filename = `NP-PA-Profile-${providerName.replace(/[^a-zA-Z0-9]/g, '-')}.docx`;

    if (!env.RESEND_API_KEY) {
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    const summaryHtml = buildStep2Summary(f);

    const resendPayload = {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com', 'pwase001@gmail.com'],
      reply_to: email !== '—' ? email : undefined,
      subject: `New NP/PA Application — ${providerName}`,
      html: summaryHtml,
      attachments: [{ filename, content: docxResult.base64 }],
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(resendPayload),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error('Resend error (step2):', resendRes.status, errBody);
      return jsonResponse({ success: false, error: 'Email delivery failed', detail: errBody }, 500);
    }

    // Clean up draft record
    try {
      await env.DB.prepare(`DELETE FROM intake_drafts WHERE id = ?`).bind(submissionId).run();
    } catch (dbErr) {
      console.error('DB cleanup error:', dbErr?.message || dbErr);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('handleNpPaIntakeStep2 error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
}

function resolveSpecialty(fields) {
  const base = fields['Specialty / Certification'] || '';
  if (base === 'Other' && fields['Specialty Other Text']) {
    return `Other: ${fields['Specialty Other Text']}`;
  }
  return base || '—';
}

function buildStep2Summary(f) {
  const row = (label, val) =>
    `<tr><td style="padding:6px 12px;font-weight:600;color:#1e2530;background:#f2f4f6;width:38%;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${label}</td><td style="padding:6px 12px;color:#1e2530;font-family:sans-serif;font-size:13px;border-bottom:1px solid #ddd">${val || '—'}</td></tr>`;
  const section = (title) =>
    `<tr><td colspan="2" style="padding:10px 12px 4px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em;color:#1B6CA8;font-family:sans-serif;border-bottom:2px solid #1B6CA8">${title}</td></tr>`;

  return `
<div style="max-width:680px;margin:0 auto;font-family:sans-serif">
  <h2 style="color:#1B6CA8;margin-bottom:4px">NP / PA Application — MD-Match</h2>
  <p style="color:#555;font-size:13px">Submitted ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    ${section('Provider Information')}
    ${row('Full Name', f['Full Name'])}
    ${row('Email', f['Email'])}
    ${row('Phone', f['Phone'])}
    ${row('Provider Type', f['Provider Type'])}
    ${row('Specialty', f['Specialty'])}
    ${section('Collaboration & Practice')}
    ${row('States Needing Collaboration', f['States Needing Collaboration'])}
    ${row('Years of Experience', f['Years of Experience'])}
    ${row('Practice Setting', f['Practice Setting'])}
    ${row('Patient Population', f['Patient Population'])}
    ${row('Weekly Hours Per Week', f['Weekly Hours Per Week'])}
    ${f['Practice Site Address'] ? row('Practice Site Address', f['Practice Site Address']) : ''}
    ${row('Ideal Start Date', f['Ideal Start Date'])}
    ${row('First Patient Timeline', f['First Patient Timeline'])}
    ${section('Clinical Services')}
    ${row('Controlled Substances', f['Controlled Substances'])}
    ${f['Stimulants Frequency'] ? row('Stimulants (Frequency)', f['Stimulants Frequency']) : ''}
    ${f['Benzodiazepines Frequency'] ? row('Benzodiazepines (Frequency)', f['Benzodiazepines Frequency']) : ''}
    ${row('Buprenorphine / Suboxone', f['Buprenorphine / Suboxone'])}
    ${row('IV Ketamine', f['IV Ketamine'])}
    ${row('IM Ketamine', f['IM Ketamine'])}
    ${row('Intranasal Ketamine', f['Intranasal Ketamine'])}
    ${row('TMS Therapy', f['TMS'])}
    ${f['Family Medicine Services'] ? row('Family Medicine Services', f['Family Medicine Services']) : ''}
    ${f['Why Seeking Collaboration'] ? row('What Brought Them', f['Why Seeking Collaboration']) : ''}
    ${f['Why Switching'] ? row('Reason for Switching', f['Why Switching']) : ''}
    ${section('Background Screening')}
    ${row('Board Disciplinary Action', f['Board Action'])}
    ${f['Board Action'] === 'Yes' ? row('Board Action Details', f['Board Action Details']) : ''}
    ${row('License Suspension', f['License Suspension'])}
    ${f['License Suspension'] === 'Yes' ? row('License Suspension Details', f['License Suspension Details']) : ''}
    ${row('DEA Action', f['DEA Action'])}
    ${f['DEA Action'] === 'Yes' ? row('DEA Action Details', f['DEA Action Details']) : ''}
    ${row('Malpractice', f['Malpractice'])}
    ${f['Malpractice'] === 'Yes' ? row('Malpractice Details', f['Malpractice Details']) : ''}
    ${section('Additional Information')}
    ${row('Additional Notes', f['Additional Information'] || 'None provided')}
    ${f['Referred By'] ? row('Referred By', f['Referred By']) : ''}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">Word document attached · MD-Match.com</p>
</div>`;
}

function formatMonth(str) {
  if (!str) return '—';
  const [y, m] = str.split('-');
  if (!y || !m) return str;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

function formatDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  if (!y || !m || !d) return str;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
