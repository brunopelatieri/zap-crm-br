import { describe, expect, it } from 'vitest';
import type { Contact } from '@/types';
import {
  buildContactExportMatrix,
  type ContactExportLabels,
  type ContactExportRow,
} from './export-serialize';
import type { ContactExportFieldId } from './export-fields';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1',
    user_id: 'u1',
    account_id: 'a1',
    phone: '5511900000001',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeRow(overrides: Partial<ContactExportRow> = {}): ContactExportRow {
  return {
    contact: makeContact(),
    tagNames: [],
    channelNames: [],
    customValues: {},
    notes: [],
    lastMessageAt: null,
    sessionWindowOpen: null,
    ...overrides,
  };
}

const labels: ContactExportLabels = {
  columns: {
    name: 'nome',
    phone: 'telefone',
    email: 'email',
    company: 'empresa',
    created_at: 'criado_em',
    notes: 'notas',
    phone_e164: 'telefone_e164',
    whatsapp_status: 'whatsapp',
    whatsapp_status_reason: 'whatsapp_motivo',
    consent_status: 'consentimento',
    consent_source: 'origem_consentimento',
    consent_date: 'data_consentimento',
    last_interaction: 'ultima_interacao',
    session_window: 'janela_24h',
  },
  tagColumn: (n) => `etiqueta_${n}`,
  channelColumn: (n) => `canal_${n}`,
  values: {
    optedIn: 'Optou por entrar',
    optedOut: 'Optou por sair',
    unknown: 'Desconhecido',
    valid: 'Válido',
    invalid: 'Inválido',
    windowOpen: 'Aberta',
    windowClosed: 'Fechada',
    windowNA: 'Não se aplica',
    consentSource: { manual: 'Manual', import: 'Importação' },
    whatsappReason: {
      consecutive_failures: 'Falhas consecutivas',
      meta_error: 'Erro da Meta',
      manual: 'Manual',
    },
  },
  formatDate: (iso) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  },
};

const basicFields: ContactExportFieldId[] = ['name', 'phone', 'email', 'tags'];

describe('buildContactExportMatrix — colunas básicas', () => {
  it('emite o cabeçalho e as células na ordem canônica, não na ordem de `fields`', () => {
    const rows = [
      makeRow({ contact: makeContact({ name: 'Maria', email: 'm@x.com' }) }),
    ];
    // `fields` chega fora de ordem — a saída deve seguir o catálogo.
    const matrix = buildContactExportMatrix(
      rows,
      ['email', 'name', 'phone'],
      [],
      labels
    );
    expect(matrix[0]).toEqual(['nome', 'telefone', 'email']);
    expect(matrix[1]).toEqual(['Maria', '5511900000001', 'm@x.com']);
  });

  it('nulos viram string vazia, nunca "null"/"undefined"', () => {
    const rows = [
      makeRow({ contact: makeContact({ name: undefined, email: undefined }) }),
    ];
    const matrix = buildContactExportMatrix(
      rows,
      ['name', 'email'],
      [],
      labels
    );
    expect(matrix[1]).toEqual(['', '']);
  });
});

describe('buildContactExportMatrix — largura dinâmica de etiquetas', () => {
  it('nenhuma coluna etiqueta_* quando ninguém tem etiqueta', () => {
    const rows = [makeRow(), makeRow()];
    const matrix = buildContactExportMatrix(rows, basicFields, [], labels);
    expect(matrix[0]).toEqual(['nome', 'telefone', 'email']);
  });

  it('uma coluna etiqueta_1 quando o máximo entre as linhas é 1', () => {
    const rows = [makeRow({ tagNames: ['vip'] }), makeRow({ tagNames: [] })];
    const matrix = buildContactExportMatrix(rows, basicFields, [], labels);
    expect(matrix[0]).toEqual(['nome', 'telefone', 'email', 'etiqueta_1']);
    expect(matrix[1][3]).toBe('vip');
    expect(matrix[2][3]).toBe('');
  });

  it('largura = máximo de etiquetas entre as linhas exportadas, célula vazia para quem tem menos', () => {
    const rows = [
      makeRow({ tagNames: ['a', 'b', 'c'] }),
      makeRow({ tagNames: ['x'] }),
    ];
    const matrix = buildContactExportMatrix(rows, basicFields, [], labels);
    expect(matrix[0].slice(3)).toEqual([
      'etiqueta_1',
      'etiqueta_2',
      'etiqueta_3',
    ]);
    expect(matrix[1].slice(3)).toEqual(['a', 'b', 'c']);
    expect(matrix[2].slice(3)).toEqual(['x', '', '']);
  });
});

describe('buildContactExportMatrix — canais (mesmo mecanismo dinâmico)', () => {
  it('larga conforme o máximo de canais, célula vazia para quem tem menos', () => {
    const rows = [
      makeRow({ channelNames: ['WhatsApp Cloud', 'QRCode'] }),
      makeRow({ channelNames: [] }),
    ];
    const matrix = buildContactExportMatrix(rows, ['channels'], [], labels);
    expect(matrix[0]).toEqual(['canal_1', 'canal_2']);
    expect(matrix[1]).toEqual(['WhatsApp Cloud', 'QRCode']);
    expect(matrix[2]).toEqual(['', '']);
  });
});

