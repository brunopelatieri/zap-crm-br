import { describe, expect, it } from 'vitest';
import { mapAudienceColumns, parseAudienceCsv } from './parse-csv';
import { AudienceParseError } from './types';

describe('mapAudienceColumns', () => {
  it('reconhece cabeçalhos em inglês', () => {
    expect(mapAudienceColumns(['phone', 'name', 'email'])).toMatchObject({
      phone: 0,
      name: 1,
      email: 2,
    });
  });

  it('reconhece cabeçalhos em português', () => {
    // Uma planilha exportada de ferramenta brasileira traz "telefone";
    // obrigar a renomear para "phone" é atrito sem propósito.
    expect(
      mapAudienceColumns(['nome', 'telefone', 'empresa', 'etiquetas'])
    ).toMatchObject({ phone: 1, name: 0, company: 2, tags: 3 });
  });

  it('devolve -1 para coluna ausente', () => {
    expect(mapAudienceColumns(['phone']).email).toBe(-1);
  });
});

describe('parseAudienceCsv', () => {
  it('numera sourceRow contando o cabeçalho', () => {
    const csv = 'phone,name\n5511988887777,Maria\n5511977776666,João';
    const rows = parseAudienceCsv(csv);

    expect(rows.map((r) => r.sourceRow)).toEqual([2, 3]);
  });

  it('mantém a linha sem telefone para que seja reportada, não sumida', () => {
    const csv = 'phone,name\n,Maria\n5511977776666,João';
    const rows = parseAudienceCsv(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ phone: '', name: 'Maria', sourceRow: 2 });
  });

  it('preserva o número da linha original ao pular linhas em branco', () => {
    const csv = 'phone\n5511988887777\n\n5511977776666';
    const rows = parseAudienceCsv(csv);

    expect(rows.map((r) => r.sourceRow)).toEqual([2, 4]);
  });

  it('lida com campo entre aspas contendo vírgula', () => {
    const csv = 'phone,name,tags\n5511988887777,"Silva, Maria","vip, sp"';
    const rows = parseAudienceCsv(csv);

    expect(rows[0].name).toBe('Silva, Maria');
    expect(rows[0].tagNames).toEqual(['vip', 'sp']);
  });

  it('lida com CRLF', () => {
    const rows = parseAudienceCsv('phone\r\n5511988887777\r\n5511977776666');
    expect(rows).toHaveLength(2);
  });

  it('lida com BOM UTF-8 no início do arquivo', () => {
    // Excel exporta CSV com BOM; sem isso o cabeçalho vira "﻿phone".
    const rows = parseAudienceCsv('﻿phone,name\n5511988887777,Maria');
    expect(rows[0].phone).toBe('5511988887777');
  });

  it('rejeita planilha sem coluna de telefone', () => {
    expect(() => parseAudienceCsv('name,email\nMaria,m@x.com')).toThrowError(
      expect.objectContaining({ code: 'missing_phone_column' })
    );
  });

  it('rejeita arquivo sem linhas de dados', () => {
    expect(() => parseAudienceCsv('phone,name')).toThrowError(
      expect.objectContaining({ code: 'empty_file' })
    );
  });

  it('erro carrega código estável para a UI traduzir', () => {
    try {
      parseAudienceCsv('name\nMaria');
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(AudienceParseError);
      expect((err as AudienceParseError).code).toBe('missing_phone_column');
    }
  });

  it('aceita mapeamento explícito de colunas, ignorando o cabeçalho', () => {
    const csv = 'col_a,col_b\n5511988887777,Maria';
    const rows = parseAudienceCsv(csv, {
      phone: 0,
      name: 1,
      email: -1,
      company: -1,
      tags: -1,
    });

    expect(rows[0]).toMatchObject({ phone: '5511988887777', name: 'Maria' });
  });
});
