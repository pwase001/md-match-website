// Mental health intake: every question, the order it is asked in, when it is
// shown, and the messages the patient sees in response (red in the source
// document). Loaded by the patient page and by the worker, which re-derives
// which questions were visible so it never scores an answer the patient could
// not see.
//
// Referral rules and provider recommendations (blue and green in the source
// document) live in src/mh-intake-rules.js, which is not published.

export const has = (a, id, v) => (Array.isArray(a[id]) ? a[id].includes(v) : a[id] === v);

const YES_NO = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];

export function ageFrom(dob, now = new Date()) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

export function bmiFrom(a) {
  const h = a.height;
  const lb = Number(a.weight);
  if (!h || !lb) return null;
  const inches = Number(h.ft || 0) * 12 + Number(h.in || 0);
  if (!inches) return null;
  return Math.round(((703 * lb) / (inches * inches)) * 10) / 10;
}

export const PHQ9 = [
  ['phq9_1', 'Little interest or pleasure in doing things'],
  ['phq9_2', 'Feeling down, depressed, or hopeless'],
  ['phq9_3', 'Trouble falling or staying asleep, or sleeping too much'],
  ['phq9_4', 'Feeling tired or having little energy'],
  ['phq9_5', 'Poor appetite or overeating'],
  ['phq9_6', "Feeling bad about yourself, or that you're a failure or have let yourself or your family down"],
  ['phq9_7', 'Trouble concentrating on things'],
  ['phq9_8', 'Moving or speaking slowly, or being so fidgety or restless that you move around more than usual'],
  ['phq9_9', 'Thoughts that you would be better off dead, or of hurting yourself in some way'],
];

export const GAD7 = [
  ['gad7_1', 'Feeling nervous, anxious, or on edge'],
  ['gad7_2', 'Not being able to stop or control worrying'],
  ['gad7_3', 'Worrying too much about different things'],
  ['gad7_4', 'Trouble relaxing'],
  ['gad7_5', "Being so restless that it's hard to sit still"],
  ['gad7_6', 'Becoming easily annoyed or irritable'],
  ['gad7_7', 'Feeling afraid, as if something awful might happen'],
];

const FREQUENCY = [
  { value: '0', label: 'Not at all' },
  { value: '1', label: 'Several days' },
  { value: '2', label: 'More than half the days' },
  { value: '3', label: 'Nearly every day' },
];

export const CURRENT_ANTIPSYCHOTICS = [
  ['abilify', 'Abilify (aripiprazole)'],
  ['risperdal', 'Risperdal (risperidone)'],
  ['latuda', 'Latuda (lurasidone)'],
  ['caplyta', 'Caplyta (lumateperone)'],
  ['rexulti', 'Rexulti (brexpiprazole)'],
  ['vraylar', 'Vraylar (cariprazine)'],
  ['invega', 'Invega (paliperidone)'],
  ['zyprexa', 'Zyprexa (olanzapine)'],
  ['clozaril', 'Clozaril (clozapine)'],
  ['geodon', 'Geodon (ziprasidone)'],
  ['haldol', 'Haldol (haloperidol)'],
  ['thorazine', 'Thorazine (chlorpromazine)'],
  ['seroquel', 'Seroquel (quetiapine)'],
];

export const ANTICONVULSANTS = [
  ['depakote', 'Depakote (divalproex sodium)'],
  ['lamictal', 'Lamictal (lamotrigine)'],
  ['tegretol', 'Tegretol (carbamazepine)'],
  ['trileptal', 'Trileptal (oxcarbazepine)'],
];

export const TCAS = [
  ['amitriptyline', 'Amitriptyline', 25],
  ['nortriptyline', 'Nortriptyline', 25],
  ['doxepin', 'Doxepin', 10],
];

export const PREFERENCE_MEDS = [
  ['escitalopram', 'Escitalopram (Lexapro)'],
  ['sertraline', 'Sertraline (Zoloft)'],
  ['fluoxetine', 'Fluoxetine (Prozac)'],
  ['citalopram', 'Citalopram (Celexa)'],
  ['fluvoxamine', 'Fluvoxamine (Luvox)'],
  ['paroxetine', 'Paroxetine (Paxil)'],
  ['venlafaxine', 'Venlafaxine ER (Effexor XR)'],
  ['duloxetine', 'Duloxetine (Cymbalta)'],
  ['desvenlafaxine', 'Desvenlafaxine (Pristiq)'],
  ['bupropion', 'Bupropion (Wellbutrin)'],
  ['buspirone', 'Buspirone (Buspar)'],
];

const TRD_NOTICE = (what) =>
  `${what} is typically used for treatment-resistant depression, which is a condition that is not treated on this platform. If you have been diagnosed with treatment-resistant depression, we recommend a higher level of care with either an in-person provider or a more in-depth virtual platform that has more treatment options for this condition. Would you like to continue being evaluated for treatment on this platform?`;

