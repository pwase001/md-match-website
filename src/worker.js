import { generateDocx, generatePhysicianDocx } from './docx-generator.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/np-pa-submit') {
      return handleNpPaSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/physician-submit') {
      return handlePhysicianSubmit(request, env);
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
      'Ideal Start Date': formatDate(fields['Ideal Start Date']),
      'Additional Information': fields['Anything Else We Should Know'] || '—',
      'How Did You Hear About MD-Match': fields['How Did You Hear About MD-Match'] || '—',
      'Referred By': fields['Referred By'] || '',
    };

    const providerName = f['Full Name'] !== '—' ? f['Full Name'] : 'Unknown';

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
      to: ['philipwasef@md-match.com'],
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
      to: ['philipwasef@md-match.com'],
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
