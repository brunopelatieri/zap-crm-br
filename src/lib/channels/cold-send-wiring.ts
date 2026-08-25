/**
 * D-1 da SPEC 049 (§6.2) — ONDE o teto de envio frio verifica e
 * registra, e quem faz o quê.
 *
 * `cold-send-limit.ts` é o cálculo puro (parsing, veredito). Este
 * arquivo é a segunda metade do contrato do próprio cabeçalho daquele
 * módulo: "quem chama reúne o uso e executa a decisão".
 *
 * Só se aplica a canais sem `sessionWindow24h`
 *
 *   A Meta já regula o resto (janela, tier de mensagens) — contar de
 *   novo num canal Cloud confundiria a leitura da cota. `checkColdSend`
 *   devolve `applicable: false` e nunca toca o banco nesse caso.
 *
 * Três origens, três posturas (tabela da §6.2)
 *
 *   `engine`  (automação/flow/IA) — verifica E bloqueia. É a
 *             metralhadora que a §10.3 existe para frear.
 *   `human`   (inbox) — nunca bloqueia, só registra. Travar um agente
 *             no meio do atendimento é pior que o risco marginal de um
 *             envio manual.
 *   `api`     (API pública v1) — verifica E bloqueia com 429. Caminho
 *             automatizado por definição.
 *
 *   `checkColdSend` não sabe de origem — é o CHAMADOR (send.ts,
 *   send-message.ts) que decide o que fazer com a decisão. Isto mantém
 *   a postura de cada caminho legível no próprio caminho, em vez de
 *   escondida num parâmetro de comportamento aqui.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  readColdSendLimits,
  isColdSend,
  evaluateColdSend,
  describeDenial,
  type ColdSendDecision,
} from './cold-send-limit';
import { loadColdSendUsage } from './cold-send-usage';
import { can } from './capabilities';
import type { ChannelType } from './types';

export type ColdSendOrigin = 'engine' | 'human' | 'api';

export interface ColdSendCheck {
  /** O canal tem teto de envio frio? (falso em canais com janela da Meta.) */
  applicable: boolean;
  /** Só é `true` quando `applicable` e o silêncio ultrapassa o limiar. */
  cold: boolean;
  /** `null` quando `!applicable` ou `!cold` — não há decisão a tomar. */
  decision: ColdSendDecision | null;
}

/**
 * Este envio É frio, e nesse caso ele pode sair agora? Avalia SEM
 * gravar nada — `recordColdSend` é a segunda metade, chamada depois da
 * entrega confirmada (§6.1 ponto 4: contar antes transformaria uma
 * falha de rede em cota consumida).
 */
export async function checkColdSend(
  db: SupabaseClient,
  input: {
    channelId: string;
    channelType: ChannelType;
    /** Última mensagem DO CONTATO nesta conversa; `null` = nunca escreveu. */
    lastInboundAt: Date | null;
  },
  now: Date = new Date()
): Promise<ColdSendCheck> {
  if (can(input.channelType, 'sessionWindow24h')) {
    return { applicable: false, cold: false, decision: null };
  }

  const limits = readColdSendLimits();
  const cold = isColdSend(input.lastInboundAt, limits, now);
  if (!cold) return { applicable: true, cold: false, decision: null };

  const usage = await loadColdSendUsage(db, input.channelId, now);
  const decision = evaluateColdSend(limits, usage, now);
  return { applicable: true, cold: true, decision };
}

/**
 * Grava o consumo. Best-effort: a mensagem já foi entregue quando isto
 * roda — perder a linha subconta a cota, mas fingir que o envio falhou
 * seria o erro pior (mesmo princípio do INSERT em `sendAndPersistOutbound`).
 *
 * SEMPRE `supabaseAdmin()`, nunca um `db` de parâmetro: a 062 proíbe
 * QUALQUER policy de escrita em `channel_cold_sends` (só service_role),
 * então um `db` de sessão aqui é sempre "new row violates row-level
 * security policy" — foi exatamente o bug real que chegou em produção
 * quando os dois chamadores (envio pelo inbox, motor de automações)
 * passavam o próprio `db`. Escalar AQUI DENTRO, e não em cada call
 * site, é o que impede um terceiro chamador futuro de repetir o erro.
 *
 * O try/catch cobre não só o `.insert()` retornando `{error}` (already
 * handled abaixo) mas também `supabaseAdmin()` em si podendo LANÇAR na
 * construção do cliente (ex.: `SUPABASE_SERVICE_ROLE_KEY` ausente nesta
 * instância) — sem isso, best-effort vira "às vezes propaga", e a
 * mensagem já entregue voltaria como erro 500 pro chamador.
 */
export async function recordColdSend(input: {
  channelId: string;
  accountId: string;
  contactId: string | null;
  origin: ColdSendOrigin;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from('channel_cold_sends').insert({
      channel_id: input.channelId,
      account_id: input.accountId,
      contact_id: input.contactId,
      origin: input.origin,
    });
    if (error) {
      console.error(
        '[cold-send-wiring] failed to record cold send:',
        error.message
      );
    }
  } catch (err) {
    console.error(
      '[cold-send-wiring] failed to record cold send:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * O teto negou. Motivo legível pronto para `automation_logs`
 * (`describeDenial`), classe própria para o motor distinguir "cota
 * estourada" (adiamento, PRD §10.3) de qualquer outra falha.
 */
export class ColdSendLimitError extends Error {
  readonly decision: ColdSendDecision;
  constructor(decision: ColdSendDecision) {
    super(describeDenial(decision));
    this.name = 'ColdSendLimitError';
    this.decision = decision;
  }
}
