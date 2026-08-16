/**
 * Google Sheets por link publicado (SPEC 044 §3.2.2).
 *
 * Sem OAuth: o servidor pede o export CSV da planilha e entrega o texto
 * ao mesmo `parseAudienceCsv`. Zero dependência nova, zero token de
 * terceiro armazenado.
 *
 * A regra de segurança que governa este arquivo
 *
 *   A URL que o usuário cola NUNCA é usada para fazer a requisição.
 *   Extraímos o `spreadsheetId` e o `gid` por regex e RECONSTRUÍMOS a
 *   URL a partir de uma constante. Repassar a string colada
 *   transformaria este endpoint num proxy de requisições arbitrárias
 *   feito a partir do nosso servidor — SSRF clássico, com acesso à
 *   rede interna e aos metadados da instância. Validar o host da
 *   string colada não basta: `https://docs.google.com@attacker.tld/`
 *   e redirecionamentos derrotam essa checagem. Reconstruir, não.
 */

/** Host único permitido. Não é configurável de propósito. */
const SHEETS_HOST = 'https://docs.google.com';

/** Teto de download. Um CSV de 10 MB já passa de 100 k linhas. */
export const MAX_SHEET_BYTES = 10 * 1024 * 1024;

/** Uma planilha lenta não pode segurar um worker do servidor. */
export const SHEET_FETCH_TIMEOUT_MS = 15_000;

export interface SheetRef {
  spreadsheetId: string;
  /** Aba dentro da planilha. Ausente = primeira aba. */
  gid?: string;
}

/**
 * Ids do Google são `[a-zA-Z0-9-_]` com 20+ caracteres. Ancorar o
 * formato evita que um id "criativo" carregue caminho ou query para
 * dentro da URL reconstruída.
 */
const SPREADSHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/;
const GID_RE = /[#&?]gid=([0-9]+)/;

/**
 * Extrai `{ spreadsheetId, gid }` de uma URL do Google Sheets.
 * Devolve `null` para qualquer coisa que não case — nunca tenta
 * "consertar" a entrada.
 */
export function extractSheetRef(input: string): SheetRef | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // Primeira barreira: protocolo e host exatos. A segunda barreira — e
  // a que realmente vale — é a reconstrução em `buildSheetCsvUrl`.
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'docs.google.com') return null;

  const idMatch = SPREADSHEET_ID_RE.exec(url.pathname);
  if (!idMatch) return null;

  // O gid costuma vir no fragmento (#gid=0), que não vai ao servidor
  // numa navegação — mas aqui é uma string colada, então está presente.
  const gidMatch = GID_RE.exec(url.hash) ?? GID_RE.exec(url.search);

  return {
    spreadsheetId: idMatch[1],
    gid: gidMatch?.[1],
  };
}

/**
 * Monta a URL de export a partir de constantes + valores já validados.
 * Nada da string original do usuário sobrevive até aqui.
 */
export function buildSheetCsvUrl(ref: SheetRef): string {
  const url = new URL(
    `/spreadsheets/d/${ref.spreadsheetId}/export`,
    SHEETS_HOST
  );
  url.searchParams.set('format', 'csv');
  if (ref.gid) url.searchParams.set('gid', ref.gid);
  return url.toString();
}

/**
 * Uma planilha não compartilhada devolve 200 com a página de login em
 * HTML, não um 403. Sem esta checagem o parser receberia HTML e falharia
 * com "coluna de telefone ausente" — mandando o usuário procurar um
 * problema na planilha quando o problema é a permissão dela.
 */
export function looksLikeGoogleLoginPage(body: string): boolean {
  const head = body.slice(0, 2000).toLowerCase();
  return (
    head.includes('<html') &&
    (head.includes('accounts.google.com') ||
      head.includes('sign in') ||
      head.includes('fazer login'))
  );
}

export type SheetFetchErrorCode =
  | 'invalid_url'
  | 'not_public'
  | 'not_found'
  | 'too_large'
  | 'timeout'
  | 'fetch_failed';

