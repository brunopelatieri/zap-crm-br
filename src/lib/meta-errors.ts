/**
 * Catálogo dos códigos de erro da WhatsApp Cloud API (Meta) que podem
 * aparecer em `broadcast_recipients.error_message` / `messages.error_message`.
 *
 * Duas origens alimentam esse campo, com formatos DIFERENTES:
 *
 *   1. Assíncrona (webhook `statuses`, `app/api/whatsapp/webhook/route.ts`
 *      `handleStatusUpdate`) — já grava `(#<code>) <title>: <message>`.
 *      É o único lugar onde erros como 131026/131049/130472 aparecem: a
 *      Meta aceita o POST com 200 e só reporta a falha depois, por aqui.
 *
 *   2. Síncrona (rejeição imediata do POST, `throwMetaError` em
 *      `whatsapp/meta-api.ts`) — prefixa `(#<code>)` desde que essa
 *      lacuna foi fechada junto deste catálogo; antes disso a mensagem
 *      não carregava o código, só o texto da Meta.
 *
 * `matchMetaError` tenta extrair o código do prefixo `(#N)` primeiro
 * (confiável, funciona nos dois formatos acima) e só cai para
 * casamento por texto em linhas antigas do banco, gravadas antes da
 * correção em (2), que não têm o prefixo.
 */

export type MetaErrorCategory =
  | 'delivery_restriction'
  | 'rate_limit'
  | 'payload_media'
  | 'account_auth'
  | 'internal';

export interface MetaErrorEntry {
  /** Código canônico — é também a chave i18n em `Broadcasts.detail.metaErrors`. */
  code: string;
  /** Outros códigos que a Meta usa para o mesmo erro (ex.: 0 e 190 são o mesmo AuthException). */
  aliasCodes?: string[];
  category: MetaErrorCategory;
  /** Casamento por texto — só usado quando a mensagem não tem o prefixo `(#N)`. */
  textPattern: RegExp;
}

/**
 * 132000–132016 — família de erros de template. Gerado em vez de
 * escrito por extenso para não depender de manter 16 strings em
 * sincronia manualmente; reusa o mesmo mecanismo `aliasCodes` de todo
 * outro erro com mais de um código (ex.: 0/190), em vez de uma faixa
 * via regex à parte em `findByCode`.
 */
const TEMPLATE_ERROR_ALIASES = Array.from({ length: 16 }, (_, i) =>
  String(132001 + i)
);

