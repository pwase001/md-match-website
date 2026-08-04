import { generateDocx, generatePhysicianDocx } from './docx-generator.js';
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

    if (request.method === 'POST' && url.pathname === '/physician-submit') {
      return handlePhysicianSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/physician-licensure-submit') {
      return handlePhysicianLicensureSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/send-licensure-email') {
      return handleSendLicensureEmail(request, env);
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
};

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
      'Stimulants Frequency': fields['Stimulants Frequency'] || '—',
      'Benzodiazepines Frequency': fields['Benzodiazepines Frequency'] || '—',
      'MAT Frequency': fields['MAT Frequency'] || '—',
      'esketamine': fields['esketamine'] || '—',
      'Esketamine Program Details': fields['Esketamine Program Details'] || '',
      'ketamine': fields['ketamine'] || '—',
      'IV IM Ketamine Program Details': fields['IV IM Ketamine Program Details'] || '',
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
      'Controlled Substances Comfort': comfortMap[fields['controlledSub']] || fields['controlledSub'] || '—',
      'Schedule II Signoff': comfortMap[fields['scheduleIISignoff']] || fields['scheduleIISignoff'] || '—',
      'IV Ketamine Comfort': comfortMap[fields['ketamineIV']] || fields['ketamineIV'] || '—',
      'IM Ketamine Comfort': comfortMap[fields['ketamineIM']] || fields['ketamineIM'] || '—',
      'Intranasal Ketamine Comfort': comfortMap[fields['ketamineIN']] || fields['ketamineIN'] || '—',
      'TMS Comfort': comfortMap[fields['tms']] || fields['tms'] || '—',
      'Credentialing Willingness': comfortMap[fields['credentialing']] || fields['credentialing'] || '—',
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

  return jsonResponse({ success: false, error: 'Not found' }, 404);
}

async function handleCreateCollaboration(request, env) {
  try {
    const { clientId, physicianId, totalAmountUsd, platformFeeUsd, startDate, notes } = await request.json();

    const totalAmountCents = Math.round(Number(totalAmountUsd) * 100);
    const platformFeeCents = Math.round(Number(platformFeeUsd || 200) * 100);
    if (!totalAmountCents || totalAmountCents <= platformFeeCents) {
      return jsonResponse({ success: false, error: 'Invalid amount' }, 400);
    }
    const applicationFeePercent = Math.round((platformFeeCents / totalAmountCents) * 100 * 10000) / 10000;

    const client = await db.getClient(env.DB, clientId);
    const physician = await db.getPhysician(env.DB, physicianId);
    if (!client || !physician) {
      return jsonResponse({ success: false, error: 'Client or physician not found' }, 404);
    }

    const collaboration = await db.createCollaboration(env.DB, {
      clientId, physicianId, totalAmountCents, platformFeeCents, applicationFeePercent, startDate, notes,
    });

    const stripe = stripeHelpers.getStripe(env);
    const origin = new URL(request.url).origin;

    // Ensure the physician has a Connect account and send them an onboarding link
    let stripeAccountId = physician.stripe_account_id;
    if (!stripeAccountId) {
      const account = await stripeHelpers.createPhysicianAccount(stripe, physician);
      stripeAccountId = account.id;
      await db.setPhysicianStripeAccountId(env.DB, physician.id, stripeAccountId);
    }
    const onboardToken = await tokens.createMagicToken(env, { pid: physician.id });
    const onboardStartUrl = `${origin}/physician-onboard/start?pid=${physician.id}&t=${encodeURIComponent(onboardToken)}`;
    await sendEmail(env, {
      to: [physician.email],
      from: 'MD-Match <noreply@md-match.com>',
      subject: 'Set Up Payouts — MD-Match Collaboration',
      html: `<p>Hi Dr. ${physician.full_name.split(' ').pop()},</p><p>You've been matched with a collaborating provider. To receive your monthly collaboration payment, please complete a short payout setup with our payment processor, Stripe:</p><p><a href="${onboardStartUrl}">${onboardStartUrl}</a></p><p>Warm regards,<br>MD-Match</p>`,
    });

    // Ensure the client has a Stripe Customer and send them a bank-link request
    let stripeCustomerId = client.stripe_customer_id;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripeHelpers.createOrGetCustomer(stripe, client);
      await db.setClientStripeCustomerId(env.DB, client.id, stripeCustomerId);
    }
    const bankToken = await tokens.createMagicToken(env, { cid: collaboration.id });
    const bankStartUrl = `${origin}/client/add-bank/start?collab=${collaboration.id}&t=${encodeURIComponent(bankToken)}`;
    await sendEmail(env, {
      to: [client.email],
      from: 'MD-Match <noreply@md-match.com>',
      subject: 'Set Up Payment — MD-Match Collaboration',
      html: `<p>Hi ${client.full_name},</p><p>To finalize your collaboration agreement, please connect your bank account for monthly ACH payment:</p><p><a href="${bankStartUrl}">${bankStartUrl}</a></p><p>Warm regards,<br>MD-Match</p>`,
    });

    return jsonResponse({ success: true, collaboration });
  } catch (err) {
    console.error('Create collaboration error:', err);
    return jsonResponse({ success: false, error: 'Server error' }, 500);
  }
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
    if (!collaboration.client_payment_method_ready) {
      return jsonResponse({ success: false, error: 'Client has not connected a bank account yet' }, 400);
    }

    const subscription = await stripeHelpers.createCollaborationSubscription(stripe, {
      customerId: client.stripe_customer_id,
      physicianAccountId: physician.stripe_account_id,
      totalAmountCents: collaboration.total_amount_cents,
      applicationFeePercent: collaboration.application_fee_percent,
      startDateISO: collaboration.start_date,
      description: `Collaboration services — ${physician.full_name}`,
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

async function sendEmail(env, { to, from, subject, html, attachments }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, attachments }),
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
    ${section('Clinical Preferences')}
    ${row('Controlled Substances Comfort', f['Controlled Substances Comfort'])}
    ${f['Controlled Substances Comfort'] !== 'No' ? row('Schedule II Signoff', f['Schedule II Signoff']) : ''}
    ${row('IV Ketamine Comfort', f['IV Ketamine Comfort'])}
    ${row('IM Ketamine Comfort', f['IM Ketamine Comfort'])}
    ${row('Intranasal Ketamine Comfort', f['Intranasal Ketamine Comfort'])}
    ${row('TMS Comfort', f['TMS Comfort'])}
    ${row('Credentialing Willingness', f['Credentialing Willingness'])}
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
    ${f['Controlled Substances'] === 'Yes' ? row('Stimulants (Schedule II)', f['Stimulants Frequency']) : ''}
    ${f['Controlled Substances'] === 'Yes' ? row('Benzodiazepines (Schedule IV)', f['Benzodiazepines Frequency']) : ''}
    ${f['Controlled Substances'] === 'Yes' ? row('MAT / Buprenorphine', f['MAT Frequency']) : ''}
    ${row('Esketamine (Intranasal)', f['esketamine'])}
    ${f['esketamine'] && f['esketamine'] !== 'No' ? row('Esketamine Details', f['Esketamine Program Details']) : ''}
    ${row('IV / IM Ketamine', f['ketamine'])}
    ${f['ketamine'] && f['ketamine'] !== 'No' ? row('IV/IM Ketamine Details', f['IV IM Ketamine Program Details']) : ''}
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

function formatDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  if (!y || !m || !d) return str;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
