/**
 * Validação da `AudienceConfig` e do mapa de variáveis vindos de FORA do
 * TypeScript (SPEC 044 §6.1, §6.3).
 *
 * Dois consumidores, um validador
 *
 *   1. `POST /api/broadcasts/send` — o corpo veio pela rede e quem posta
 *      pode mandar o que quiser.
 *   2. `GET /api/broadcasts/cron` — o `audience_filter` veio do JSONB de
 *      `broadcasts`, gravado por nós mesmos… meses antes, por uma versão
 *      anterior deste código. Um agendamento é o único caminho em que um
 *      objeto persistido volta a comandar um envio; confiar nele porque
 *      "nós escrevemos" é confiar na versão do app que já não roda.
 *
 *   Extraído da rota quando o cron apareceu: duas cópias do mesmo
 *   validador divergiriam, e a divergência apareceria como "o disparo
 *   imediato recusou e o agendado deixou passar".
 */

import {
  type AudienceConfig,
  type CustomFieldOperator,
} from '@/lib/audience/estimate';
import { AB_DEFAULT_SPLIT_PERCENT } from '@/lib/broadcasts/ab-test';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import {
  MAX_DASHBOARD_RECIPIENTS,
  type AbVariantInput,
} from '@/lib/whatsapp/broadcast-dispatch';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';

const AUDIENCE_TYPES = [
  'all',
  'tags',
  'custom_field',
  'csv',
  'staged',
] as const;

const CUSTOM_FIELD_OPERATORS: CustomFieldOperator[] = [
  'is',
  'is_not',
  'contains',
];

const VARIABLE_TYPES = ['static', 'field', 'custom_field'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

/**
 * Valida uma `AudienceConfig`.
 *
 * Devolve `null` quando a forma não fecha — o chamador responde 400 (ou,
 * no cron, marca o agendamento como falho) em vez de deixar um objeto
 * meio construído chegar ao SQL.
 */
export function parseAudienceConfig(raw: unknown): AudienceConfig | null {
  if (!isRecord(raw)) return null;

  const type = raw.type;
  if (
    typeof type !== 'string' ||
    !(AUDIENCE_TYPES as readonly string[]).includes(type)
  ) {
    return null;
  }

  const audience: AudienceConfig = {
    type: type as AudienceConfig['type'],
    tagIds: stringArray(raw.tagIds),
    excludeTagIds: stringArray(raw.excludeTagIds),
  };

  if (type === 'custom_field') {
    const cf = raw.customField;
    if (!isRecord(cf)) return null;
    if (
      typeof cf.fieldId !== 'string' ||
      typeof cf.value !== 'string' ||
      typeof cf.operator !== 'string' ||
      !CUSTOM_FIELD_OPERATORS.includes(cf.operator as CustomFieldOperator)
    ) {
      return null;
    }
    audience.customField = {
      fieldId: cf.fieldId,
      operator: cf.operator as CustomFieldOperator,
      value: cf.value,
    };
  }

  if (type === 'csv') {
    if (!Array.isArray(raw.csvContacts)) return null;
    // O teto vale já na borda: uma lista maior do que isso é rejeitada
    // antes de virar milhares de linhas em memória no servidor.
    if (raw.csvContacts.length > MAX_DASHBOARD_RECIPIENTS) return null;

    const rows: { phone: string; name?: string }[] = [];
    for (const row of raw.csvContacts) {
      if (!isRecord(row) || typeof row.phone !== 'string') continue;
      rows.push({
        phone: row.phone,
        name: typeof row.name === 'string' ? row.name : undefined,
      });
    }
    if (rows.length === 0) return null;
    audience.csvContacts = rows;
  }

  if (type === 'tags' && !audience.tagIds) return null;

  if (type === 'staged') {
    if (typeof raw.draftId !== 'string' || !raw.draftId) return null;
    audience.draftId = raw.draftId;
  }

  return audience;
}

export interface AbTestRequest {
  variant: AbVariantInput;
  /** Fatia da audiência para a variante A (1–99). */
  splitPercent: number;
}

/**
 * Lê a parte de teste A/B do corpo (SPEC 044 §6.6).
 *
 * `null` = não é um teste A/B. Malformado LANÇA, em vez de devolver
 * `null`: os dois consumidores desta função disparam de verdade, e
 * degradar silenciosamente um teste A/B pedido para um disparo simples
 * mandaria a campanha inteira com um único template sem ninguém saber.
 * O mesmo raciocínio do `parseSchedule` da rota de envio, pelo mesmo
 * motivo (um `scheduledAt` inválido nunca vira "enviar agora").
 */
export function parseAbTest(raw: unknown): AbTestRequest | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new BroadcastError('bad_request', "'abTest' must be an object", 400);
  }

  const templateName =
    typeof raw.templateName === 'string' ? raw.templateName.trim() : '';
  if (!templateName) {
    throw new BroadcastError(
      'bad_request',
      "'abTest.templateName' is required",
      400
    );
  }

  const variables = parseVariableMap(raw.variables);
  if (!variables) {
    throw new BroadcastError(
      'bad_request',
      "'abTest.variables' is malformed",
      400
    );
  }

  // Percentual fora da faixa é recusado, não corrigido: um cliente que
  // manda 0 % pediu alguma coisa que este produto não faz, e "corrigir"
  // para 1 % entregaria um teste que ele não pediu.
  const rawSplit = raw.splitPercent;
  let splitPercent = AB_DEFAULT_SPLIT_PERCENT;
  if (rawSplit !== undefined && rawSplit !== null) {
    if (
      typeof rawSplit !== 'number' ||
      !Number.isInteger(rawSplit) ||
      rawSplit < 1 ||
      rawSplit > 99
    ) {
      throw new BroadcastError(
        'bad_request',
        "'abTest.splitPercent' must be an integer between 1 and 99",
        400
      );
    }
    splitPercent = rawSplit;
  }

  return {
    variant: {
      templateName,
      templateLanguage:
        typeof raw.templateLanguage === 'string' && raw.templateLanguage
          ? raw.templateLanguage
          : 'en_US',
      variables,
      headerMediaUrl:
        typeof raw.headerMediaUrl === 'string' ? raw.headerMediaUrl : undefined,
    },
    splitPercent,
  };
}

/** Mesma ideia para o mapeamento de variáveis. `null` = malformado. */
export function parseVariableMap(
  raw: unknown
): Record<string, VariableMapping> | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;

  const out: Record<string, VariableMapping> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) return null;
    const { type, value: v } = value;
    if (
      typeof type !== 'string' ||
      !(VARIABLE_TYPES as readonly string[]).includes(type) ||
      typeof v !== 'string'
    ) {
      return null;
    }
    out[key] = { type, value: v } as VariableMapping;
  }
  return out;
}
