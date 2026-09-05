import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, HeadingLevel, AlignmentType, ShadingType,
  convertInchesToTwip, UnderlineType
} from 'docx';

const TEAL = '1B6CA8';
const DARK = '1e2530';
const LIGHT_GRAY = 'F2F4F6';

function labelRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 35, type: WidthType.PERCENTAGE },
        shading: { fill: LIGHT_GRAY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
        },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, color: DARK, font: 'Calibri' })] })],
      }),
      new TableCell({
        width: { size: 65, type: WidthType.PERCENTAGE },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' },
          left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
        },
        children: [new Paragraph({ children: [new TextRun({ text: value || '—', size: 20, color: value ? DARK : '999999', font: 'Calibri' })] })],
      }),
    ],
  });
}

function sectionHeader(title) {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    children: [
      new TextRun({
        text: title.toUpperCase(),
        bold: true,
        size: 18,
        color: TEAL,
        font: 'Calibri',
      }),
    ],
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: TEAL },
    },
  });
}

function dataTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      insideH: { style: BorderStyle.NONE },
      insideV: { style: BorderStyle.NONE },
    },
    rows,
  });
}

export async function generateDocx(f) {
  const providerName = f['Full Name'] || 'Unknown Provider';

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 20, color: DARK },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.1),
            right: convertInchesToTwip(1.1),
          },
        },
      },
      children: [
        // Title block
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'NP / PA PROVIDER PROFILE', bold: true, size: 32, color: TEAL, font: 'Calibri' }),
          ],
        }),
        new Paragraph({
          spacing: { after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: TEAL } },
          children: [
            new TextRun({
              text: 'Monthly compensation for collaborative physician to help this provider: $',
              size: 20, color: DARK, font: 'Calibri',
            }),
            new TextRun({ text: 'xxx', size: 20, color: '999999', font: 'Calibri', underline: { type: UnderlineType.SINGLE } }),
            new TextRun({ text: '/month', size: 20, color: DARK, font: 'Calibri' }),
          ],
        }),

        // Section 1: Provider Information
        sectionHeader('Provider Information'),
        dataTable([
          labelRow('Provider Type', f['Provider Type']),
          labelRow('Specialty', f['Specialty']),
          labelRow('Highest Degree Earned', f['Medical Degree']),
          labelRow('Years of Experience', f['Years of Clinical Experience']),
          labelRow('Years of Psychiatry Experience', f['Years of Psychiatry Experience']),
        ]),

        // Section 2: Collaboration & Licensure
        sectionHeader('Collaboration & Licensure'),
        dataTable([
          labelRow('States Needing Collaboration', f['States Needing Collaboration']),
          labelRow('DEA States', f['DEA States'] || 'None specified'),
        ]),

        // Section 3: Practice Details
        sectionHeader('Practice Details'),
        dataTable([
          labelRow('Patient Setting', f['Patient Setting']),
          labelRow('Practice Setting', f['Practice Setting']),
          labelRow('Patient Population', f['Patient Population']),
          labelRow('Weekly Hours', f['Weekly Hours']),
        ]),

        // Section 4: Clinical Services
        sectionHeader('Clinical Services'),
        dataTable([
          labelRow('Controlled Substances', f['Controlled Substances'] || '—'),
          ...(f['Controlled Substances'] === 'Yes' ? [
            labelRow('Controlled Substance Schedule', f['Controlled Substance Schedule']),
            labelRow('MAT Services', f['MAT Services']),
          ] : []),
          labelRow('Interventional Route', f['Interventional Route']),
          ...(f['Interventional Practice Notes'] ? [labelRow('Interventional Notes', f['Interventional Practice Notes'])] : []),
          labelRow('TMS', f['TMS']),
          ...(f['TMS'] && f['TMS'] !== 'no' ? [labelRow('TMS Details', f['TMS Program Details'])] : []),
          labelRow('Other Advanced Services', f['Other Advanced Services']),
        ]),

        // Section 5: Availability
        sectionHeader('Availability'),
        dataTable([
          labelRow('Ideal Start Date', f['Ideal Start Date']),
          labelRow('First Patient Timeline', f['First Patient Timeline']),
        ]),

        // Section 6: Additional Information
        sectionHeader('Additional Information'),
        new Paragraph({
          spacing: { before: 80, after: 240 },
          children: [
            new TextRun({
              text: f['Additional Information'] || 'None provided.',
              size: 20, color: f['Additional Information'] ? DARK : '999999', font: 'Calibri',
            }),
          ],
        }),

        // Footer note
        new Paragraph({
          spacing: { before: 200 },
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } },
          children: [
            new TextRun({
              text: `Submitted via MD-Match.com  ·  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
              size: 16, color: '888888', font: 'Calibri', italics: true,
            }),
          ],
        }),
        ...(f['How Did You Hear About MD-Match']
          ? [new Paragraph({
            children: [new TextRun({ text: `Referral source: ${f['How Did You Hear About MD-Match']}${f['Referred By'] ? ` (${f['Referred By']})` : ''}`, size: 16, color: '888888', font: 'Calibri', italics: true })],
          })]
          : []),
      ],
    }],
  });

  // toBase64String is more reliable in non-Node environments
  const base64 = await Packer.toBase64String(doc);
  // Decode base64 back to Uint8Array for attachment
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { base64, bytes };
}

export async function generateNpPaIntakeDocx(f) {
  const clinicalRows = [
    labelRow('Controlled Substances', f['Controlled Substances']),
    ...(f['Stimulants Frequency'] ? [labelRow('Stimulants (Frequency)', f['Stimulants Frequency'])] : []),
    ...(f['Benzodiazepines Frequency'] ? [labelRow('Benzodiazepines (Frequency)', f['Benzodiazepines Frequency'])] : []),
    labelRow('Buprenorphine / Suboxone', f['Buprenorphine / Suboxone']),
    labelRow('IV Ketamine', f['IV Ketamine']),
    labelRow('IM Ketamine', f['IM Ketamine']),
    labelRow('Intranasal Ketamine', f['Intranasal Ketamine']),
    labelRow('TMS Therapy', f['TMS']),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20, color: DARK } } } },
    sections: [{
      properties: { page: { margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.1), right: convertInchesToTwip(1.1) } } },
      children: [
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: 'NP / PA PROVIDER PROFILE', bold: true, size: 32, color: TEAL, font: 'Calibri' })],
        }),
        new Paragraph({
          spacing: { after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: TEAL } },
          children: [
            new TextRun({ text: 'Monthly compensation for collaborative physician to help this provider: $', size: 20, color: DARK, font: 'Calibri' }),
            new TextRun({ text: 'xxx', size: 20, color: '999999', font: 'Calibri', underline: { type: UnderlineType.SINGLE } }),
            new TextRun({ text: '/month', size: 20, color: DARK, font: 'Calibri' }),
          ],
        }),
        sectionHeader('Provider Information'),
        dataTable([
          labelRow('Full Name', f['Full Name']),
          labelRow('Email', f['Email']),
          labelRow('Phone', f['Phone']),
          labelRow('Provider Type', f['Provider Type']),
          labelRow('Specialty', f['Specialty']),
        ]),
        sectionHeader('Collaboration & Practice'),
        dataTable([
          labelRow('States Needing Collaboration', f['States Needing Collaboration']),
          labelRow('Practice Setting', f['Practice Setting']),
          labelRow('Timeline', f['Timeline']),
          labelRow('Has Current Collaborator', f['Has Collaborator']),
        ]),
        sectionHeader('Clinical Services'),
        dataTable(clinicalRows),
        sectionHeader('Additional Information'),
        new Paragraph({
          spacing: { before: 80, after: 240 },
          children: [new TextRun({ text: f['Additional Information'] || 'None provided.', size: 20, color: f['Additional Information'] ? DARK : '999999', font: 'Calibri' })],
        }),
        new Paragraph({
          spacing: { before: 200 },
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } },
          children: [new TextRun({ text: `Submitted via MD-Match.com  ·  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 16, color: '888888', font: 'Calibri', italics: true })],
        }),
        ...(f['Referred By'] ? [new Paragraph({ children: [new TextRun({ text: `Referral source: ${f['Referred By']}`, size: 16, color: '888888', font: 'Calibri', italics: true })] })] : []),
      ],
    }],
  });

  const base64 = await Packer.toBase64String(doc);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { base64, bytes };
}