const ALCOHOL_MESSAGE =
  'Excessive alcohol intake can worsen both depression and anxiety. It can also interfere with the effectiveness of medication, since alcohol is a chemical depressant, and it can make side effects more likely. For patients experiencing clinical levels of depressive and anxiety symptoms, we do not recommend drinking more than 3 standard drinks on any particular day or 14 standard drinks per week.';

export const CRISIS_MESSAGE =
  'If you are in immediate danger or might act on these thoughts, call 911 or go to the nearest emergency room now. You can also call or text 988 (the Suicide & Crisis Lifeline) any time, day or night. This intake is reviewed later, not in real time, so please do not wait for us to contact you.';

// The four follow-ups asked when someone reports thoughts of harming
// themselves. They appear twice: once after the direct question, and again
// after PHQ-9 item 9 for someone who answered "No" directly but then reported
// thoughts of being better off dead. Answers from either copy count the same.
function safetyBlock(prefix, showIf) {
  return [
    {
      id: `${prefix}_intro`,
      type: 'info',
      section: 'Current Safety Assessment',
      prompt: 'Thank you for telling us. We would like to ask a few more questions so your provider can understand how you are doing.',
      showIf,
    },
    {
      id: `${prefix}_dead`,
      type: 'single',
      section: 'Current Safety Assessment',
      prompt: 'In the past week, have you had thoughts that you would be better off dead?',
      options: YES_NO,
      showIf,
    },
    {
      id: `${prefix}_kill`,
      type: 'single',
      section: 'Current Safety Assessment',
      prompt: 'In the past week, have you had thoughts about killing yourself?',
      options: YES_NO,
      showIf,
      messages: [{ when: (a) => a[`${prefix}_kill`] === 'yes', kind: 'crisis', text: CRISIS_MESSAGE }],
    },
    {
      id: `${prefix}_attempt_detail`,
      type: 'textarea',
      section: 'Current Safety Assessment',
      prompt: 'Earlier you told us you have attempted suicide. When was this, and how?',
      showIf: (a) => showIf(a) && a.suicide_attempt === 'yes',
    },
    {
      id: `${prefix}_plan`,
      type: 'single',
      section: 'Current Safety Assessment',
      prompt: 'Do you have any current plan AND intent to harm yourself?',
      options: YES_NO,
      showIf,
      messages: [{ when: (a) => a[`${prefix}_plan`] === 'yes', kind: 'crisis', text: CRISIS_MESSAGE }],
    },
  ];
}

const selfHarmDirect = (a) => a.self_harm === 'yes';
const selfHarmFromPhq = (a) => a.self_harm === 'no' && Number(a.phq9_9) >= 1;

