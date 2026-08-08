'use client';

/**
 * Leitura de planilha sem congelar a aba (SPEC 044 §3.4).
 *
 * Os componentes pedem `parseFile(file)` ou `parseCsvText(text)` e
 * recebem uma `NormalizedAudience` — não sabem nada sobre fatiamento,
 * cancelamento ou descarte de resposta obsoleta.
 *
 * Por que NÃO é um Web Worker
 *
 *   A SPEC previa um Worker, e o plano era esse. Na verificação do
 *   build ficou claro que o Turbopack do Next 16 — o bundler padrão
 *   deste projeto — não empacota `new Worker(new URL('./x.ts',
 *   import.meta.url))`: ele emite o TypeScript CRU como asset em
 *   `/_next/static/media/x.ts` e o navegador quebra ao carregar. Foi
 *   confirmado em build de produção, com o caminho relativo em duas
 *   formas (`./` e `../`), e os docs do Turbopack em
 *   `node_modules/next/dist/docs/.../08-turbopack.md` não listam Web
 *   Workers entre os recursos suportados.
 *
 *   As saídas seriam: (a) migrar o projeto inteiro para `--webpack`,
 *   (b) manter um worker em `public/` escrito em JS puro — o que
 *   duplicaria as regras de validação e dedupe, exatamente a
 *   duplicação que a SPEC evita, ou (c) processar na main thread
 *   cedendo o controle ao navegador entre lotes.
 *
 *   (c) é o que está aqui. Resolve o problema real — a aba continua
 *   respondendo e a barra de progresso anda — ao custo de um tempo
 *   total um pouco maior. Trocar o bundler do projeto por causa do
 *   passo de importação de audiência seria a cauda balançando o
 *   cachorro.
 *
 *   O que continua bloqueando por ~1-2 s num arquivo grande é a
 *   descompactação do `.xlsx` dentro do `read-excel-file`, que é uma
 *   chamada única e indivisível. O spinner cobre esse intervalo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MAX_AUDIENCE_ROWS,
  MAX_SPREADSHEET_BYTES,
  AudienceParseError,
} from '@/lib/audience/types';
import { createAudienceNormalizer } from '@/lib/audience/normalize';
import { parseAudienceCsv } from '@/lib/audience/parse-csv';
import { parseXlsxSheets } from '@/lib/audience/parse-xlsx';
import type { AudienceColumnMap } from '@/lib/audience/parse-csv';
import type { XlsxSheet } from '@/lib/audience/parse-xlsx';
import type {
  NormalizedAudience,
  ParseErrorCode,
  RawAudienceRow,
} from '@/lib/audience/types';

/**
 * Linhas normalizadas por lote antes de devolver o controle ao
 * navegador. 2 000 mantém cada lote na casa de poucos milissegundos —
 * bem abaixo do orçamento de 16 ms por quadro em máquina moderna, e
 * imperceptível mesmo em máquina lenta.
 */
const NORMALIZE_CHUNK = 2_000;

/** Abaixo disto o fatiamento é desnecessário: roda tudo de uma vez. */
const INLINE_ROW_LIMIT = 2_000;

export interface ParseFailure {
  code: ParseErrorCode;
  meta?: Record<string, string | number>;
}

export interface ParseOutcome {
  audience: NormalizedAudience;
  /** Só para XLSX. */
  sheetName?: string;
  sheetNames?: string[];
}

export interface ParseProgress {
  processed: number;
  total: number;
}

export interface ParseOptions {
  sheetName?: string;
  columns?: AudienceColumnMap;
}

export interface UseSpreadsheetParser {
  parsing: boolean;
  /** `null` fora de um parsing fatiado. */
  progress: ParseProgress | null;
  error: ParseFailure | null;
  result: ParseOutcome | null;
  parseFile: (file: File, options?: ParseOptions) => Promise<void>;
  parseCsvText: (text: string, options?: ParseOptions) => Promise<void>;
  reset: () => void;
}

function isXlsx(file: File): boolean {
  return /\.xlsx$/i.test(file.name);
}

function isCsv(file: File): boolean {
  return /\.csv$/i.test(file.name) || file.type === 'text/csv';
}