export class SheetFetchError extends Error {
  readonly code: SheetFetchErrorCode;
  constructor(code: SheetFetchErrorCode, message: string) {
    super(message);
    this.name = 'SheetFetchError';
    this.code = code;
  }
}

/**
 * Host de CDN que o Google usa para SERVIR o export de uma planilha
 * pública — não é o host original, mas ainda é infraestrutura do
 * Google, e ainda é o host que a reconstrução da URL controla (chega
 * aqui só a partir de um `Location` que o próprio `docs.google.com`
 * devolveu, nunca a partir de entrada do usuário).
 */
function isGoogleUserContentHost(hostname: string): boolean {
  return (
    hostname === 'googleusercontent.com' ||
    hostname.endsWith('.googleusercontent.com')
  );
}

async function fetchOnce(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      // `manual` para decidir nós mesmos quais redirecionamentos
      // seguir — ver o porquê logo abaixo, em `fetchGoogleSheetCsv`.
      redirect: 'manual',
      headers: { Accept: 'text/csv,text/plain' },
      signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new SheetFetchError('timeout', 'A planilha demorou demais.');
    }
    throw new SheetFetchError(
      'fetch_failed',
      'Não foi possível ler a planilha.'
    );
  }
}

/**
 * Baixa o CSV de uma planilha pública. Roda **apenas no servidor** —
 * o navegador não consegue por causa do CORS do Google, e mesmo que
 * conseguisse não queremos a origem do usuário no meio.
 */
export async function fetchGoogleSheetCsv(input: string): Promise<string> {
  const ref = extractSheetRef(input);
  if (!ref) {
    throw new SheetFetchError(
      'invalid_url',
      'Não parece um link de planilha do Google Sheets.'
    );
  }

  let response = await fetchOnce(buildSheetCsvUrl(ref));

  // O endpoint /export de uma planilha PÚBLICA sempre responde 307
  // para um host `*.googleusercontent.com` — é assim que o Google
  // entrega o conteúdo, não um sintoma de "não está pública" (achado
  // verificado batendo direto no endpoint, 2026-08-15: o redirect
  // acontece com ou sem User-Agent de navegador, para qualquer
  // planilha compartilhada corretamente). Só ESSE host é seguido, e só
  // um salto — um redirecionamento para qualquer outro lugar (o caso
  // real de planilha privada é para `accounts.google.com`) ou uma
  // segunda cadeia de redirect cai no `not_public` abaixo, sem seguir
  // cegamente para fora do Google.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    let target: URL | null = null;
    try {
      target = location ? new URL(location) : null;
    } catch {
      target = null;
    }

    if (
      target &&
      target.protocol === 'https:' &&
      isGoogleUserContentHost(target.hostname)
    ) {
      response = await fetchOnce(target.toString());
    }
  }

  // Se ainda for um redirecionamento depois da tentativa acima, é o
  // sintoma real de planilha privada (redirect para o login do Google).
  if (response.status >= 300 && response.status < 400) {
    throw new SheetFetchError(
      'not_public',
      'A planilha não está compartilhada publicamente.'
    );
  }
  if (response.status === 404) {
    throw new SheetFetchError('not_found', 'Planilha não encontrada.');
  }
  if (!response.ok) {
    throw new SheetFetchError(
      'fetch_failed',
      `O Google respondeu ${response.status}.`
    );
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_SHEET_BYTES) {
    throw new SheetFetchError('too_large', 'A planilha é grande demais.');
  }

  const body = await response.text();

  // `content-length` costuma vir ausente num export gerado sob demanda,
  // então o teto precisa ser reconferido sobre o corpo já lido.
  if (body.length > MAX_SHEET_BYTES) {
    throw new SheetFetchError('too_large', 'A planilha é grande demais.');
  }
  if (looksLikeGoogleLoginPage(body)) {
    throw new SheetFetchError(
      'not_public',
      'A planilha não está compartilhada publicamente.'
    );
  }

  return body;
}
