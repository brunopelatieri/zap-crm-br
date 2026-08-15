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

  // SPEC 052 §2.2 achado K: só `,` e `;` separam — trava o comportamento
  // conhecido para que uma mudança futura não amplie os separadores
  // sem que alguém perceba.
  it('não separa por `|` nem por `/` — só `,` e `;` são separadores', () => {
    expect(parseTagCell('vip|lead')).toEqual(['vip|lead']);
    expect(parseTagCell('vip / lead')).toEqual(['vip / lead']);
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

  // SPEC 052 §2.2 achado E / D-4: CSV exportado pelo Excel em pt-BR usa
  // `;`. Antes desta correção o arquivo inteiro se perdia (rows: []).
  it('fareja o delimitador `;` no cabeçalho (CSV exportado pelo Excel em pt-BR)', () => {
    const csv = 'phone;name;email\n5511900000001;Maria;maria@exemplo.com';

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '5511900000001',
          name: 'Maria',
          email: 'maria@exemplo.com',
          company: undefined,
          tagNames: [],
          sourceRow: 2,
        },
      ],
    });
  });

  it('mantém `,` quando o cabeçalho não tem `;` nem tab (sem regressão)', () => {
    const csv = 'phone,name\n5511900000001,Maria';
    expect(parseContactCsv(csv).rows).toEqual([
      expect.objectContaining({ phone: '5511900000001', name: 'Maria' }),
    ]);
  });

  // SPEC 052 §2.2 achado F / D-5: um `.replace(/["']/g, '')` global
  // apagava qualquer apóstrofo, em qualquer posição do valor.
  it('preserva apóstrofo em nomes (não é uma aspa delimitadora)', () => {
    const csv = "phone,name,company\n5511900000001,Maria D'Ávila,O'Brien & Co";

    const { rows } = parseContactCsv(csv);
    expect(rows[0].name).toBe("Maria D'Ávila");
    expect(rows[0].company).toBe("O'Brien & Co");
  });

  // SPEC 052 §2.2 achado G / D-5: aspas duplas escapadas (RFC 4180)
  // devem virar uma aspa literal, não sumir.
  it('desescapa aspas duplicadas dentro de uma célula entre aspas (RFC 4180)', () => {
    const csv = 'phone,name\n5511900000001,"Maria ""Bibi"" Souza"';

    const { rows } = parseContactCsv(csv);
    expect(rows[0].name).toBe('Maria "Bibi" Souza');
  });

  // Achado de revisão (code-review, pós-F1): o farejo de delimitador
  // contava vírgulas DENTRO de um cabeçalho entre aspas, então um CSV
  // `;` com um cabeçalho como `"empresa,filial"` era lido como `,` —
  // exatamente o caso que o D-4 existe para resolver.
  it('fareja `;` mesmo com uma vírgula dentro de um cabeçalho entre aspas', () => {
    const csv = 'telefone;"empresa,filial"\n5511900000001;Acme';

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '5511900000001',
          name: undefined,
          email: undefined,
          company: undefined,
          tagNames: [],
          sourceRow: 2,
        },
      ],
    });
  });

  // Achado de revisão: um valor cujo conteúdo LEGÍTIMO (já desescapado
  // pelo tokenizador) começa e termina com aspas dupla não pode ser
  // "desaspado" de novo — `csvCell` estava repetindo um trabalho que
  // `parseCsvLine` já tinha feito, corrompendo o dado.
  it('não remove aspas duplas de um valor que já veio desescapado pelo tokenizador', () => {
    // `"""Bibi"""` em RFC 4180 é o valor literal `"Bibi"`.
    const csv = 'phone,name\n5511900000001,"""Bibi"""';

    const { rows } = parseContactCsv(csv);
    expect(rows[0].name).toBe('"Bibi"');
  });

  // Achado de revisão: o cabeçalho era dividido com `.split()` puro
  // enquanto as linhas de dados passavam pelo tokenizador — uma vírgula
  // dentro de um cabeçalho entre aspas produzia mais colunas de
  // cabeçalho do que de dado, desalinhando todos os índices seguintes.
  it('tokeniza o cabeçalho como as linhas de dados, sem desalinhar colunas por vírgula entre aspas', () => {
    const csv =
      '"phone","nome, completo","email"\n5511900000001,Maria,maria@exemplo.com';

    const { rows } = parseContactCsv(csv);
    expect(rows[0]).toMatchObject({
      phone: '5511900000001',
      email: 'maria@exemplo.com',
    });
  });
});