export const QUESTIONS = [
  // ---------------------------------------------------------------- Personal
  { id: 'full_name', type: 'text', section: 'Personal Information', prompt: 'What is your full legal name?', autocomplete: 'name' },
  { id: 'dob', type: 'date', section: 'Personal Information', prompt: 'What is your date of birth?' },
  {
    id: 'sex',
    type: 'single',
    section: 'Personal Information',
    prompt: 'What is your biological sex?',
    help: 'This is used for medication safety, such as dosing and pregnancy considerations.',
    options: [
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
    ],
  },
  { id: 'height', type: 'height', section: 'Personal Information', prompt: 'What is your height?' },
  { id: 'weight', type: 'number', section: 'Personal Information', prompt: 'What is your weight?', unit: 'lbs', min: 50, max: 800 },
  { id: 'address', type: 'textarea', section: 'Personal Information', prompt: 'What is your home address?', autocomplete: 'street-address' },
  { id: 'email', type: 'email', section: 'Personal Information', prompt: 'What is your email address?', autocomplete: 'email' },
  { id: 'phone', type: 'tel', section: 'Personal Information', prompt: 'What is the best phone number to reach you?', autocomplete: 'tel' },

  // --------------------------------------------------------- Chief complaint
  {
    id: 'chief_complaint',
    type: 'multi',
    section: 'Chief Complaint',
    prompt: 'What brings you to seek mental health treatment today?',
    help: 'Select all that apply.',
    options: [
      { value: 'depression', label: 'Depression' },
      { value: 'anxiety', label: 'Anxiety' },
      { value: 'panic', label: 'Recurrent panic attacks' },
      { value: 'ocd_symptoms', label: 'Obsessive thoughts or compulsive behaviors' },
      { value: 'social_anxiety', label: 'Social anxiety' },
      { value: 'generalized_worry', label: 'Generalized worry' },
      { value: 'premenstrual', label: 'Premenstrual mood changes or anxiety' },
      { value: 'seasonal', label: 'Seasonal depressive symptoms' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'chief_complaint_other',
    type: 'text',
    section: 'Chief Complaint',
    prompt: 'Please describe what else brings you in.',
    showIf: (a) => has(a, 'chief_complaint', 'other'),
  },
  {
    id: 'symptom_duration',
    type: 'single',
    section: 'Chief Complaint',
    prompt: 'How long have you been experiencing these symptoms?',
    options: [
      { value: 'lt2w', label: 'Less than 2 weeks' },
      { value: '2w_1m', label: '2 weeks to 1 month' },
      { value: '1_3m', label: '1–3 months' },
      { value: '3_6m', label: '3–6 months' },
      { value: '6m_1y', label: '6 months to 1 year' },
      { value: 'gt1y', label: 'More than 1 year' },
    ],
  },

  // ------------------------------------------------------ Psychiatric history
  {
    id: 'psych_dx',
    type: 'multi',
    section: 'Psychiatric History',
    prompt: 'Have you ever been told you have, or been diagnosed with, any of the following conditions?',
    help: 'Select all that apply.',
    options: [
      { value: 'bipolar', label: 'Bipolar disorder' },
      { value: 'psychosis', label: 'Psychosis' },
      { value: 'schizophrenia', label: 'Schizophrenia' },
      { value: 'ptsd', label: 'PTSD (post-traumatic stress disorder)' },
      { value: 'ocd', label: 'OCD (obsessive-compulsive disorder)' },
      { value: 'bpd', label: 'Borderline personality disorder' },
      { value: 'anorexia', label: 'Anorexia nervosa' },
      { value: 'bulimia', label: 'Bulimia nervosa' },
      { value: 'binge_eating', label: 'Binge eating disorder' },
      { value: 'other', label: 'Other' },
      { value: 'none', label: 'None of the above', exclusive: true },
    ],
    messages: [
      {
        when: (a) => has(a, 'psych_dx', 'ptsd'),
        text: 'Please keep in mind that this platform cannot officially diagnose or treat PTSD. However, many of the SSRI and SNRI medications that we use to treat depression and anxiety are also FDA approved and helpful at treating PTSD symptoms. PTSD can certainly get much better with the treatment we provide. In addition to medication, we would recommend evidence-based, trauma-focused psychotherapy for PTSD, such as PE, CPT, or EMDR.',
      },
      {
        when: (a) => has(a, 'psych_dx', 'ocd'),
        text: 'Please keep in mind that this platform cannot officially diagnose or treat OCD. However, many of the SSRI and SNRI medications that we use to treat depression and anxiety are also FDA approved and helpful at treating OCD symptoms. OCD can certainly get much better with the treatment we provide.',
      },
      {
        when: (a) => has(a, 'psych_dx', 'bpd'),
        text: 'Borderline personality disorder (BPD) is a psychological condition that develops from a young age over the course of several years. It requires a more in-depth evaluation with an in-person psychiatrist for a definitive diagnosis. It is associated with rapid mood swings, anger outbursts, feelings of emptiness, and impulsivity. There are no medications that treat BPD itself, and the primary treatment is psychotherapy; a specific form called Dialectical Behavior Therapy (DBT) is most helpful. SSRI and SNRI medications can still help people with BPD by treating co-occurring symptoms like depression, anxiety, and irritability.',
      },
    ],
  },
  {
    id: 'psych_dx_other',
    type: 'text',
    section: 'Psychiatric History',
    prompt: 'What other condition have you been told you have?',
    showIf: (a) => has(a, 'psych_dx', 'other'),
  },
  {
    id: 'bipolar_official',
    type: 'single',
    section: 'Psychiatric History',
    prompt: 'Was your bipolar disorder an official diagnosis?',
    options: [
      { value: 'yes', label: 'Yes, this was officially diagnosed' },
      { value: 'no', label: 'No, this was never officially diagnosed, or it was an incorrect diagnosis' },
    ],
    showIf: (a) => has(a, 'psych_dx', 'bipolar'),
  },
  {
    id: 'purge_count',
    type: 'number',
    section: 'Psychiatric History',
    prompt: 'In the past month, how many times have you purged (for example by vomiting or using laxatives)?',
    help: 'Enter 0 if none.',
    min: 0,
    max: 1000,
    showIf: (a) => has(a, 'psych_dx', 'anorexia') || has(a, 'psych_dx', 'bulimia'),
  },
  { id: 'hospitalized', type: 'single', section: 'Psychiatric History', prompt: 'Have you ever been hospitalized for psychiatric reasons?', options: YES_NO },
  {
    id: 'hospitalized_recent',
    type: 'single',
    section: 'Psychiatric History',
    prompt: 'Was your most recent psychiatric hospitalization within the last 3 years?',
    options: YES_NO,
    showIf: (a) => a.hospitalized === 'yes',
  },
  { id: 'suicide_attempt', type: 'single', section: 'Psychiatric History', prompt: 'Have you ever attempted suicide?', options: YES_NO },
  {
    id: 'suicide_attempt_recent',
    type: 'single',
    section: 'Psychiatric History',
    prompt: 'Was your most recent suicide attempt within the last 3 years?',
    options: YES_NO,
    showIf: (a) => a.suicide_attempt === 'yes',
  },

  // ------------------------------------------------------------------ Safety
  { id: 'self_harm', type: 'single', section: 'Current Safety Assessment', prompt: 'Are you currently having thoughts of harming yourself?', options: YES_NO },
  ...safetyBlock('sa', selfHarmDirect),
  { id: 'harm_others', type: 'single', section: 'Current Safety Assessment', prompt: 'Are you currently having thoughts of harming others?', options: YES_NO },
  {
    id: 'harm_others_plan',
    type: 'single',
    section: 'Current Safety Assessment',
    prompt: 'Do you have any specific plans AND intent to harm anyone at this time?',
    options: YES_NO,
    showIf: (a) => a.harm_others === 'yes',
    messages: [
      {
        when: (a) => a.harm_others_plan === 'yes',
        kind: 'crisis',
        text: 'If you feel you might act on these thoughts, please call 911 or go to the nearest emergency room now. You can also call or text 988 any time, day or night. This intake is reviewed later, not in real time, so please do not wait for us to contact you.',
      },
    ],
  },

  // ------------------------------------------- Current mental health treatment
  { id: 'therapist', type: 'single', section: 'Current Mental Health Treatment', prompt: 'Are you currently seeing a therapist or counselor?', options: YES_NO },
  {
    id: 'current_tca',
    type: 'multi',
    section: 'Current Mental Health Treatment',
    prompt: 'Are you currently taking any of the following medications?',
    help: 'Select all that apply.',
    options: [...TCAS.map(([value, label]) => ({ value, label })), { value: 'none', label: 'I am not taking any of these medications', exclusive: true }],
  },
  ...TCAS.map(([key, label, mg]) => ({
    id: `current_tca_${key}_high`,
    type: 'single',
    section: 'Current Mental Health Treatment',
    prompt: `Is your ${label} being prescribed at a dose greater than ${mg}mg?`,
    options: YES_NO,
    showIf: (a) => has(a, 'current_tca', key),
  })),
  {
    id: 'current_ap',
    type: 'multi',
    section: 'Current Mental Health Treatment',
    prompt: 'Are you currently taking any of the following antipsychotic medications?',
    help: 'Select all that apply.',
    options: [
      ...CURRENT_ANTIPSYCHOTICS.map(([value, label]) => ({ value, label })),
      { value: 'none', label: 'I am not taking any of these medications', exclusive: true },
    ],
  },
  {
    id: 'seroquel_insomnia',
    type: 'single',
    section: 'Current Mental Health Treatment',
    prompt: 'Is your Seroquel being used to treat insomnia?',
    options: YES_NO,
    showIf: (a) => has(a, 'current_ap', 'seroquel'),
  },
  {
    id: 'seroquel_low_dose',
    type: 'single',
    section: 'Current Mental Health Treatment',
    prompt: 'Is your Seroquel being prescribed at a dose of 200mg or lower?',
    options: YES_NO,
    showIf: (a) => has(a, 'current_ap', 'seroquel') && a.seroquel_insomnia === 'yes',
  },
  {
    id: 'current_ms',
    type: 'multi',
    section: 'Current Mental Health Treatment',
    prompt: 'Are you currently taking any of the following medications?',
    help: 'Select all that apply.',
    options: [
      { value: 'lithium', label: 'Lithium' },
      ...ANTICONVULSANTS.map(([value, label]) => ({ value, label })),
      { value: 'none', label: 'I am not taking any of these medications', exclusive: true },
    ],
  },
  ...ANTICONVULSANTS.map(([key, label]) => ({
    id: `current_ms_${key}_use`,
    type: 'single',
    section: 'Current Mental Health Treatment',
    prompt: `What is your ${label} being used to treat?`,
    options: [
      { value: 'seizures', label: 'Seizures or epilepsy' },
      { value: 'migraine', label: 'Migraine prevention' },
      { value: 'nerve_pain', label: 'Nerve pain' },
      { value: 'mood', label: 'Mood stabilization for a mental health condition (such as bipolar disorder or mood swings)' },
      { value: 'other', label: 'Something else' },
    ],
    showIf: (a) => has(a, 'current_ms', key),
  })),
  {
    id: 'current_psych_meds',
    type: 'textarea',
    section: 'Current Mental Health Treatment',
    prompt: 'Are you currently taking any mental health medication? If so, please list each one with your current dose, how long you have been taking it, and how well it is working.',
    help: 'Write "None" if you are not taking any.',
  },

  // ------------------------------------------ Previous mental health treatment
  {
    id: 'prev_ap',
    type: 'multi',
    section: 'Previous Mental Health Treatment',
    prompt: 'Have you previously taken any of the following antipsychotic medications?',
    help: 'Select all that apply.',
    options: [
      ...CURRENT_ANTIPSYCHOTICS.map(([value, label]) => ({ value, label })),
      { value: 'none', label: 'I have not taken any of these medications', exclusive: true },
    ],
  },
  ...CURRENT_ANTIPSYCHOTICS.map(([key, label]) => ({
    id: `prev_ap_${key}_bp`,
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: `Was ${label} being used to treat bipolar disorder or a psychotic disorder?`,
    options: YES_NO,
    showIf: (a) => has(a, 'prev_ap', key),
  })),
  {
    id: 'prev_ms',
    type: 'multi',
    section: 'Previous Mental Health Treatment',
    prompt: 'Have you previously taken any of the following medications?',
    help: 'Select all that apply.',
    options: [
      { value: 'lithium', label: 'Lithium' },
      ...ANTICONVULSANTS.map(([value, label]) => ({ value, label })),
      { value: 'none', label: 'I have not taken any of these medications', exclusive: true },
    ],
  },
  ...ANTICONVULSANTS.map(([key, label]) => ({
    id: `prev_ms_${key}_mood`,
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: `Was ${label} used as a mood stabilizer for a mental health condition (such as bipolar disorder or mood swings)?`,
    options: YES_NO,
    showIf: (a) => has(a, 'prev_ms', key),
  })),
  {
    id: 'four_plus_meds',
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: 'Have you previously tried 4 or more medications for your mental health, not including medications used for sleep or as-needed anxiety?',
    options: YES_NO,
  },
  { id: 'tms', type: 'single', section: 'Previous Mental Health Treatment', prompt: 'Have you previously tried Transcranial Magnetic Stimulation (TMS) for mental health treatment?', options: YES_NO },
  {
    id: 'tms_continue',
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: TRD_NOTICE('TMS'),
    options: YES_NO,
    showIf: (a) => a.tms === 'yes',
  },
  { id: 'ect', type: 'single', section: 'Previous Mental Health Treatment', prompt: 'Have you previously tried Electroconvulsive Therapy (ECT) for mental health treatment?', options: YES_NO },
  {
    id: 'ketamine',
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: 'Have you previously tried ketamine injections or Spravato nasal spray for mental health treatment?',
    options: YES_NO,
  },
  {
    id: 'ketamine_continue',
    type: 'single',
    section: 'Previous Mental Health Treatment',
    prompt: TRD_NOTICE('Ketamine'),
    options: YES_NO,
    showIf: (a) => a.ketamine === 'yes',
  },
  { id: 'prev_meds_any', type: 'single', section: 'Previous Mental Health Treatment', prompt: 'Have you previously taken medication for mental health concerns?', options: YES_NO },
  {
    id: 'prev_meds_list',
    type: 'medlist',
    section: 'Previous Mental Health Treatment',
    prompt: 'Please list the medications you have tried and how they worked for you.',
    columns: [
      { key: 'name', label: 'Medication' },
      { key: 'dose', label: 'Dose' },
      { key: 'duration', label: 'How long' },
      { key: 'response', label: 'Response (helpful, not helpful, side effects)' },
    ],
    showIf: (a) => a.prev_meds_any === 'yes',
  },

  // --------------------------------------------------------- Medical history
  {
    id: 'medical',
    type: 'multi',
    section: 'Medical History',
    prompt: 'Do you have any of the following medical conditions?',
    help: 'Select all that apply.',
    options: [
      { value: 'seizure', label: 'Seizure disorder or epilepsy' },
      { value: 'liver', label: 'Liver disease' },
      { value: 'kidney', label: 'Kidney disease' },
      { value: 'heart', label: 'Heart disease' },
      { value: 'hypertension', label: 'High blood pressure' },
      { value: 'diabetes', label: 'Diabetes' },
      { value: 'thyroid', label: 'Thyroid disorder' },
      { value: 'glaucoma', label: 'Narrow-angle glaucoma' },
      { value: 'bleeding', label: 'Bleeding disorder' },
      { value: 'serotonin_syndrome', label: 'History of serotonin syndrome' },
      { value: 'hyponatremia', label: 'History of hyponatremia (low sodium)' },
      { value: 'long_qt', label: 'History of prolonged QTc syndrome' },
      { value: 'other', label: 'Other' },
      { value: 'none', label: 'None of the above', exclusive: true },
    ],
  },
  {
    id: 'medical_other',
    type: 'text',
    section: 'Medical History',
    prompt: 'What other medical conditions do you have?',
    showIf: (a) => has(a, 'medical', 'other'),
  },
  {
    id: 'glaucoma_iridotomy',
    type: 'single',
    section: 'Medical History',
    prompt: 'Have you received treatment for your glaucoma with an iridotomy?',
    options: YES_NO,
    showIf: (a) => has(a, 'medical', 'glaucoma'),
  },
  {
    id: 'pregnant',
    type: 'single',
    section: 'Medical History',
    prompt: 'Are you currently pregnant or trying to become pregnant?',
    options: [...YES_NO, { value: 'na', label: 'Not applicable' }],
    showIf: (a) => a.sex !== 'male',
  },
  {
    id: 'breastfeeding',
    type: 'single',
    section: 'Medical History',
    prompt: 'Are you currently breastfeeding?',
    options: [...YES_NO, { value: 'na', label: 'Not applicable' }],
    showIf: (a) => a.sex !== 'male',
  },

  // ----------------------------------------- Current medications / supplements
  {
    id: 'other_meds',
    type: 'multi',
    section: 'Current Medications and Supplements',
    prompt: 'Are you currently taking any of the following?',
    help: 'Select all that apply.',
    options: [
      { value: 'methadone', label: 'Methadone' },
      { value: 'tramadol', label: 'Tramadol' },
      { value: 'blood_thinners', label: 'Blood thinners (such as warfarin, apixaban, rivaroxaban)' },
      { value: 'nsaids', label: 'NSAIDs (such as ibuprofen, naproxen, diclofenac)' },
      { value: 'triptans', label: 'Triptans for migraines' },
      { value: 'st_johns_wort', label: "St. John's Wort" },
      { value: 'methylene_blue', label: 'Methylene blue' },
      { value: 'stimulants', label: 'Stimulants (such as Adderall, Vyvanse, Concerta)' },
      { value: 'beta_blockers', label: 'Beta blockers (such as metoprolol, propranolol)' },
      { value: 'antiarrhythmics', label: 'Antiarrhythmics for heart conditions (such as amiodarone, dronedarone, sotalol, quinidine)' },
      { value: 'hydroxychloroquine', label: 'Hydroxychloroquine' },
      { value: 'diuretics', label: 'Diuretics (such as hydrochlorothiazide, furosemide)' },
      { value: 'finasteride', label: 'Finasteride tablets' },
      { value: 'tamoxifen', label: 'Tamoxifen' },
      { value: 'none', label: 'None of the above', exclusive: true },
    ],
    messages: [
      {
        when: (a) => has(a, 'other_meds', 'finasteride'),
        text: 'Finasteride can potentially cause new or worsening depression or suicidal thinking. We recommend speaking to your prescribing provider about switching to a different medication. If you are taking it for hair loss, a topical formulation is also available.',
      },
    ],
  },
  {
    id: 'st_johns_stop',
    type: 'single',
    section: 'Current Medications and Supplements',
    prompt: "St. John's Wort can interfere with the metabolism of many medications, including the mental health medications we prescribe. Are you willing to stop taking this supplement before starting treatment?",
    options: YES_NO,
    showIf: (a) => has(a, 'other_meds', 'st_johns_wort'),
  },
  {
    id: 'all_meds',
    type: 'medlist',
    section: 'Current Medications and Supplements',
    prompt: 'Please list ALL medications you currently take, including over-the-counter medications and supplements.',
    help: 'Leave the list empty if you do not take any.',
    optional: true,
    columns: [
      { key: 'name', label: 'Medication' },
      { key: 'dose', label: 'Dose' },
      { key: 'frequency', label: 'How often' },
    ],
  },

  // ----------------------------------------------------------- Substance use
  {
    id: 'alcohol',
    type: 'single',
    section: 'Substance Use',
    prompt: 'On average, how many alcoholic drinks do you have per week?',
    options: [
      { value: '0', label: '0 drinks' },
      { value: '1_5', label: '1–5 drinks' },
      { value: '6_10', label: '6–10 drinks' },
      { value: '11_15', label: '11–15 drinks' },
      { value: '16_20', label: '16–20 drinks' },
      { value: '21_25', label: '21–25 drinks' },
      { value: '26_30', label: '26–30 drinks' },
      { value: '31_plus', label: '31 or more drinks' },
    ],
    messages: [{ when: (a) => ['11_15', '16_20', '21_25', '26_30', '31_plus'].includes(a.alcohol), text: ALCOHOL_MESSAGE }],
  },
  { id: 'nicotine', type: 'single', section: 'Substance Use', prompt: 'Do you currently use tobacco or nicotine products?', options: YES_NO },
  {
    id: 'nicotine_type',
    type: 'text',
    section: 'Substance Use',
    prompt: 'What type of tobacco or nicotine product do you use?',
    showIf: (a) => a.nicotine === 'yes',
  },
  { id: 'cannabis', type: 'single', section: 'Substance Use', prompt: 'Do you currently use cannabis (marijuana)?', options: YES_NO },
  {
    id: 'cannabis_frequency',
    type: 'single',
    section: 'Substance Use',
    prompt: 'How often do you use cannabis?',
    options: [
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'monthly', label: 'Monthly' },
      { value: 'occasionally', label: 'Occasionally' },
    ],
    showIf: (a) => a.cannabis === 'yes',
    messages: [
      {
        when: (a) => a.cannabis === 'yes' && !!a.cannabis_frequency,
        text: 'Long-term studies on cannabis have not been promising for depression and anxiety outcomes, and there is evidence that cannabis can worsen mood and anxiety over time. THC also worsens cognitive symptoms such as focus and motivation, and cannabis can interfere with how well medications work. We highly advise that you begin cutting back and eventually stop.',
      },
    ],
  },
  {
    id: 'substances',
    type: 'multi',
    section: 'Substance Use',
    prompt: 'Have you used any of the following in the past 6 months?',
    help: 'Select all that apply.',
    options: [
      { value: 'cocaine', label: 'Cocaine' },
      { value: 'mdma', label: 'Ecstasy (MDMA)' },
      { value: 'meth', label: 'Methamphetamine or other illicit stimulants' },
      { value: 'opioids', label: 'Heroin, fentanyl, or other recreational opioids' },
      { value: 'hallucinogens', label: 'Hallucinogens (LSD, mushrooms, etc.)' },
      { value: 'kratom', label: 'Kratom' },
      { value: 'rx_stimulants', label: 'Prescription stimulants not prescribed to you' },
      { value: 'benzos', label: 'Benzodiazepines not prescribed to you' },
      { value: 'none', label: 'None of the above', exclusive: true },
    ],
  },
  {
    id: 'cocaine_count',
    type: 'single',
    section: 'Substance Use',
    prompt: 'How many times have you used cocaine in the past 6 months?',
    options: [
      { value: '1_2', label: '1–2 times' },
      { value: 'gt2', label: 'More than 2 times' },
    ],
    showIf: (a) => has(a, 'substances', 'cocaine'),
  },
  {
    id: 'cocaine_stop',
    type: 'single',
    section: 'Substance Use',
    prompt: 'Are you willing to stop using cocaine?',
    options: YES_NO,
    showIf: (a) => has(a, 'substances', 'cocaine') && a.cocaine_count === '1_2',
  },
  ...[
    ['hallucinogens', 'hallucinogens'],
    ['kratom', 'kratom'],
    ['rx_stimulants', 'stimulants that are not prescribed to you'],
    ['benzos', 'benzodiazepines that are not prescribed to you'],
  ].map(([key, what]) => ({
    id: `${key}_stop`,
    type: 'single',
    section: 'Substance Use',
    prompt: `Are you willing to stop using ${what} before starting treatment?`,
    options: YES_NO,
    showIf: (a) => has(a, 'substances', key),
  })),

  // ----------------------------------------------------------------- Allergy
  { id: 'allergies', type: 'single', section: 'Allergy Information', prompt: 'Do you have any medication allergies?', options: YES_NO },
  {
    id: 'allergies_list',
    type: 'textarea',
    section: 'Allergy Information',
    prompt: 'Please list each medication you are allergic to and the reaction you had.',
    showIf: (a) => a.allergies === 'yes',
  },

  // -------------------------------------------------------------- PHQ-9/GAD-7
  ...PHQ9.map(([id, text], i) => ({
    id,
    type: 'single',
    section: 'Symptom Assessment – Depression',
    lead: 'Over the past 2 weeks, how often have you been bothered by…',
    prompt: text,
    step: `${i + 1} of ${PHQ9.length}`,
    options: FREQUENCY,
    messages: id === 'phq9_9' ? [{ when: (a) => Number(a.phq9_9) >= 1, kind: 'crisis', text: CRISIS_MESSAGE }] : undefined,
  })),
  ...safetyBlock('sb', selfHarmFromPhq),
  ...GAD7.map(([id, text], i) => ({
    id,
    type: 'single',
    section: 'Symptom Assessment – Anxiety',
    lead: 'Over the past 2 weeks, how often have you been bothered by…',
    prompt: text,
    step: `${i + 1} of ${GAD7.length}`,
    options: FREQUENCY,
  })),

  // -------------------------------------------------------- Functional impact
  {
    id: 'interference',
    type: 'single',
    section: 'Functional Impact',
    prompt: 'How much do your symptoms interfere with your daily life?',
    options: [
      { value: 'not_at_all', label: 'Not at all' },
      { value: 'somewhat', label: 'Somewhat' },
      { value: 'very_much', label: 'Very much' },
      { value: 'extremely', label: 'Extremely' },
    ],
  },
  {
    id: 'areas_affected',
    type: 'multi',
    section: 'Functional Impact',
    prompt: 'Which areas of your life are most affected?',
    help: 'Select all that apply.',
    options: [
      { value: 'work', label: 'Work or school performance' },
      { value: 'family', label: 'Relationships with family' },
      { value: 'friends', label: 'Relationships with friends' },
      { value: 'romantic', label: 'Romantic relationships' },
      { value: 'self_care', label: 'Self-care activities' },
      { value: 'sleep', label: 'Sleep' },
      { value: 'appetite', label: 'Appetite or eating' },
      { value: 'physical', label: 'Physical health' },
      { value: 'enjoyment', label: 'Enjoyment of activities' },
      { value: 'none', label: 'None of these', exclusive: true },
    ],
  },

  // ---------------------------------------------------- Medication preference
  {
    id: 'family_response',
    type: 'multi',
    section: 'Medication Preference',
    prompt: 'Have any of your family members had a good response to any of these medications for depression or anxiety?',
    help: 'Select all that apply.',
    options: [...PREFERENCE_MEDS.map(([value, label]) => ({ value, label })), { value: 'unsure', label: 'Not sure / not applicable', exclusive: true }],
  },
  {
    id: 'med_interest',
    type: 'multi',
    section: 'Medication Preference',
    prompt: 'Is there a specific medication you are interested in?',
    help: 'Select all that apply.',
    options: [
      ...PREFERENCE_MEDS.map(([value, label]) => ({ value, label })),
      { value: 'other', label: 'Other' },
      { value: 'provider', label: 'No specific medication — whatever my provider recommends', exclusive: true },
    ],
  },
  {
    id: 'med_interest_other',
    type: 'text',
    section: 'Medication Preference',
    prompt: 'Which other medication are you interested in?',
    showIf: (a) => has(a, 'med_interest', 'other'),
  },

  // -------------------------------------------------------------- Additional
  {
    id: 'additional',
    type: 'single',
    section: 'Additional Information',
    prompt: 'Your provider will review this intake. Is there anything else about your mental health or medical history that you would like to share?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'Nothing else to share' },
    ],
  },
  {
    id: 'additional_text',
    type: 'textarea',
    section: 'Additional Information',
    prompt: 'What would you like your provider to know?',
    showIf: (a) => a.additional === 'yes',
  },

  // ------------------------------------------------------------------ Consent
  {
    id: 'consent',
    type: 'consent',
    section: 'Acknowledgment and Consent',
    prompt: 'Please review and sign.',
    statements: [
      'This is an asynchronous telemedicine service.',
      'I will be evaluated by a licensed psychiatrist or psychiatric provider.',
      'This service is appropriate for mild to moderate depression and anxiety.',
      'Certain conditions require a live evaluation and are not appropriate for asynchronous care.',
      'I may be scheduled for a video visit if my condition is not appropriate for asynchronous care.',
      'I am responsible for providing accurate and complete information.',
      'I certify that the information I have provided is true and complete to the best of my knowledge.',
    ],
  },
];

