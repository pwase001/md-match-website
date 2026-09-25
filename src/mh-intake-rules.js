// Mental health intake rules: which answers send a patient to a synchronous
// video visit (blue in the source document), and which add treatment
// considerations for the reviewing provider (green). Runs only on the server,
// so the criteria are not published alongside the patient-facing questions.

import {
  QUESTIONS,
  QUESTION_BY_ID,
  PHQ9,
  GAD7,
  TCAS,
  CURRENT_ANTIPSYCHOTICS,
  ANTICONVULSANTS,
  PREFERENCE_MEDS,
  has,
  ageFrom,
  bmiFrom,
  effectiveAnswers,
  patientMessages,
  isVisible,
} from '../mh-intake-questions.js';

export const MEDICATIONS = PREFERENCE_MEDS.map(([key, label]) => ({ key, label }));
const SNRIS = ['venlafaxine', 'duloxetine', 'desvenlafaxine'];

// Levels, strongest first. A medication's overall status is the strongest
// level any triggered recommendation gives it, except that "avoid" always wins
// and is reported as a conflict if something else also recommends it.
const LEVEL_RANK = { avoid: 0, caution: 1, first: 2, consider: 3 };

function labelOf(qid, value) {
  const q = QUESTION_BY_ID[qid];
  const opt = q && q.options && q.options.find((o) => o.value === value);
  return opt ? opt.label : value;
}

