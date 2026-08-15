/**
 * Pipeline de normalização da audiência (SPEC 044 §3.5, SPEC 052 D-2).
 *
 * Ordem fixa, e a ordem importa:
 *
 *   1. validar    — `normalizeContactPhone` (sanitiza E valida numa
 *      chamada só — a SPEC 050 já faz as duas coisas)
 *   2. deduplicar — por chave canônica `normalizeKey`
 *
 * Deduplicar por último é o que faz um número inválido repetido ser
 * reportado como inválido (o problema real) e não como duplicata (um
 * sintoma).
 *
 * Nada é descartado em silêncio: toda linha rejeitada sai em `invalid`
 * com o número da linha original e o motivo. Um import que diz "31
 * linhas ignoradas" sem dizer quais é um import que o usuário não tem
 * como corrigir.
 *
 * O validador é parametrizável (`validate`), mas o padrão para os dois
 * consumidores — contatos e audiência — é `normalizeContactPhone`
 * (SPEC 050): antes da SPEC 052, a audiência validava só com
 * `isValidE164`, então o mesmo `19992496598` virava um telefone válido
 * de DDI 19 aqui e um `5519992496598` correto do lado de contatos —
 * duas normalizações diferentes para a mesma planilha (SPEC 052 §2.2
 * achado J). Ver SPEC 052 D-2 para a tabela de comportamento antes/depois.
 */

import { normalizeKey } from '@/lib/contacts/dedupe';
import { normalizeContactPhone } from '@/lib/phone/br';
import type { PhoneNormalizeResult } from '@/lib/phone/br';
import type {
  InvalidRow,
  NormalizedAudience,
  NormalizedAudienceRow,
  RawAudienceRow,
} from './types';

/** Acumulador incremental — ver `createRowNormalizer`. */
export interface AudienceNormalizer {
  /** Processa uma linha crua. */
  push: (raw: RawAudienceRow) => void;
  /** Fecha o acumulador e devolve o resultado. */
  finish: () => NormalizedAudience;
}

export interface RowNormalizerOptions {
  /**
   * Validador de telefone. Padrão `normalizeContactPhone` (SPEC 050,
   * D-2) — os dois consumidores (contatos e audiência) usam a mesma
   * regra por padrão. Parametrizável para não travar quem por algum
   * motivo precise da validação genérica antiga (`isValidE164`).
   */
  validate?: (raw: string) => PhoneNormalizeResult;
}

/**
 * Normalizador incremental: uma linha por vez, estado acumulado.
 *
 * Existe nesta forma para que a versão síncrona (`normalizeAudience`)
 * e a fatiada usada pela UI (que cede o controle ao navegador a cada
 * N linhas para a aba não travar) compartilhem exatamente as mesmas
 * regras. Duas implementações das regras seria duas chances de
 * divergirem — e a divergência apareceria como "o mesmo arquivo dá
 * contagens diferentes dependendo do tamanho".
 *
 * Usa `normalizeKey` — a mesma chave canônica que `dedupeByPhone` usa
 * internamente e que a coluna gerada `contacts.phone_normalized`
 * (migração 022) armazena. A dedupe é reimplementada aqui em vez de
 * chamar `dedupeByPhone` porque aquela função devolve só a *contagem*
 * de duplicatas; a triagem precisa saber **quais** linhas caíram e por
 * quê. A semântica de "mesmo número" é idêntica.
 */
export function createRowNormalizer(
  options: RowNormalizerOptions = {}
): AudienceNormalizer {
  const validate = options.validate ?? normalizeContactPhone;
  const rows: NormalizedAudienceRow[] = [];
  const invalid: InvalidRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let read = 0;

  return {
    push(raw: RawAudienceRow) {
      read++;
      const rawPhone = (raw.phone ?? '').trim();
      const result = validate(rawPhone);

      if (!result.ok) {
        invalid.push({
          sourceRow: raw.sourceRow,
          rawPhone,
          name: raw.name,
          reason: result.reason,
        });
        return;
      }

      const key = normalizeKey(result.phone);
      if (seen.has(key)) {
        duplicates++;
        invalid.push({
          sourceRow: raw.sourceRow,
          rawPhone,
          name: raw.name,
          reason: 'duplicate_in_file',
        });
        return;
      }
      seen.add(key);

      rows.push({
        phone: result.phone,
        name: raw.name,
        email: raw.email,
        company: raw.company,
        tagNames: raw.tagNames ?? [],
        sourceRow: raw.sourceRow,
      });
    },

    finish(): NormalizedAudience {
      return {
        rows,
        invalid,
        stats: {
          read,
          valid: rows.length,
          duplicates,
          // Só os genuinamente malformados — duplicatas têm contador
          // próprio, senão o resumo soma mais que o total lido e
          // parece um bug.
          invalid: invalid.length - duplicates,
        },
      };
    },
  };
}

/** Normaliza, valida e deduplica linhas cruas de qualquer fonte. */
export function normalizeAudience(
  rawRows: RawAudienceRow[],
  options?: RowNormalizerOptions
): NormalizedAudience {
  const normalizer = createRowNormalizer(options);
  for (const raw of rawRows) normalizer.push(raw);
  return normalizer.finish();
}

/**
 * Converte a audiência normalizada na forma que `useBroadcastSending`
 * já consome (`AudienceConfig.csvContacts`). Ponte deliberada: o hook
 * de envio não muda de assinatura só porque a origem agora pode ser
 * uma planilha (SPEC 044 §1.6, compromisso 2).
 */
export function toCsvContacts(
  audience: NormalizedAudience
): { phone: string; name?: string }[] {
  return audience.rows.map((r) => ({ phone: r.phone, name: r.name }));
}
