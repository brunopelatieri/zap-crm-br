/**
 * Leitura tolerante a grafia dos payloads da Evolution Go.
 *
 * Por que existe
 *
 *   O servidor é Go sobre whatsmeow e serializa TRÊS convenções de nome
 *   dentro do MESMO webhook:
 *
 *     `encoding/json` sobre struct Go  → `Info`, `Chat`, `IsFromMe`, `ID`
 *     protojson sobre o proto da msg   → `audioMessage`, `mediaKey`, `URL`
 *     campos do próprio envelope       → `event`, `instanceId`, `state`
 *
 *   Enumerar cada variante à mão foi exatamente o que deixou o áudio
 *   chegar sem mídia: o código procurava `url` e `mediaUrl`, e o servidor
 *   mandou `URL`. Procurar sem diferenciar caixa elimina a classe inteira
 *   de erro de uma vez — e é seguro porque nenhum payload da Evolution
 *   tem duas chaves que diferem só por maiúscula (seriam ambíguas para o
 *   próprio Go, que não permite dois campos com o mesmo nome).
 *
 * O caminho rápido (`name in obj`) atende o caso comum sem varrer as
 * chaves; a varredura só acontece quando a grafia exata não bate.
 */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Primeiro valor cujo nome bate com um dos `names`, ignorando caixa. */
export function pickKey(
  obj: Record<string, unknown> | null | undefined,
  ...names: string[]
): unknown {
  if (!obj) return undefined;

  for (const name of names) {
    if (name in obj) return obj[name];
  }

  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * String não-vazia, ou `null`.
 *
 * O vazio é tratado como ausência de propósito: um `ID: ""` ou um
 * `caption: ""` vindo do provedor não carrega informação, e deixá-lo
 * passar transformaria "campo não veio" em "campo veio vazio" lá na
 * frente — a diferença entre descartar um evento e gravar uma bolha em
 * branco.
 */
export function pickString(
  obj: Record<string, unknown> | null | undefined,
  ...names: string[]
): string | null {
  const value = pickKey(obj, ...names);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function pickRecord(
  obj: Record<string, unknown> | null | undefined,
  ...names: string[]
): Record<string, unknown> | null {
  return asRecord(pickKey(obj, ...names));
}

/** `true`/`false` explícito, ou `null` quando o campo não veio. Aceita as
 *  strings `"true"`/`"false"` porque o envelope da Evolution já entregou
 *  booleanos como string em outros campos (`rabbitmqEnable: "enabled"`). */
export function pickBoolean(
  obj: Record<string, unknown> | null | undefined,
  ...names: string[]
): boolean | null {
  const value = pickKey(obj, ...names);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}