// Each rule: `when` answers → provider text, plus per-medication guidance.
// `source` is what the provider sees as the reason the rule fired.
const PROVIDER_RULES = [
  {
    when: (a, c) => c.age !== null && c.age > 65,
    source: (a, c) => `Age ${c.age}`,
    text: 'Patient is over 65: avoid Escitalopram above 10mg and Citalopram above 20mg daily.',
    meds: { escitalopram: ['caution', 'Max 10mg daily (age > 65)'], citalopram: ['caution', 'Max 20mg daily (age > 65)'] },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'panic'),
    source: () => 'Recurrent panic attacks',
    text: 'Avoid Bupropion. Consider Sertraline as 1st line treatment.',
    meds: { bupropion: ['avoid'], sertraline: ['first'] },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'ocd_symptoms'),
    source: () => 'Obsessive thoughts or compulsive behaviors',
    text: 'Consider Sertraline and Fluoxetine as first line options. Consider Paroxetine or Fluvoxamine if patient has failed multiple medications or has had a previous positive response.',
    meds: {
      sertraline: ['first'],
      fluoxetine: ['first'],
      paroxetine: ['consider', 'If failed multiple medications or prior positive response'],
      fluvoxamine: ['consider', 'If failed multiple medications or prior positive response'],
    },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'social_anxiety'),
    source: () => 'Social anxiety',
    text: 'Consider Sertraline as 1st line option. Venlafaxine ER and Paroxetine can also be considered if patient has failed multiple medications or has had a previous positive response.',
    meds: {
      sertraline: ['first'],
      venlafaxine: ['consider', 'If failed multiple medications or prior positive response'],
      paroxetine: ['consider', 'If failed multiple medications or prior positive response'],
    },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'generalized_worry'),
    source: () => 'Generalized worry',
    text: 'Consider Escitalopram as 1st line option.',
    meds: { escitalopram: ['first'] },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'premenstrual'),
    source: () => 'Premenstrual mood changes or anxiety',
    text: 'Consider Fluoxetine as 1st line and Sertraline as 2nd line.',
    meds: { fluoxetine: ['first'], sertraline: ['consider', '2nd line'] },
  },
  {
    when: (a) => has(a, 'chief_complaint', 'seasonal'),
    source: () => 'Seasonal depressive symptoms',
    text: 'Consider Bupropion XL if no contraindication.',
    meds: { bupropion: ['consider', 'XL, if no contraindication'] },
  },
  {
    when: (a) => a.bipolar_official === 'no',
    source: () => 'Reports a bipolar diagnosis that was unofficial or incorrect',
    text: 'Screen for any past manic or hypomanic episodes before starting an antidepressant.',
  },
  {
    when: (a) => has(a, 'psych_dx', 'bulimia'),
    source: () => 'Bulimia nervosa',
    text: 'Consider Fluoxetine as 1st line option if patient is eligible for treatment and has no other contraindications.',
    meds: { fluoxetine: ['first'] },
  },
  {
    when: (a, c) => Number(a.purge_count) >= 1 && !(c.bmi !== null && c.bmi < 18.5),
    source: (a) => `${a.purge_count} purging episode(s) in the past month`,
    text: 'Patient reports recent purging with a BMI of 18.5 or above. Review eating disorder severity before prescribing.',
  },
  {
    when: (a) => has(a, 'psych_dx', 'binge_eating'),
    source: () => 'Binge eating disorder',
    text: 'Consider Bupropion if no other contraindications, as this can potentially help reduce binge eating episodes.',
    meds: { bupropion: ['consider', 'May reduce binge eating episodes'] },
  },
  {
    when: (a) => has(a, 'medical', 'seizure'),
    source: () => 'Seizure disorder / epilepsy',
    text: 'Bupropion is contraindicated.',
    meds: { bupropion: ['avoid', 'Contraindicated'] },
  },
  {
    when: (a) => has(a, 'medical', 'liver'),
    source: () => 'Liver disease',
    text: 'Duloxetine is contraindicated. Medications may require dosage adjustment. Would recommend further diagnostic clarification on extent of liver disease.',
    meds: { duloxetine: ['avoid', 'Contraindicated'] },
  },
  {
    when: (a) => has(a, 'medical', 'kidney'),
    source: () => 'Kidney disease',
    text: 'Avoid Buspirone. Medications may require dosage adjustment. Would recommend further diagnostic clarification on extent of kidney disease.',
    meds: { buspirone: ['avoid'] },
  },
  {
    when: (a) => has(a, 'medical', 'heart'),
    source: () => 'Heart disease',
    text: 'Sertraline is preferred SSRI. Would recommend further diagnostic clarification on extent of heart disease.',
    meds: { sertraline: ['first', 'Preferred SSRI'] },
  },
  {
    when: (a) => has(a, 'medical', 'hypertension'),
    source: () => 'High blood pressure',
    text: 'Avoid SNRIs as 1st line option. If blood pressure is well controlled and patient has tried and failed SSRIs, an SNRI may be considered.',
    meds: Object.fromEntries(SNRIS.map((m) => [m, ['caution', 'Not 1st line; only if BP controlled and SSRIs failed']])),
  },
  {
    when: (a) => has(a, 'medical', 'bleeding'),
    source: () => 'Bleeding disorder',
    text: 'If prescribed SSRI/SNRI, please counsel patient using the “SSRI/SNRI bleeding risk” snippet (.bleeding) from the Mental Health Intake Snippets pdf.',
  },
  {
    when: (a) => a.pregnant === 'yes',
    source: () => 'Pregnant or trying to become pregnant',
    text: 'Please counsel patient using the “pregnancy risk” snippet (.preg) from the Mental Health Intake Snippets pdf PRIOR to prescribing. Would avoid Paxil, Fluoxetine, and Bupropion. Recommend Sertraline as 1st line treatment; Escitalopram or Citalopram as 2nd line.',
    meds: {
      paroxetine: ['avoid'],
      fluoxetine: ['avoid'],
      bupropion: ['avoid'],
      sertraline: ['first'],
      escitalopram: ['consider', '2nd line'],
      citalopram: ['consider', '2nd line'],
    },
  },
  {
    when: (a) => a.breastfeeding === 'yes',
    source: () => 'Breastfeeding',
    text: 'Please counsel patient using the “breastfeeding” snippet (.breast) from the Mental Health Intake Snippets pdf. Would avoid Paxil, Bupropion, and SNRIs. Recommend Sertraline as 1st line treatment, Escitalopram as 2nd line, and Fluoxetine and Citalopram as 3rd line. Would avoid Bupropion due to case reports of seizures.',
    meds: {
      paroxetine: ['avoid'],
      bupropion: ['avoid', 'Case reports of seizures'],
      ...Object.fromEntries(SNRIS.map((m) => [m, ['avoid']])),
      sertraline: ['first'],
      escitalopram: ['consider', '2nd line'],
      fluoxetine: ['consider', '3rd line'],
      citalopram: ['consider', '3rd line'],
    },
  },
  {
    when: (a) => has(a, 'other_meds', 'blood_thinners'),
    source: () => 'Blood thinners',
    text: 'If prescribed SSRI/SNRI, please counsel patient using the “SSRI/SNRI Blood Thinner Bleeding Risk” snippet (.bleed) from the Mental Health Intake Snippets pdf. Avoid Fluoxetine and Fluvoxamine as CYP 3A4 inhibition can significantly increase levels of these medications.',
    meds: { fluoxetine: ['avoid', 'CYP 3A4 inhibition'], fluvoxamine: ['avoid', 'CYP 3A4 inhibition'] },
  },
  {
    when: (a) => has(a, 'other_meds', 'nsaids'),
    source: () => 'NSAIDs',
    text: 'If prescribed SSRI/SNRI, please counsel patient using the “SSRI/SNRI NSAID Bleeding Risk” snippet (.nsaid) from the Mental Health Intake Snippets pdf.',
  },
  {
    when: (a) => has(a, 'other_meds', 'triptans'),
    source: () => 'Triptans',
    text: 'If prescribed SSRI/SNRI or Buspirone, please counsel patient using the “Triptan” snippet (.triptan) from the Mental Health Intake Snippets pdf.',
  },
  {
    when: (a) => has(a, 'other_meds', 'stimulants'),
    source: () => 'Stimulants',
    text: 'If prescribed SSRI, SNRI, or Buspirone, please counsel the patient using the stimulant risk 1 snippet (.stim1). If prescribed Bupropion, use the stimulant risk 2 snippet (.stim2). Both are in the Mental Health Intake Snippets pdf.',
  },
  {
    when: (a) => has(a, 'other_meds', 'beta_blockers'),
    source: () => 'Beta blockers',
    text: 'Sertraline is 1st line option. Avoid Bupropion, Fluoxetine, and Paroxetine, which are potent CYP 2D6 inhibitors that can significantly increase levels of beta blockers. Consider Escitalopram and Citalopram with caution due to increased concurrent risk of QTc prolongation. If an SNRI is chosen, would avoid Duloxetine as it has moderate CYP 2D6 inhibition.',
    meds: {
      sertraline: ['first'],
      bupropion: ['avoid', 'CYP 2D6 inhibitor'],
      fluoxetine: ['avoid', 'CYP 2D6 inhibitor'],
      paroxetine: ['avoid', 'CYP 2D6 inhibitor'],
      escitalopram: ['caution', 'QTc prolongation'],
      citalopram: ['caution', 'QTc prolongation'],
      duloxetine: ['avoid', 'Moderate CYP 2D6 inhibitor'],
    },
  },
  {
    when: (a) => has(a, 'other_meds', 'antiarrhythmics'),
    source: () => 'Antiarrhythmics',
    text: 'Sertraline is 1st line option. Avoid Escitalopram and Citalopram due to increased risk of QTc prolongation. Avoid Fluoxetine and Fluvoxamine as CYP 3A4 inhibition can significantly increase levels of these medications.',
    meds: {
      sertraline: ['first'],
      escitalopram: ['avoid', 'QTc prolongation'],
      citalopram: ['avoid', 'QTc prolongation'],
      fluoxetine: ['avoid', 'CYP 3A4 inhibition'],
      fluvoxamine: ['avoid', 'CYP 3A4 inhibition'],
    },
  },
  {
    when: (a) => has(a, 'other_meds', 'hydroxychloroquine'),
    source: () => 'Hydroxychloroquine',
    text: 'Sertraline is 1st line option. Avoid Escitalopram and Citalopram due to increased risk of QTc prolongation.',
    meds: { sertraline: ['first'], escitalopram: ['avoid', 'QTc prolongation'], citalopram: ['avoid', 'QTc prolongation'] },
  },
  {
    when: (a) => has(a, 'other_meds', 'diuretics'),
    source: () => 'Diuretics',
    text: 'Avoid Escitalopram and Citalopram due to increased risk of QTc prolongation.',
    meds: { escitalopram: ['avoid', 'QTc prolongation'], citalopram: ['avoid', 'QTc prolongation'] },
  },
  {
    when: (a) => has(a, 'other_meds', 'tamoxifen'),
    source: () => 'Tamoxifen',
    text: 'Avoid Fluoxetine, Fluvoxamine, and Bupropion as they can decrease active metabolite Tamoxifen levels.',
    meds: { fluoxetine: ['avoid', 'Lowers active tamoxifen metabolite'], fluvoxamine: ['avoid', 'Lowers active tamoxifen metabolite'], bupropion: ['avoid', 'Lowers active tamoxifen metabolite'] },
  },
  {
    when: (a) => has(a, 'other_meds', 'finasteride'),
    source: () => 'Finasteride',
    text: 'Patient was advised that finasteride can cause new or worsening depression and to discuss alternatives (including topical) with their prescriber.',
  },
];

