import { describe, expect, it } from 'vitest';
import { normalizeAudience } from './normalize';
import { AUDIENCE_COLUMNS, parseAudienceCsv } from './parse-csv';
import { buildAudienceTemplateCsv } from './template-file';

describe('buildAudienceTemplateCsv', () => {
  it('usa o cabeçalho canônico de cada coluna conhecida', () => {
    const [header] = buildAudienceTemplateCsv().split('\r\n');

    expect(header.split(',')).toEqual(
      AUDIENCE_COLUMNS.map((column) => column.aliases[0])
    );
  });

  it('é lido pelo próprio parser sem nenhuma linha rejeitada', () => {
    // O ponto do teste: um modelo que o parser recusa é pior que não
    // ter modelo — o usuário preenche a planilha inteira antes de
    // descobrir. Se uma coluna mudar de nome, isto quebra aqui.
    const audience = normalizeAudience(
      parseAudienceCsv(buildAudienceTemplateCsv())
    );

    expect(audience.invalid).toEqual([]);
    expect(audience.stats.valid).toBe(audience.stats.read);
    expect(audience.stats.valid).toBeGreaterThan(0);
  });

  it('traz as colunas opcionais preenchidas nos exemplos', () => {
    const [row] = normalizeAudience(
      parseAudienceCsv(buildAudienceTemplateCsv())
    ).rows;

    expect(row).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      company: expect.any(String),
    });
    expect(row.tagNames.length).toBeGreaterThan(0);
  });
});
