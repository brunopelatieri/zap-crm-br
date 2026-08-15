import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          sourceRow: 2,
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          sourceRow: 3,
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
          sourceRow: 2,
        },
      ],
    });
  });

  it('reconhece cabeçalhos em pt-BR (round-trip de um CSV exportado, SPEC 051 §4)', () => {
    const csv = `telefone,nome,email,empresa,etiquetas
5511900000001,Maria,maria@exemplo.com,Loja da Maria,"vip, lead"`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: true,
      rows: [
        {
          phone: '5511900000001',
          name: 'Maria',
          email: 'maria@exemplo.com',
          company: 'Loja da Maria',
          tagNames: ['vip', 'lead'],
          sourceRow: 2,
        },
      ],
    });
  });

  it('sem cabeçalho de telefone reconhecido (nem inglês nem pt-BR), devolve vazio', () => {
    const csv = `id,nome
1,Maria`;
    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [],
    });
  });

  it('normalizes a masked BR phone with react-phone-number-input-style input', () => {
    const csv = `phone,name
+55 (19) 9 9249-6598,Maria`;

    const { rows } = parseContactCsv(csv);
    // parseContactCsv itself does not normalize — that's SPEC 050 F3,
    // done by the import modal via normalizeContactPhone. This just
    // confirms the raw masked value survives the CSV parse untouched.
    expect(rows).toEqual([
      {
        phone: '+55 (19) 9 9249-6598',
        name: 'Maria',
        email: undefined,
        company: undefined,
        tagNames: [],
        sourceRow: 2,
      },
    ]);
  });
});
