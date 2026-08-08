/**
 * Pipeline de normalização da audiência (SPEC 044 §3.5).
 *
 * Ordem fixa, e a ordem importa:
 *
 *   1. sanitizar  — `sanitizePhoneForMeta` (dígitos apenas)
 *   2. validar    — `isValidE164`
 *   3. deduplicar — por chave canônica `normalizeKey`
 *
 * Sanitizar antes de validar é o que faz "+55 (11) 98888-7777" e
 * "5511988887777" serem a mesma coisa. Deduplicar por último é o que
 * faz um número inválido repetido ser reportado como inválido (o
 * problema real) e não como duplicata (um sintoma).
 *
 * Nada é descartado em silêncio: toda linha rejeitada sai em `invalid`
 * com o número da linha original e o motivo. Um import que diz "31
 * linhas ignoradas" sem dizer quais é um import que o usuário não tem
 * como corrigir.
 *
 * As mesmas funções de telefone usadas no envio (`phone-utils`) são
 * usadas aqui de propósito — assim não existe "válido na tela,
 * rejeitado pela Meta".
 */

import { normalizeKey } from '@/lib/contacts/dedupe';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type {
  InvalidRow,
  NormalizedAudience,
  NormalizedAudienceRow,
  RawAudienceRow,
} from './types';

/** Acumulador incremental — ver `createAudienceNormalizer`. */
export interface AudienceNormalizer {
  /** Processa uma linha crua. */
  push: (raw: RawAudienceRow) => void;
  /** Fecha o acumulador e devolve o resultado. */
  finish: () => NormalizedAudience;
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
export function createAudienceNormalizer(): AudienceNormalizer {
  const rows: NormalizedAudienceRow[] = [];
  const invalid: InvalidRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let read = 0;

  return {
    push(raw: RawAudienceRow) {
      read++;
      const rawPhone = (raw.phone ?? '').trim();

      if (!rawPhone) {
        invalid.push({
          sourceRow: raw.sourceRow,
          rawPhone,
          name: raw.name,
          reason: 'missing_phone',
        });
        return;
      }

      const phone = sanitizePhoneForMeta(rawPhone);

      if (!isValidE164(phone)) {
        invalid.push({
          sourceRow: raw.sourceRow,
          rawPhone,
          name: raw.name,
          reason: 'invalid_phone',
        });
        return;
      }

      const key = normalizeKey(phone);
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
        phone,
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
  rawRows: RawAudienceRow[]
): NormalizedAudience {
  const normalizer = createAudienceNormalizer();
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