// Safety follow-ups can come from either copy of the block (see safetyBlock in
// mh-intake-questions.js).
function safetyAnswer(a, key) {
  return a[`sa_${key}`] ?? a[`sb_${key}`];
}

function safetyRecommendations(a) {
  const out = [];
  const triggered = a.self_harm === 'yes' || Number(a.phq9_9) >= 1;
  if (triggered) {
    const plan = safetyAnswer(a, 'plan');
    const source = a.self_harm === 'yes' ? 'Current thoughts of self-harm' : `PHQ-9 item 9 = ${a.phq9_9}`;
    if (plan === 'yes') {
      out.push({
        source,
        urgent: true,
        text: 'Plan AND intent to self-harm reported. Please engage the suicide safety protocol and send an email to the mental health clinical lead with subject line “suicide risk patient”, including the patient ID (see Suicide Safety Guidelines). An automatic alert was also sent when the patient answered.',
      });
    } else if (plan === 'no') {
      out.push({
        source,
        text: 'Please use the “suicide safety” snippet (.safe) from the Suicide Safety Snippets pdf to reach out to the patient PRIOR to prescribing a medication. If patient confirms safety, use the “safety confirmed” snippet (.prompt) and proceed to treatment planning. If patient does not confirm safety, proceed to next steps in the suicide safety protocol and email the mental health clinical lead with subject line “suicide risk patient”, including the patient ID.',
      });
    }
  }
  if (a.harm_others === 'yes') {
    if (a.harm_others_plan === 'yes') {
      out.push({
        source: 'Plan and intent to harm others',
        urgent: true,
        text: 'Please go to the Suicide Safety Guidelines and complete the Acute Homicide Risk Protocol. An automatic alert was also sent when the patient answered.',
      });
    } else if (a.harm_others_plan === 'no') {
      out.push({
        source: 'Thoughts of harming others (no plan or intent)',
        text: 'Please use the “homicidal safety” snippet (.harm) from the Suicide Safety Snippets pdf to reach out to the patient PRIOR to completing the intake.',
      });
    }
  }
  return out;
}

