// ============================================================
// Inserção de texto na posição do cursor — pura, sem React e sem DOM.
//
// Mora fora do composer por dois motivos:
//
//   1. É a única regra do seletor de emojis capaz de CORROMPER o
//      rascunho do atendente. Um índice fora de faixa produz string
//      com `undefined` no meio; um caret contado em grafemas em vez de
//      unidades UTF-16 para no MEIO de uma sequência ZWJ, e a próxima
//      tecla digitada parte o emoji em dois.
//   2. `vitest.config.ts` roda em `environment: 'node'`, sem jsdom.
//      Regra pura é a única coisa que dá para testar de verdade aqui —
//      foco e caret real ficam para o checklist manual da SPEC.
//
// O contrato é deliberadamente DIFERENTE do de `handlePickQuickReply`
// no composer, que anexa o snippet ao fim com quebra de linha: emoji é
// pontuação de frase e precisa cair onde o cursor está, sem separador.
// Não unifique as duas funções.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Uso
// ============================================================

/** Estado do campo de texto no momento da inserção. */
export interface CursorSelection {
  value: string;
  /**
   * `null` quando o campo nunca recebeu foco — não há cursor, e o
   * texto vai para o fim.
   */
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface InsertResult {
  value: string;
  /** Onde deixar o cursor: logo depois do texto inserido. */
  caret: number;
}

/**
 * Índice de seleção saneado para [0, max].
 *
 * O `fallback` recebido (e não `0`, nem `max`) é o que evita o pior
 * caso: com `selectionStart` ausente ou `NaN` e `selectionEnd` válido,
 * cair em `0` apagaria TODO o texto até o cursor. O fallback do início
 * é sempre o fim da seleção, então a degradação é "cursor recolhido",
 * nunca "apaga um trecho".
 *
 * `Math.trunc` porque um índice fracionário (vindo de aritmética
 * errada no chamador) faria `slice` truncar de forma inconsistente
 * entre as duas pontas.
 */
function sanitizeIndex(
  index: number | null | undefined,
  fallback: number,
  max: number
): number {
  if (index === null || index === undefined || !Number.isFinite(index)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/**
 * Insere `insert` na posição do cursor, substituindo a seleção quando
 * houver, e devolve o novo valor + onde o caret deve ficar.
 *
 * Garantias:
 *
 *   - índices fora de `[0, value.length]` são clampados, então um
 *     `selectionStart` obsoleto (o textarea encolheu enquanto o
 *     popover estava aberto) não produz string quebrada;
 *   - seleção invertida (`start > end`) é normalizada TROCANDO as
 *     pontas, preservando a semântica "o trecho selecionado é
 *     substituído" que o DOM garante mas um chamador pode furar;
 *   - `caret` é contado em unidades UTF-16 (`insert.length`), que é a
 *     unidade que `setSelectionRange` entende — 👨‍👩‍👧 avança 8, não 1.
 */
export function insertAtCursor(
  selection: CursorSelection,
  insert: string
): InsertResult {
  const { value } = selection;
  const max = value.length;

  const end = sanitizeIndex(selection.selectionEnd, max, max);
  const start = sanitizeIndex(selection.selectionStart, end, max);

  const from = Math.min(start, end);
  const to = Math.max(start, end);

  return {
    value: value.slice(0, from) + insert + value.slice(to),
    caret: from + insert.length,
  };
}