describe('buildContactExportMatrix — campos personalizados', () => {
  it('uma coluna por definição, header = field_name, valor por contact_field_id', () => {
    const rows = [
      makeRow({ customValues: { f1: 'Ouro', f2: 'SP' } }),
      makeRow({ customValues: { f1: 'Prata' } }),
    ];
    const matrix = buildContactExportMatrix(
      rows,
      ['custom_fields'],
      [
        { id: 'f1', field_name: 'Plano' },
        { id: 'f2', field_name: 'Estado' },
      ],
      labels
    );
    expect(matrix[0]).toEqual(['Plano', 'Estado']);
    expect(matrix[1]).toEqual(['Ouro', 'SP']);
    expect(matrix[2]).toEqual(['Prata', '']);
  });
});

describe('buildContactExportMatrix — notas', () => {
  it('concatena notas com [dd/MM/yyyy] na frente, mais recente primeiro, separadas por quebra de linha', () => {
    const rows = [
      makeRow({
        notes: [
          { created_at: '2026-08-10T14:30:00.000Z', note_text: 'Ligar amanhã' },
          {
            created_at: '2026-08-01T09:00:00.000Z',
            note_text: 'Primeiro contato',
          },
        ],
      }),
    ];
    const matrix = buildContactExportMatrix(rows, ['notes'], [], labels);
    expect(matrix[1][0]).toBe(
      '[10/08/2026] Ligar amanhã\n[01/08/2026] Primeiro contato'
    );
  });

  it('sem notas, a célula fica vazia', () => {
    const rows = [makeRow({ notes: [] })];
    const matrix = buildContactExportMatrix(rows, ['notes'], [], labels);
    expect(matrix[1][0]).toBe('');
  });
});

describe('buildContactExportMatrix — janela de 24h', () => {
  it('canal sem janela (QR) vira "não se aplica", nunca "fechada"', () => {
    const rows = [makeRow({ sessionWindowOpen: null })];
    const matrix = buildContactExportMatrix(
      rows,
      ['last_interaction'],
      [],
      labels
    );
    expect(matrix[1][1]).toBe('Não se aplica');
  });

  it('janela aberta/fechada refletem o boolean quando aplicável', () => {
    const rows = [
      makeRow({ sessionWindowOpen: true }),
      makeRow({ sessionWindowOpen: false }),
    ];
    const matrix = buildContactExportMatrix(
      rows,
      ['last_interaction'],
      [],
      labels
    );
    expect(matrix[1][1]).toBe('Aberta');
    expect(matrix[2][1]).toBe('Fechada');
  });

  it('última interação vazia quando nunca houve mensagem', () => {
    const rows = [makeRow({ lastMessageAt: null })];
    const matrix = buildContactExportMatrix(
      rows,
      ['last_interaction'],
      [],
      labels
    );
    expect(matrix[1][0]).toBe('');
  });
});

describe('buildContactExportMatrix — WhatsApp e consentimento', () => {
  it('mapeia whatsapp_status e o motivo traduzido', () => {
    const rows = [
      makeRow({
        contact: makeContact({
          whatsapp_status: 'invalid',
          whatsapp_status_reason: 'consecutive_failures',
        }),
      }),
    ];
    const matrix = buildContactExportMatrix(
      rows,
      ['whatsapp_status'],
      [],
      labels
    );
    expect(matrix[0]).toEqual(['whatsapp', 'whatsapp_motivo']);
    expect(matrix[1]).toEqual(['Inválido', 'Falhas consecutivas']);
  });

  it('sem status computado, célula vazia (não confunde com "invalid")', () => {
    const rows = [
      makeRow({ contact: makeContact({ whatsapp_status: undefined }) }),
    ];
    const matrix = buildContactExportMatrix(
      rows,
      ['whatsapp_status'],
      [],
      labels
    );
    expect(matrix[1]).toEqual(['', '']);
  });

  it('mapeia consentimento com origem e data, "desconhecido" quando ausente', () => {
    const rows = [
      makeRow({
        contact: makeContact({
          opt_in_status: 'opted_in',
          opt_in_source: 'manual',
          opt_in_updated_at: '2026-08-05T12:00:00.000Z',
        }),
      }),
      makeRow({ contact: makeContact({ opt_in_status: undefined }) }),
    ];
    const matrix = buildContactExportMatrix(rows, ['consent'], [], labels);
    expect(matrix[0]).toEqual([
      'consentimento',
      'origem_consentimento',
      'data_consentimento',
    ]);
    expect(matrix[1]).toEqual([
      'Optou por entrar',
      'Manual',
      '05/08/2026 12:00',
    ]);
    expect(matrix[2]).toEqual(['Desconhecido', '', '']);
  });
});

describe('buildContactExportMatrix — telefone E.164', () => {
  it('usa phone_normalized, vazio quando ausente', () => {
    const rows = [
      makeRow({ contact: makeContact({ phone_normalized: '5511900000001' }) }),
      makeRow({ contact: makeContact({ phone_normalized: undefined }) }),
    ];
    const matrix = buildContactExportMatrix(rows, ['phone_e164'], [], labels);
    expect(matrix[1][0]).toBe('5511900000001');
    expect(matrix[2][0]).toBe('');
  });
});