function referralReasons(a, c) {
  const r = [];
  const add = (cond, reason) => cond && r.push(reason);
  const lowBmi = c.bmi !== null && c.bmi < 18.5;

  add(c.age !== null && c.age < 18, `Under 18 (age ${c.age})`);
  add(lowBmi && has(a, 'psych_dx', 'anorexia'), `Anorexia nervosa with BMI ${c.bmi}`);
  add(lowBmi && has(a, 'psych_dx', 'bulimia'), `Bulimia nervosa with BMI ${c.bmi}`);
  add(lowBmi && Number(a.purge_count) >= 1, `BMI ${c.bmi} with ${a.purge_count} purging episode(s) in the past month`);
  add(a.bipolar_official === 'yes', 'Officially diagnosed bipolar disorder');
  add(has(a, 'psych_dx', 'psychosis'), 'History of psychosis');
  add(has(a, 'psych_dx', 'schizophrenia'), 'Schizophrenia');
  add(a.hospitalized_recent === 'yes', 'Psychiatric hospitalization within the last 3 years');
  add(a.suicide_attempt_recent === 'yes', 'Suicide attempt within the last 3 years');
  add(a.harm_others_plan === 'yes', 'Plan and intent to harm others');

  for (const [key, label, mg] of TCAS) add(a[`current_tca_${key}_high`] === 'yes', `${label} above ${mg}mg`);
  for (const [key, label] of CURRENT_ANTIPSYCHOTICS) {
    if (key === 'seroquel' || !has(a, 'current_ap', key)) continue;
    r.push(`Currently taking ${label}`);
  }
  add(a.seroquel_insomnia === 'no', 'Currently taking Seroquel for a reason other than insomnia');
  add(a.seroquel_low_dose === 'no', 'Currently taking Seroquel above 200mg');
  add(has(a, 'current_ms', 'lithium'), 'Currently taking lithium');
  for (const [key, label] of ANTICONVULSANTS) add(a[`current_ms_${key}_use`] === 'mood', `Currently taking ${label} as a mood stabilizer`);

  for (const [key, label] of CURRENT_ANTIPSYCHOTICS) add(a[`prev_ap_${key}_bp`] === 'yes', `Previously took ${label} for bipolar or psychotic disorder`);
  add(has(a, 'prev_ms', 'lithium'), 'Previously took lithium');
  for (const [key, label] of ANTICONVULSANTS) add(a[`prev_ms_${key}_mood`] === 'yes', `Previously took ${label} as a mood stabilizer`);
  add(a.four_plus_meds === 'yes', 'Tried 4 or more mental health medications');
  add(a.tms_continue === 'no', 'Prior TMS; chose not to continue asynchronous evaluation');
  add(a.ect === 'yes', 'Prior ECT');
  add(a.ketamine_continue === 'no', 'Prior ketamine/Spravato; chose not to continue asynchronous evaluation');

  add(a.glaucoma_iridotomy === 'no', 'Narrow-angle glaucoma without iridotomy');
  add(has(a, 'medical', 'serotonin_syndrome'), 'History of serotonin syndrome');
  add(has(a, 'medical', 'hyponatremia'), 'History of hyponatremia');
  add(has(a, 'medical', 'long_qt'), 'History of prolonged QTc syndrome');

  add(has(a, 'other_meds', 'methadone'), 'Taking methadone');
  add(has(a, 'other_meds', 'tramadol'), 'Taking tramadol');
  add(has(a, 'other_meds', 'methylene_blue'), 'Taking methylene blue');
  add(a.st_johns_stop === 'no', "Unwilling to stop St. John's Wort");

  add(a.alcohol === '26_30' && a.sex === 'female', '26–30 alcoholic drinks per week (female)');
  add(a.alcohol === '31_plus', '31+ alcoholic drinks per week');
  add(a.cocaine_count === 'gt2', 'Cocaine use more than 2 times in the past 6 months');
  add(a.cocaine_stop === 'no', 'Unwilling to stop cocaine use');
  add(has(a, 'substances', 'mdma'), 'Ecstasy (MDMA) use in the past 6 months');
  add(has(a, 'substances', 'meth'), 'Methamphetamine or illicit stimulant use in the past 6 months');
  add(has(a, 'substances', 'opioids'), 'Recreational opioid use in the past 6 months');
  add(a.hallucinogens_stop === 'no', 'Unwilling to stop hallucinogens');
  add(a.kratom_stop === 'no', 'Unwilling to stop kratom');
  add(a.rx_stimulants_stop === 'no', 'Unwilling to stop non-prescribed stimulants');
  add(a.benzos_stop === 'no', 'Unwilling to stop non-prescribed benzodiazepines');
  return r;
}

