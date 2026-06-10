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
          spacing: { after: 60 },
          children: [
            new TextRun({ text: providerName, bold: true, size: 26, color: DARK, font: 'Calibri' }),
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
          labelRow('Email', f['Email']),
          labelRow('Phone', f['Phone']),
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
          labelRow('Controlled Substances', f['Controlled Schedule'] || f['controlled'] || '—'),
          labelRow('Esketamine (Intranasal)', f['esketamine']),
          ...(f['esketamine'] && f['esketamine'] !== 'No' ? [labelRow('Esketamine Details', f['Esketamine Program Details'])] : []),
          labelRow('IV / IM Ketamine', f['ketamine']),
          ...(f['ketamine'] && f['ketamine'] !== 'No' ? [labelRow('IV/IM Ketamine Details', f['IV IM Ketamine Program Details'])] : []),
          labelRow('TMS', f['TMS']),
          ...(f['TMS'] && f['TMS'] !== 'no' ? [labelRow('TMS Details', f['TMS Program Details'])] : []),
          labelRow('Other Advanced Services', f['Other Advanced Services']),
        ]),

        // Section 5: Additional Information
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