export const META_ERROR_CATALOG: MetaErrorEntry[] = [
  // 1. Entrega e restrições de destinatário
  {
    code: '131026',
    category: 'delivery_restriction',
    // Inclui a variante "not a WhatsApp user/phone number" — mesmo
    // texto que `isInvalidWhatsappNumberError` (phone-utils.ts)
    // reconhece, que agora delega para cá em vez de manter sua
    // própria cópia da regra.
    textPattern: /message undeliverable|not a whatsapp (user|phone number)/i,
  },
  {
    code: '131047',
    category: 'delivery_restriction',
    textPattern: /24.?hour.*window|re-?engagement message/i,
  },
  {
    code: '131049',
    category: 'delivery_restriction',
    textPattern: /healthy ecosystem|ecosystem engagement/i,
  },
  {
    code: '131050',
    category: 'delivery_restriction',
    textPattern: /opted out|opt-out/i,
  },
  {
    code: '130472',
    category: 'delivery_restriction',
    textPattern: /part of an experiment/i,
  },
  {
    code: '130497',
    category: 'delivery_restriction',
    textPattern: /country.*not.*(supported|allowed)|not.*supported.*country/i,
  },
  {
    code: '131021',
    category: 'delivery_restriction',
    textPattern: /recipient.*same as.*sender|same as the sender/i,
  },
  {
    code: '131060',
    category: 'delivery_restriction',
    textPattern: /message unavailable/i,
  },

  // 2. Limite de taxa (rate limit) e spam
  {
    code: '130429',
    category: 'rate_limit',
    textPattern: /rate limit (hit|reached)/i,
  },
  {
    code: '131048',
    category: 'rate_limit',
    textPattern: /spam rate limit/i,
  },
  {
    code: '131056',
    category: 'rate_limit',
    textPattern: /pair rate limit/i,
  },
  {
    code: '80007',
    aliasCodes: ['4'],
    category: 'rate_limit',
    textPattern: /too many calls|application request limit/i,
  },

  // 3. Payload, templates e mídia — a entrada '132000' (família de
  // template, faixa 132000-132016 via `aliasCodes` abaixo) e as demais
  // vêm ANTES de '100': o padrão de '100' é deliberadamente genérico
  // (`/invalid parameter/i`) e bateria também no texto de um erro de
  // template real ("Invalid parameter: Template name does not exist
  // ..."). Ordem importa aqui porque `matchMetaError` devolve o
  // primeiro match no fallback por texto — ver seu cabeçalho.
  {
    code: '131008',
    category: 'payload_media',
    textPattern: /required parameter.*missing|missing.*required parameter/i,
  },
  {
    code: '131051',
    category: 'payload_media',
    textPattern: /unsupported message type/i,
  },
  {
    code: '131053',
    category: 'payload_media',
    textPattern: /media.*upload.*error|error uploading media/i,
  },
  {
    code: '131052',
    category: 'payload_media',
    textPattern: /media.*download.*error|error downloading media/i,
  },
  {
    code: '132000',
    aliasCodes: TEMPLATE_ERROR_ALIASES,
    category: 'payload_media',
    textPattern: /template.*(param|paused|rejected|does not exist|language)/i,
  },
  {
    code: '100',
    category: 'payload_media',
    textPattern: /invalid parameter/i,
  },

  // 4. Conta, autenticação e faturamento
  {
    code: '190',
    aliasCodes: ['0'],
    category: 'account_auth',
    textPattern: /access token.*(expired|invalid)|authexception/i,
  },
  {
    code: '131005',
    aliasCodes: ['10'],
    category: 'account_auth',
    textPattern: /permission.*denied|access.*denied/i,
  },
  {
    code: '131042',
    category: 'account_auth',
    textPattern: /payment.*(issue|error|declined|failed)/i,
  },
  {
    code: '131031',
    category: 'account_auth',
    textPattern: /account.*locked/i,
  },
  {
    code: '130403',
    aliasCodes: ['368'],
    category: 'account_auth',
    textPattern: /business.*(blocked|banned)/i,
  },

  // 5. Erros internos da Meta
  {
    code: '131000',
    category: 'internal',
    textPattern: /something went wrong/i,
  },
];

function findByCode(code: string): MetaErrorEntry | null {
  return (
    META_ERROR_CATALOG.find(
      (e) => e.code === code || e.aliasCodes?.includes(code)
    ) ?? null
  );
}

/**
 * Casa uma mensagem de erro (de `broadcast_recipients.error_message` ou
 * similar) contra o catálogo conhecido.
 *
 * Preferência de estratégia:
 *   1. Prefixo `(#N)` — confiável, cobre os dois formatos descritos no
 *      cabeçalho do arquivo. Quando presente, é a ÚNICA fonte de
 *      verdade: a Meta já disse explicitamente qual código é. Se esse
 *      código não estiver no catálogo, o resultado é "não reconhecido"
 *      — NÃO cai para o casamento por texto abaixo, porque um erro
 *      #N genuíno e desconhecido poderia coincidir por acaso com o
 *      texto de um erro #M completamente diferente já catalogado,
 *      rotulando a UI errado com mais confiança do que os dados têm.
 *   2. Casamento por texto — só entra em jogo quando NÃO há prefixo
 *      `(#N)` algum na mensagem: linhas gravadas antes da correção em
 *      `throwMetaError`, que não carregavam o código.
 *
 * @returns a entrada do catálogo, ou `null` se não reconhecido (o
 * chamador deve exibir a mensagem crua nesse caso).
 */
export function matchMetaError(
  errorMessage: string | null | undefined
): MetaErrorEntry | null {
  if (!errorMessage) return null;

  const codeMatch = errorMessage.match(/\(#(\d+)\)/);
  if (codeMatch) {
    return findByCode(codeMatch[1]);
  }

  for (const entry of META_ERROR_CATALOG) {
    if (entry.textPattern.test(errorMessage)) return entry;
  }

  return null;
}

/**
 * Atalho usado pela UI: devolve só a chave i18n (o `code` canônico),
 * ou `null` se a mensagem não bater com nenhuma entrada conhecida.
 */
export function getMetaErrorTranslationKey(
  errorMessage: string | null | undefined
): string | null {
  return matchMetaError(errorMessage)?.code ?? null;
}