function severity(score, cuts) {
  for (const [min, label] of cuts) if (score >= min) return label;
  return cuts[cuts.length - 1][1];
}

function scores(a) {
  const sum = (items) => items.reduce((t, [id]) => t + (Number(a[id]) || 0), 0);
  const complete = (items) => items.every(([id]) => a[id] !== undefined && a[id] !== '');
  const phq9 = sum(PHQ9);
  const gad7 = sum(GAD7);
  return {
    phq9: {
      score: phq9,
      complete: complete(PHQ9),
      severity: severity(phq9, [[20, 'Severe'], [15, 'Moderately severe'], [10, 'Moderate'], [5, 'Mild'], [0, 'Minimal']]),
    },
    gad7: {
      score: gad7,
      complete: complete(GAD7),
      severity: severity(gad7, [[15, 'Severe'], [10, 'Moderate'], [5, 'Mild'], [0, 'Minimal']]),
    },
  };
}

function freeTextFlags(a) {
  const flags = [];
  const f = (id, label) => a[id] && String(a[id]).trim() && flags.push({ label, text: String(a[id]).trim() });
  f('chief_complaint_other', 'Other reason for seeking treatment');
  f('psych_dx_other', 'Other psychiatric condition');
  f('medical_other', 'Other medical condition');
  f('med_interest_other', 'Other medication of interest');
  f('additional_text', 'Patient note to provider');
  for (const [key, label] of ANTICONVULSANTS) {
    if (a[`current_ms_${key}_use`] === 'other') flags.push({ label: `${label} use`, text: 'Patient selected "Something else" — clarify indication.' });
  }
  return flags;
}

