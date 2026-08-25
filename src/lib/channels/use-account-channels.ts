'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Channel } from './types';

/**
 * Canais da conta, indexados por id — para a UI resolver a que canal
 * pertence cada conversa.
 *
 * ## Por que não um embed
 *
 * O caminho óbvio seria acrescentar `channel:channels(*)` ao
 * `CONVERSATION_SELECT`. Duas razões contra:
 *
 *   1. `lib/channels/send.ts` já documenta a armadilha: o cache de
 *      schema do PostgREST devolve `PGRST200` para um relacionamento
 *      recém-criado, e a 059 é nova. Ali o custo de errar é uma
 *      consulta; aqui seria a LISTA INTEIRA do inbox falhando.
 *   2. Uma conta tem um punhado de canais e centenas de conversas.
 *      Buscar os canais UMA vez e cruzar em memória é menos trabalho
 *      que repetir o join em cada linha.
 *
 * O escopo de conta vem da RLS (`channels_select` = `is_account_member`,
 * migração 055), não de um filtro daqui.
 *
 * ## Cache
 *
 * Canal muda quando alguém pareia ou exclui uma instância — raro, e
 * sempre em outra tela. O resultado é memoizado no módulo para que a
 * lista e a thread não busquem duas vezes; `refreshAccountChannels()`
 * existe para quem mexer nos canais invalidar de propósito.
 */
export interface AccountChannels {
  byId: Map<string, Channel>;
  /** Quantos canais a conta tem. A UI usa isto para decidir se vale
   *  mostrar o selo: com um canal só, ele é ruído em toda linha. */
  count: number;
  loading: boolean;
}

let cache: Promise<Channel[]> | null = null;

function loadChannels(): Promise<Channel[]> {
  if (!cache) {
    cache = (async () => {
      const { data, error } = await createClient().from('channels').select('*');
      if (error) {
        // Não propaga: sem canais a UI cai no comportamento anterior
        // (assume oficial), que é a verdade de toda conta que só usa
        // o Cloud. Quebrar o inbox por causa de um selo seria pior.
        // Zera o cache para que a próxima montagem tente de novo.
        console.error('[channels] falha ao carregar canais:', error.message);
        cache = null;
        return [];
      }
      return (data ?? []) as Channel[];
    })();
  }
  return cache;
}

/** Invalida o cache — chamar depois de criar/excluir/renomear canal. */
export function refreshAccountChannels(): void {
  cache = null;
}

export function useAccountChannels(): AccountChannels {
  const [channels, setChannels] = useState<Channel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadChannels().then((rows) => {
      if (!cancelled) setChannels(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Memoizado por `channels` (SPEC 056): sem isto, todo chamador recebe
  // um objeto NOVO — Map e tudo — a cada render. Inofensivo para quem só
  // lê no corpo do render, mas qualquer `useEffect`/`useCallback` que
  // dependa do objeto inteiro (não de `count`/`loading` isolados) refaz
  // a cada render, dispara `setState`, re-renderiza, gera outro objeto
  // novo — loop infinito. Foi exatamente o que travou o diálogo de
  // transferência (`use-transfer-channels.ts`) em "Verificando canais
  // disponíveis…" para sempre, com o toast de erro reaparecendo em
  // segundo plano.
  return useMemo(
    () => ({
      byId: new Map((channels ?? []).map((c) => [c.id, c])),
      count: channels?.length ?? 0,
      loading: channels === null,
    }),
    [channels]
  );
}

/**
 * Tipo do canal de uma conversa, com o padrão histórico.
 *
 * `whatsapp_cloud` na ausência de informação é a verdade de toda
 * conversa criada antes da 059 e de toda conta que nunca pareou uma
 * instância — e é o padrão CONSERVADOR para a janela de 24h: assumir
 * que a janela se aplica no máximo mostra um aviso a mais; assumir que
 * não se aplica esconderia um limite real da Meta.
 */
export function channelTypeOf(
  channels: AccountChannels,
  channelId: string | null | undefined
): Channel['type'] {
  if (!channelId) return 'whatsapp_cloud';
  return channels.byId.get(channelId)?.type ?? 'whatsapp_cloud';
}