/**
 * Cede o controle ao navegador. `setTimeout` (macrotask) e não
 * `queueMicrotask`: microtasks rodam antes da pintura, então não
 * dariam ao navegador a chance de atualizar a barra de progresso —
 * seria fatiar sem nenhum dos benefícios.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function useSpreadsheetParser(): UseSpreadsheetParser {
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<ParseFailure | null>(null);
  const [result, setResult] = useState<ParseOutcome | null>(null);

  /**
   * Cada chamada incrementa. Um loop fatiado confere este valor entre
   * lotes e desiste se já não for o pedido corrente — é o que impede a
   * resposta de um arquivo trocado no meio de sobrescrever a do
   * arquivo novo, e o que cancela o trabalho no unmount.
   */
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalida qualquer loop em voo: o próximo `isCurrent` falha.
      requestIdRef.current += 1;
    };
  }, []);

  const isCurrent = useCallback(
    (requestId: number) =>
      mountedRef.current && requestId === requestIdRef.current,
    []
  );

  const begin = useCallback((): number => {
    requestIdRef.current += 1;
    setParsing(true);
    setProgress(null);
    setError(null);
    setResult(null);
    return requestIdRef.current;
  }, []);

  const fail = useCallback(
    (requestId: number, failure: ParseFailure) => {
      if (!isCurrent(requestId)) return;
      setError(failure);
      setParsing(false);
      setProgress(null);
    },
    [isCurrent]
  );

  const succeed = useCallback(
    (requestId: number, outcome: ParseOutcome) => {
      if (!isCurrent(requestId)) return;
      setResult(outcome);
      setParsing(false);
      setProgress(null);
    },
    [isCurrent]
  );

  /**
   * Normaliza em lotes, cedendo o controle entre eles. Devolve `null`
   * se o pedido foi substituído no meio do caminho.
   */
  const normalizeCooperatively = useCallback(
    async (
      requestId: number,
      rows: RawAudienceRow[]
    ): Promise<NormalizedAudience | null> => {
      const normalizer = createAudienceNormalizer();

      if (rows.length <= INLINE_ROW_LIMIT) {
        for (const row of rows) normalizer.push(row);
        return normalizer.finish();
      }

      for (let i = 0; i < rows.length; i += NORMALIZE_CHUNK) {
        const end = Math.min(i + NORMALIZE_CHUNK, rows.length);
        for (let j = i; j < end; j++) normalizer.push(rows[j]);

        if (!isCurrent(requestId)) return null;
        setProgress({ processed: end, total: rows.length });
        await yieldToBrowser();
        if (!isCurrent(requestId)) return null;
      }

      return normalizer.finish();
    },
    [isCurrent]
  );

  /** Converte qualquer coisa lançada no formato de erro tipado. */
  const toFailure = useCallback((err: unknown): ParseFailure => {
    if (err instanceof AudienceParseError) {
      return { code: err.code, meta: err.meta };
    }
    return { code: 'unreadable' };
  }, []);

  const runCsv = useCallback(
    async (requestId: number, text: string, options?: ParseOptions) => {
      try {
        const rows = parseAudienceCsv(text, options?.columns);
        const audience = await normalizeCooperatively(requestId, rows);
        if (audience) succeed(requestId, { audience });
      } catch (err) {
        fail(requestId, toFailure(err));
      }
    },
    [normalizeCooperatively, succeed, fail, toFailure]
  );

  const parseCsvText = useCallback(
    async (text: string, options?: ParseOptions) => {
      await runCsv(begin(), text, options);
    },
    [begin, runCsv]
  );

  const parseFile = useCallback(
    async (file: File, options?: ParseOptions) => {
      const requestId = begin();

      // Teto conferido ANTES de ler: rejeitar depois de carregar 40 MB
      // desperdiça exatamente a memória que estamos protegendo.
      if (file.size > MAX_SPREADSHEET_BYTES) {
        fail(requestId, {
          code: 'file_too_large',
          meta: { max: MAX_SPREADSHEET_BYTES, size: file.size },
        });
        return;
      }

      if (isCsv(file)) {
        try {
          const text = await file.text();
          if (!isCurrent(requestId)) return;
          await runCsv(requestId, text, options);
        } catch (err) {
          fail(requestId, toFailure(err));
        }
        return;
      }

      if (isXlsx(file)) {
        try {
          const buffer = await file.arrayBuffer();
          if (!isCurrent(requestId)) return;

          // Import dinâmico: o leitor de XLSX (~150 kB) só desce para
          // quem realmente abre um .xlsx — quem usa CSV ou Google
          // Sheets nunca baixa esse chunk.
          const { default: readXlsxFile } =
            await import('read-excel-file/browser');
          if (!isCurrent(requestId)) return;

          const sheets = (await readXlsxFile(buffer)) as unknown as XlsxSheet[];
          if (!isCurrent(requestId)) return;

          const { rows, sheetName, sheetNames } = parseXlsxSheets(sheets, {
            sheetName: options?.sheetName,
            columns: options?.columns,
          });

          const audience = await normalizeCooperatively(requestId, rows);
          if (audience) {
            succeed(requestId, { audience, sheetName, sheetNames });
          }
        } catch (err) {
          fail(requestId, toFailure(err));
        }
        return;
      }

      fail(requestId, { code: 'unsupported_format' });
    },
    [begin, fail, isCurrent, normalizeCooperatively, runCsv, succeed, toFailure]
  );

  const reset = useCallback(() => {
    requestIdRef.current += 1; // invalida qualquer loop em voo
    setParsing(false);
    setProgress(null);
    setError(null);
    setResult(null);
  }, []);

  return { parsing, progress, error, result, parseFile, parseCsvText, reset };
}

export { MAX_AUDIENCE_ROWS, MAX_SPREADSHEET_BYTES };