function medicationGuidance(recs, a) {
  const table = Object.fromEntries(MEDICATIONS.map((m) => [m.key, { ...m, entries: [] }]));
  for (const rec of recs) {
    for (const [med, [level, note]] of Object.entries(rec.meds || {})) {
      table[med].entries.push({ level, note: note || '', source: rec.source });
    }
  }
  return MEDICATIONS.map(({ key }) => {
    const row = table[key];
    const levels = row.entries.map((e) => e.level);
    let status = null;
    if (levels.length) status = levels.slice().sort((x, y) => LEVEL_RANK[x] - LEVEL_RANK[y])[0];
    const conflict = levels.includes('avoid') && levels.some((l) => l === 'first' || l === 'consider');
    const familyResponse = has(a, 'family_response', key);
    const patientInterest = has(a, 'med_interest', key);
    return {
      key,
      label: row.label,
      status,
      conflict,
      interestConflict: patientInterest && status === 'avoid',
      familyResponse,
      patientInterest,
      entries: row.entries,
    };
  });
}

// Full evaluation of a set of answers. Used at submission, when the result is
// stored with the intake as the record the provider reviews.
export function evaluate(rawAnswers, now = new Date()) {
  const a = effectiveAnswers(rawAnswers);
  const c = { age: ageFrom(a.dob, now), bmi: bmiFrom(a) };

  const recs = [];
  for (const rule of PROVIDER_RULES) {
    if (!rule.when(a, c)) continue;
    recs.push({ source: rule.source(a, c), text: rule.text, meds: rule.meds });
  }
  const safety = safetyRecommendations(a);
  const referral = referralReasons(a, c);

  const messagesShown = [];
  for (const q of QUESTIONS) {
    if (!isVisible(q, a)) continue;
    for (const m of patientMessages(q, a)) messagesShown.push({ question: q.prompt, kind: m.kind || 'info', text: m.text });
  }

  return {
    age: c.age,
    bmi: c.bmi,
    outcome: referral.length ? 'video_visit' : 'async',
    referralReasons: referral,
    safety,
    recommendations: recs.map(({ source, text }) => ({ source, text })),
    medicationGuidance: medicationGuidance(recs, a),
    scores: scores(a),
    freeText: freeTextFlags(a),
    messagesShown,
  };
}

// The urgent alerts, checked on every saved answer so the clinical lead hears
// about them while the patient is still in the intake, not when a provider
// eventually opens it.
export function urgentAlerts(rawAnswers) {
  const a = effectiveAnswers(rawAnswers);
  const alerts = [];
  if ((a.self_harm === 'yes' || Number(a.phq9_9) >= 1) && safetyAnswer(a, 'plan') === 'yes') {
    alerts.push({ kind: 'suicide', subject: 'Suicide risk patient', detail: 'Patient reported a current plan AND intent to harm themselves.' });
  }
  if (a.harm_others === 'yes' && a.harm_others_plan === 'yes') {
    alerts.push({ kind: 'homicide', subject: 'Homicide risk patient', detail: 'Patient reported specific plans AND intent to harm someone.' });
  }
  return alerts;
}

// Human-readable answers for the provider, in question order, restricted to
// what the patient could see.
export function answerTranscript(rawAnswers) {
  const a = effectiveAnswers(rawAnswers);
  const out = [];
  for (const q of QUESTIONS) {
    if (q.type === 'info' || !(q.id in a)) continue;
    const v = a[q.id];
    let text;
    if (q.type === 'multi') text = v.map((x) => labelOf(q.id, x)).join('; ');
    else if (q.type === 'single') text = labelOf(q.id, v);
    else if (q.type === 'height') text = `${v.ft || 0} ft ${v.in || 0} in`;
    else if (q.type === 'number' && q.unit) text = `${v} ${q.unit}`;
    else if (q.type === 'medlist') {
      const rows = (v || []).filter((r) => r && String(r.name || '').trim());
      text = rows.length ? rows.map((r) => q.columns.map((col) => r[col.key] || '—').join(' · ')).join('\n') : 'None listed';
    } else if (q.type === 'consent') text = v.agree ? `Agreed and signed “${v.signature}” on ${v.signedAt || ''}`.trim() : 'Not agreed';
    else text = String(v);
    out.push({ id: q.id, section: q.section, question: q.lead ? `${q.lead} ${q.prompt}` : q.prompt, answer: text });
  }
  return out;
}
