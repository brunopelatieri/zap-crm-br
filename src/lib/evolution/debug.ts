/**
 * Descritor estrutural de payload da Evolution Go — diagnóstico manual.
 *
 * Por que isto existe e não é `console.log(JSON.stringify(payload))`
 *
 *   A SPEC 048 §1 registra que a sondagem da F0 mediu só os endpoints de
 *   `/instance/*`: o envelope do webhook de MENSAGERIA nunca foi
 *   capturado contra o servidor real. Quando um nome de campo diverge, o
 *   sintoma não é erro — é mídia que não toca, eco que não chega, recibo
 *   que não avança. Ver a FORMA do payload é o que fecha a questão.
 *
 *   Um dump cru não serve para isso: com `WEBHOOK_FILES=true` (padrão da
 *   Evolution) um único áudio traz megabytes de base64, que inundam o
 *   terminal e o log do host. E o payload carrega `instanceToken` — o
 *   segredo que autentica a instância inteira. Este módulo resolve os
 *   dois: trunca valor longo mostrando o tamanho, e redige o que é
 *   credencial.
 *
 * Ligado por `EVOLUTION_DEBUG=true`. Fora isso não custa nada — a
 * checagem acontece antes de qualquer serialização.
 */

const MAX_STRING = 100;
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 3;

/**
 * Nunca imprimir por extenso. `instanceToken` autentica a instância;
 * `mediaKey`/`fileEncSHA256` são material de decriptação da mídia. Para
 * todos, saber que vieram e com que tamanho é o que interessa.
 */
const REDACTED_KEYS = new Set([
  'instancetoken',
  'token',
  'apikey',
  'mediakey',
  'fileencsha256',
  'filesha256',
]);

export function evolutionDebugEnabled(): boolean {
  return process.env.EVOLUTION_DEBUG === 'true';
}

function describeString(value: string): string {
  return value.length > MAX_STRING
    ? `"${value.slice(0, MAX_STRING)}…"(len=${value.length})`
    : JSON.stringify(value);
}

function describeValue(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return describeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= MAX_DEPTH) return `[…${value.length} itens]`;
    const shown = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => describeValue(item, depth + 1))
      .join(', ');
    const rest =
      value.length > MAX_ARRAY_ITEMS
        ? `, …+${value.length - MAX_ARRAY_ITEMS}`
        : '';
    return `[${shown}${rest}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    // No fundo da recursão, os NOMES das chaves ainda são a informação
    // que importa — é por eles que se descobre a grafia real.
    if (depth >= MAX_DEPTH) {
      return `{${entries
        .slice(0, MAX_KEYS)
        .map(([k]) => k)
        .join(', ')}}`;
    }
    const shown = entries
      .slice(0, MAX_KEYS)
      .map(([key, val]) => {
        if (REDACTED_KEYS.has(key.toLowerCase())) {
          const len = typeof val === 'string' ? val.length : null;
          return `${key}: ***${len !== null ? `(len=${len})` : ''}`;
        }
        return `${key}: ${describeValue(val, depth + 1)}`;
      })
      .join(', ');
    const rest =
      entries.length > MAX_KEYS
        ? `, …+${entries.length - MAX_KEYS} chaves`
        : '';
    return `{ ${shown}${rest} }`;
  }

  return typeof value;
}

/** Forma legível de um payload, com valores longos truncados e
 *  credenciais redigidas. Exportada à parte para poder ser testada. */
export function describeShape(value: unknown): string {
  return describeValue(value, 0);
}

export function evolutionDebugLog(label: string, value: unknown): void {
  if (!evolutionDebugEnabled()) return;
  console.log(`[evolution debug] ${label}: ${describeShape(value)}`);
}