export async function generatePhysicianDocx(f) {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 20, color: DARK },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.1),
            right: convertInchesToTwip(1.1),
          },
        },
      },
      children: [
        new Paragraph({
          spacing: { after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: TEAL } },
          children: [
            new TextRun({ text: 'PHYSICIAN PROFILE', bold: true, size: 32, color: TEAL, font: 'Calibri' }),
          ],
        }),

        sectionHeader('Personal & Credentials'),
        dataTable([
          labelRow('Medical Degree', f['Medical Degree']),
          labelRow('Specialty', f['Specialty']),
          labelRow('Board Certification Status', f['Board Certification Status']),
          labelRow('NPI Number', f['NPI Number']),
          labelRow('Years in Practice', f['Years in Practice']),
        ]),

        sectionHeader('Licensure, Collaboration & DEA'),
        dataTable([
          labelRow('Licensed States', f['Licensed States']),
          labelRow('Available to Collaborate', f['Collab States']),
          labelRow('DEA States', f['DEA States'] || 'None specified'),
        ]),

        sectionHeader('Clinical Preferences'),
        dataTable([
          labelRow('Controlled Substances Comfort', f['Controlled Substances Comfort']),
          ...(f['Controlled Substances Comfort'] !== 'No' ? [labelRow('Schedule II Signoff', f['Schedule II Signoff'])] : []),
          labelRow('IV Interventional Comfort', f['IV Interventional Comfort']),
          labelRow('IM Interventional Comfort', f['IM Interventional Comfort']),
          labelRow('Intranasal Interventional Comfort', f['Intranasal Interventional Comfort']),
          labelRow('TMS Comfort', f['TMS Comfort']),
          labelRow('Credentialing Willingness', f['Credentialing Willingness']),
        ]),

        sectionHeader('Legal & Board Standing'),
        dataTable([
          labelRow('Board Disciplinary Action', f['Board Action']),
          ...(f['Board Action'] === 'Yes' ? [labelRow('Board Action Details', f['Board Action Details'])] : []),
          labelRow('License Suspension', f['License Suspension']),
          ...(f['License Suspension'] === 'Yes' ? [labelRow('License Suspension Details', f['License Suspension Details'])] : []),
          labelRow('DEA Action', f['DEA Action']),
          ...(f['DEA Action'] === 'Yes' ? [labelRow('DEA Action Details', f['DEA Action Details'])] : []),
          labelRow('Malpractice', f['Malpractice']),
          ...(f['Malpractice'] === 'Yes' ? [labelRow('Malpractice Details', f['Malpractice Details'])] : []),
        ]),

        new Paragraph({
          spacing: { before: 200 },
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } },
          children: [
            new TextRun({
              text: `Submitted via MD-Match.com  ·  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
              size: 16, color: '888888', font: 'Calibri', italics: true,
            }),
          ],
        }),
        ...(f['How Did You Hear About MD-Match']
          ? [new Paragraph({
            children: [new TextRun({ text: `Referral source: ${f['How Did You Hear About MD-Match']}`, size: 16, color: '888888', font: 'Calibri', italics: true })],
          })]
          : []),
      ],
    }],
  });

  const base64 = await Packer.toBase64String(doc);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { base64, bytes };
}
