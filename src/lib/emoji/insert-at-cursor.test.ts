import { describe, expect, it } from 'vitest';

import { insertAtCursor } from './insert-at-cursor';

// Os emojis de teste sao montados com String.fromCodePoint, e nao
// colados como literais, porque as sequencias que importam aqui
// carregam ZWJ (U+200D) -- um caractere INVISIVEL no editor. Colado,
// ele se perde num copiar/colar ou numa reformatacao sem deixar
// rastro, e o teste vira "tres emojis soltos" que passaria por outro
// motivo. Em code point explicito, o que esta sob teste esta a vista.

/** U+1F600 GRINNING FACE -- par surrogate simples: 2 unidades UTF-16. */
const GRINNING = String.fromCodePoint(0x1f600);

/** U+1F44D + U+1F3FD -- polegar com modificador de tom: 4 unidades UTF-16. */
const THUMBS_MEDIUM = String.fromCodePoint(0x1f44d, 0x1f3fd);

/**
 * Familia U+1F468 ZWJ U+1F469 ZWJ U+1F467 -- 8 unidades UTF-16 para
 * UM unico grafema percebido. E o caso que justifica a funcao contar
 * o caret em UTF-16 e nao em grafemas.
 */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);

describe('insertAtCursor', () => {
  it('insere em campo vazio', () => {
    const result = insertAtCursor(
      { value: '', selectionStart: 0, selectionEnd: 0 },
      GRINNING
    );

    expect(result).toEqual({ value: GRINNING, caret: 2 });
  });

  it('insere na posição do cursor, não no fim', () => {
    // "Bom dia| tudo bem" — cursor logo depois de "dia".
    const result = insertAtCursor(
      { value: 'Bom dia tudo bem', selectionStart: 7, selectionEnd: 7 },
      GRINNING
    );

    expect(result.value).toBe(`Bom dia${GRINNING} tudo bem`);
    expect(result.caret).toBe(9);
  });

  it('substitui o trecho selecionado', () => {
    // "Bom [dia] tudo" — seleção cobrindo "dia".
    const result = insertAtCursor(
      { value: 'Bom dia tudo', selectionStart: 4, selectionEnd: 7 },
      GRINNING
    );

    expect(result.value).toBe(`Bom ${GRINNING} tudo`);
    expect(result.caret).toBe(6);
  });

  it('anexa quando o cursor está no fim', () => {
    const result = insertAtCursor(
      { value: 'Obrigado', selectionStart: 8, selectionEnd: 8 },
      GRINNING
    );

    expect(result.value).toBe(`Obrigado${GRINNING}`);
    expect(result.caret).toBe(result.value.length);
  });

  it('anexa no fim quando o campo nunca recebeu foco (índices null)', () => {
    const result = insertAtCursor(
      { value: 'Obrigado', selectionStart: null, selectionEnd: null },
      GRINNING
    );

    expect(result.value).toBe(`Obrigado${GRINNING}`);
    expect(result.caret).toBe(result.value.length);
  });

  it('com só o início ausente, recolhe o cursor no fim da seleção — nunca apaga o trecho anterior', () => {
    const result = insertAtCursor(
      { value: 'Bom dia', selectionStart: null, selectionEnd: 3 },
      GRINNING
    );

    expect(result.value).toBe(`Bom${GRINNING} dia`);
    expect(result.caret).toBe(5);
  });

  it('clampa índices maiores que o texto sem gerar "undefined" na string', () => {
    const result = insertAtCursor(
      { value: 'oi', selectionStart: 100, selectionEnd: 200 },
      GRINNING
    );

    expect(result.value).toBe(`oi${GRINNING}`);
    expect(result.value).not.toContain('undefined');
    expect(result.caret).toBe(4);
  });

  it('clampa índices negativos', () => {
    const result = insertAtCursor(
      { value: 'oi', selectionStart: -5, selectionEnd: -2 },
      GRINNING
    );

    expect(result.value).toBe(`${GRINNING}oi`);
    expect(result.caret).toBe(2);
  });

  it('trata NaN sem apagar texto', () => {
    const result = insertAtCursor(
      { value: 'Bom dia', selectionStart: Number.NaN, selectionEnd: 3 },
      GRINNING
    );

    expect(result.value).toBe(`Bom${GRINNING} dia`);
    expect(result.caret).toBe(5);
  });

  it('normaliza seleção invertida trocando as pontas (start > end)', () => {
    // Invertida cobrindo "dia": o trecho ainda deve ser SUBSTITUÍDO.
    const result = insertAtCursor(
      { value: 'Bom dia tudo', selectionStart: 7, selectionEnd: 4 },
      GRINNING
    );

    expect(result.value).toBe(`Bom ${GRINNING} tudo`);
    expect(result.caret).toBe(6);
  });

  it('trunca índice fracionário', () => {
    const result = insertAtCursor(
      { value: 'Bom dia', selectionStart: 3.7, selectionEnd: 3.7 },
      GRINNING
    );

    expect(result.value).toBe(`Bom${GRINNING} dia`);
    expect(result.caret).toBe(5);
  });

  // O caso que motiva a função existir: caret em unidades UTF-16.
  // Contar grafemas deixaria o cursor NO MEIO da sequência ZWJ, e a
  // próxima tecla digitada partiria o emoji em dois.
  it('avança o caret em unidades UTF-16 num emoji com ZWJ', () => {
    expect(FAMILY.length).toBe(8);

    const result = insertAtCursor(
      { value: 'ola', selectionStart: 3, selectionEnd: 3 },
      FAMILY
    );

    expect(result.caret).toBe(3 + FAMILY.length);
    expect(result.caret).toBe(11);
    expect(result.value.slice(3)).toBe(FAMILY);
  });

  it('avança o caret pela sequência inteira num emoji com tom de pele', () => {
    expect(THUMBS_MEDIUM.length).toBe(4);

    const result = insertAtCursor(
      { value: '', selectionStart: 0, selectionEnd: 0 },
      THUMBS_MEDIUM
    );

    expect(result.caret).toBe(4);
    expect(result.value).toBe(THUMBS_MEDIUM);
  });

  it('encadeia duas inserções usando o caret devolvido pela primeira', () => {
    const first = insertAtCursor(
      { value: '', selectionStart: 0, selectionEnd: 0 },
      GRINNING
    );
    const second = insertAtCursor(
      {
        value: first.value,
        selectionStart: first.caret,
        selectionEnd: first.caret,
      },
      THUMBS_MEDIUM
    );

    expect(second.value).toBe(`${GRINNING}${THUMBS_MEDIUM}`);
    expect(second.caret).toBe(second.value.length);
  });

  it('não altera o objeto de seleção recebido', () => {
    const selection = {
      value: 'Bom dia',
      selectionStart: 3,
      selectionEnd: 3,
    };

    insertAtCursor(selection, GRINNING);

    expect(selection).toEqual({
      value: 'Bom dia',
      selectionStart: 3,
      selectionEnd: 3,
    });
  });
});
