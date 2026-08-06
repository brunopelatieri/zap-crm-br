'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Message, Conversation } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  /**
   * O que o Supabase manda para o lado "antes" do evento. Passado
   * adiante sem cortar nada — mas `Partial<T>` não é modéstia de tipo,
   * é a verdade: `conversations` roda com `REPLICA IDENTITY DEFAULT`
   * (o padrão), então em um `UPDATE` o Postgres só envia a CHAVE
   * PRIMÁRIA aqui, não a linha inteira. `old.id` está sempre presente;
   * `old.assigned_agent_id` (ou qualquer outra coluna) NÃO está,
   * mesmo que a policy deixe o chamador ler a linha.
   *
   * Por isso o roteamento de aba do Inbox (`inbox/page.tsx`) nunca lê
   * `old.assigned_agent_id` para decidir de onde uma conversa saiu —
   * ele compara o `new` contra o que o PRÓPRIO cliente já tinha em
   * cache. Só `notifications` tem `REPLICA IDENTITY FULL`
   * (027_notifications.sql:31); estender isso a `conversations` daria
   * `old` completo, mas é mudança de banco — fora do escopo aqui.
   */
  old: Partial<T>;
}

/** Tabelas que este hook sabe assinar. */
export type RealtimeTable = 'messages' | 'conversations';

const DEFAULT_TABLES: readonly RealtimeTable[] = ['messages', 'conversations'];

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
  /**
   * Quais tabelas assinar. Default: as duas (comportamento histórico).
   *
   * Existe porque uma assinatura de `messages` não é de graça: numa
   * conta ativa, TODA mensagem que entra ou sai é empurrada pelo
   * WebSocket para cada assinante. Um consumidor que só observa
   * `conversations` — como o quadro de atribuição (SPEC 043) — pagava
   * esse tráfego para descartá-lo no `onMessageRef.current?.()`, já que
   * antes as duas assinaturas eram incondicionais.
   *
   * Pode ser passado inline (`tables={['conversations']}`): a
   * dependência do efeito é a forma serializada do array, não a sua
   * identidade, então um literal novo a cada render não resubscreve.
   */
  tables?: readonly RealtimeTable[];
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
  tables = DEFAULT_TABLES,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  // Chave estável a partir do CONTEÚDO de `tables` — usada como
  // dependência do efeito no lugar do array, para que um literal inline
  // no chamador não conte como "mudou" a cada render e derrube/recrie o
  // canal sem parar.
  const tablesKey = [...tables].sort().join(',');

  useEffect(() => {
    if (!enabled) return;

    const subscribed = new Set(tablesKey.split(',') as RealtimeTable[]);
    const supabase = createClient();

    let channel = supabase.channel(channelName);

    if (subscribed.has('messages')) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>['eventType'],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      );
    }

    if (subscribed.has('conversations')) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          onConversationRef.current?.({
            eventType:
              payload.eventType as RealtimeEvent<Conversation>['eventType'],
            new: payload.new as Conversation,
            old: payload.old as Partial<Conversation>,
          });
        }
      );
    }

    channel = channel.subscribe((status) => {
      setIsConnected(status === 'SUBSCRIBED');
    });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled, tablesKey]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
