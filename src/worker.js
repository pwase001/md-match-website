import { generateDocx } from './docx-generator.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/np-pa-submit') {
      return handleNpPaSubmit(request, env);
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

    const providerName = fields['Full Name'] || 'Unknown';

    // Generate Word document
    let docxResult;
    try {
      docxResult = await generateDocx(fields);
    } catch (docxErr) {
      console.error('DOCX generation error:', docxErr?.message || docxErr);
      return jsonResponse({ success: false, error: 'Document generation failed' }, 500);
    }
    const base64Docx = docxResult.base64;
    const filename = `NP-PA-Profile-${providerName.replace(/[^a-zA-Z0-9]/g, '-')}.docx`;

    // Build plain-text summary for email body
    const summary = buildSummary(fields);

    // Send via Resend
    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY secret is not set');
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    const resendPayload = {
      from: 'MD-Match Intake <noreply@md-match.com>',
      to: ['philipwasef@md-match.com'],
      reply_to: fields['Email'] || undefined,
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
    ${row('Medical Degree', f['Medical Degree'])}
    ${row('Specialty', f['Specialty'])}
    ${row('Years of Experience', f['Years of Clinical Experience'])}
    ${section('Collaboration & Licensure')}
    ${row('States Needing Collaboration', f['States Needing Collaboration'])}
    ${row('DEA States', f['DEA States'])}
    ${section('Practice Details')}
    ${row('Patient Setting', f['Patient Setting'])}
    ${row('Practice Setting', f['Practice Setting'])}
    ${row('Patient Population', f['Patient Population'])}
    ${row('Weekly Hours', f['Weekly Hours'])}
    ${section('Clinical Services')}
    ${row('Controlled Substances', f['Controlled Schedule'])}
    ${row('Esketamine (Intranasal)', f['esketamine'])}
    ${f['esketamine'] && f['esketamine'] !== 'No' ? row('Esketamine Details', f['Esketamine Program Details']) : ''}
    ${row('IV / IM Ketamine', f['ketamine'])}
    ${f['ketamine'] && f['ketamine'] !== 'No' ? row('IV/IM Ketamine Details', f['IV IM Ketamine Program Details']) : ''}
    ${row('TMS', f['TMS'])}
    ${row('Additional Information', f['Additional Information'])}
    ${section('Referral')}
    ${row('How Did You Hear About Us', f['How Did You Hear About MD-Match'])}
    ${f['Referred By'] ? row('Referred By', f['Referred By']) : ''}
  </table>
  <p style="color:#aaa;font-size:11px;margin-top:24px">Word document attached · MD-Match.com</p>
</div>`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
