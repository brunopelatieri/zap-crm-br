'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Conversation } from '@/types';

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 *
 * ## Escopo: "minhas + a fila"  (decisão de produto — F-12 da SPEC de
 * abas, fechada na SPEC 041 §4)
 *
 * O `SELECT` abaixo não filtra por agente: ele devolve o que a RLS da
 * 039 deixar passar, que é "conversas atribuídas a mim" MAIS "a fila
 * sem dono" (e tudo, para admin/owner). O ponto verde acende, portanto,
 * também para conversa de ninguém.
 *
 * Isso é intencional, não um efeito colateral: a fila é trabalho a
 * fazer e o produto quer que alguém a pegue — um sino que só tocasse
 * para o que já é meu esconderia exatamente o que precisa de dono. Se
 * a decisão mudar, o conserto é um `.eq('assigned_agent_id', user.id)`
 * aqui.
 *
 * ## ⚠️ Revogação é SILÊNCIO, não evento  (F-41-D)
 *
 * O espelho incremental (`countsRef`) pressupõe que toda mudança
 * relevante chega como `postgres_changes`. A 039 quebrou a premissa:
 * quando a conversa é reatribuída para outro agente, o `UPDATE` deixa
 * de passar na `conversations_select` deste usuário — o Supabase aplica
 * a política por assinante — e ele **não recebe nada**. Sem o refetch
 * abaixo, o contador ficaria preso num número que inclui conversas que
 * o usuário não consegue mais abrir, até um F5.
 *
 * Mesma lição que o Inbox já aprendeu na reconciliação por ausência de
 * `inbox/page.tsx`, e os mesmos gatilhos: reconexão do WebSocket e
 * `visibilitychange`.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  // Bump para forçar a releitura completa. Mesmo mecanismo do
  // `resyncToken` do Inbox.
  const [resyncToken, setResyncToken] = useState(0);
  const resync = useCallback(() => setResyncToken((n) => n + 1), []);

  /**
   * Refetch quando a aba volta a ficar visível. Uma aba em segundo
   * plano pode ter o WS estrangulado pelo navegador mesmo sem
   * desconectar de vez, então `visible` é um sinal confiável de que
   * podemos ter perdido eventos.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [resync]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    /**
     * Releitura COMPLETA, substituindo o espelho — nunca mesclando.
     *
     * Substituir é o ponto todo: uma conversa que saiu do alcance do
     * usuário some do resultado, e só um `Map` novo a remove da
     * contagem. Mesclar preservaria justamente a entrada obsoleta que
     * este refetch existe para eliminar.
     */
    const loadAll = async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('id, unread_count');
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    };

    void loadAll();

    const channel = supabase
      .channel('total-unread-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, row.unread_count ?? 0);
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        }
      )
      .subscribe((status) => {
        // Reconexão: o canal volta a `SUBSCRIBED` depois de uma queda, e
        // tudo o que aconteceu na janela offline não gerou evento para
        // este cliente. Releitura completa é a única forma de convergir.
        if (status === 'SUBSCRIBED') void loadAll();
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [resyncToken]);

  return total;
}