export const QUESTION_BY_ID = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));

export function isVisible(q, answers) {
  return !q.showIf || !!q.showIf(answers);
}

export function visibleQuestions(answers) {
  return QUESTIONS.filter((q) => isVisible(q, answers));
}

// Answers restricted to questions the patient could see with their other
// answers. A patient who goes back and changes a parent answer leaves stale
// follow-ups behind in storage; this is what keeps those out of the rules.
export function effectiveAnswers(answers) {
  const out = {};
  // Visibility can depend on answers that are themselves hidden, so iterate
  // until nothing changes.
  let current = { ...answers };
  for (let i = 0; i < 5; i++) {
    const next = {};
    for (const q of QUESTIONS) if (q.id in answers && isVisible(q, current)) next[q.id] = answers[q.id];
    if (JSON.stringify(next) === JSON.stringify(current)) break;
    current = next;
  }
  Object.assign(out, current);
  return out;
}

export function isAnswered(q, value) {
  if (q.type === 'info') return true;
  if (q.type === 'medlist') return q.optional || (Array.isArray(value) && value.some((r) => r && String(r.name || '').trim()));
  if (q.type === 'multi') return Array.isArray(value) && value.length > 0;
  if (q.type === 'height') return !!value && Number(value.ft) > 0;
  if (q.type === 'consent') return !!value && value.agree === true && String(value.signature || '').trim().length > 1;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function patientMessages(q, answers) {
  return (q.messages || []).filter((m) => m.when(answers));
}
