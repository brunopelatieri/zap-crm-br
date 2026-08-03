'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { conversationTabPredicate, type ConversationTabId } from '@/lib/inbox/tabs';
import type { Conversation } from '@/types';

interface UseConversationFeedOptions {
  tab: ConversationTabId;
  /** `null` enquanto a sessão ainda resolve — o fetch aguarda. */
  userId: string | null;
  /**
   * Só busca quando `true`. As abas "Chat" e "Open" são lazy: a aba
   * que o agente ainda não abriu não gasta uma consulta — o pai
   * (`inbox/page.tsx`) vira isto para `true` na primeira visita e
   * mantém assim depois (o cache persiste ao trocar de aba).
   */
  enabled: boolean;
  /**
   * Bump para forçar um refetch — reconexão do WS, tab voltando a
   * ficar visível, ou o botão de atualizar manual. Mesmo mecanismo que
   * o `resyncToken` já usado no restante do Inbox.
   */
  resyncToken: number;
}

interface UseConversationFeedResult {
  conversations: Conversation[];
  /**
   * Exposto para o pai poder aplicar patches otimistas e rotear
   * eventos de realtime (mover uma conversa para/de este feed) sem
   * precisar de um refetch a cada evento.
   */
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  loading: boolean;
}

/**
 * Busca UM dos dois feeds de conversas do Inbox — "Chat" (atribuídas a
 * mim) ou "Open" (fila, sem dono) — com o predicado de
 * `lib/inbox/tabs.ts` aplicado NA QUERY, não filtrado depois em
 * memória. Isso importa: cada aba tem sua própria contagem e sua
 * própria fonte de verdade, então misturar os dois num array só e
 * filtrar no cliente daria contagens erradas na primeira renderização
 * e manteria em memória linhas que aquela aba não deveria ter.
 *
 * A visibilidade REAL (tenancy + "sou o dono, ou está livre, ou sou
 * admin") é imposta pela RLS da migração 039
 * (`can_access_conversation` / `conversations_select`) — o predicado
 * aqui só escolhe qual fatia do que o servidor já deixaria ver.
 *
 * O pai (`inbox/page.tsx`) chama este hook DUAS VEZES, uma por aba
 * conversacional, e é quem faz o roteamento de eventos realtime entre
 * as duas instâncias — este hook não sabe da outra aba.
 */
export function useConversationFeed({
  tab,
  userId,
  enabled,
  resyncToken,
}: UseConversationFeedOptions): UseConversationFeedResult {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled || !userId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      const predicate = conversationTabPredicate(tab, userId);
      const base = supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .order('last_message_at', { ascending: false });
      const query =
        predicate.op === 'eq'
          ? base.eq(predicate.column, predicate.value)
          : base.is(predicate.column, predicate.value);

      const { data, error } = await query;

      if (cancelled) return;

      if (error) {
        // Erros do Supabase têm propriedades não-enumeráveis — logar os
        // campos explicitamente, senão a mensagem no console vira `{}`.
        console.error(`[inbox] failed to fetch "${tab}" feed:`, {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      setConversations(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` força o refetch em reconexão/visibilidade; `enabled`
    // é o que faz a aba ainda não visitada não gastar rede nenhuma.
  }, [tab, userId, enabled, resyncToken]);

  return { conversations, setConversations, loading };
}
