'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import type { ChannelStatus, ChannelType } from '@/lib/channels/types';
import {
  evaluateTransferChannels,
  type TransferChannelEvaluation,
} from '@/lib/channels/transfer';

// ------------------------------------------------------------
// Deduplicação de chamadas simultâneas (achado do code-review da SPEC
// 056): `message-thread.tsx` e `contact-sidebar.tsx` montam ao mesmo
// tempo com os MESMOS argumentos e cada um chamava `load()` por conta
// própria, duplicando a consulta. Diferente do cache de
// `useAccountChannels()`, este NÃO sobrevive depois de resolver — só
// junta chamadas que caem no mesmo instante; a próxima rodada de
// `load()` (ex.: o `refetch()` do diálogo ao abrir) volta a bater no
// banco, porque a leitura precisa continuar fresca (outro achado desta
// mesma revisão).
// ------------------------------------------------------------
// `async` de propósito, não só decoração: o query builder do Supabase é
// thenable mas não é um `Promise` de verdade (sem `.finally`) — a
// função `async` embrulha o retorno num `Promise` real, que é o que
// `loadAnchorsDeduped`/`loadChannelRowsDeduped` abaixo precisam para
// limpar o cache quando a chamada resolve.
async function fetchAnchors(contactId: string) {
  return createClient()
    .from('conversations')
    .select('channel_id, last_customer_message_at')
    .eq('contact_id', contactId)
    .not('channel_id', 'is', null);
}

async function fetchChannelRows() {
  return createClient().from('channels').select('id, name, type, status');
}

const anchorsInFlight = new Map<string, ReturnType<typeof fetchAnchors>>();
let channelsInFlight: ReturnType<typeof fetchChannelRows> | null = null;

function loadAnchorsDeduped(contactId: string) {
  let promise = anchorsInFlight.get(contactId);
  if (!promise) {
    promise = fetchAnchors(contactId).finally(() =>
      anchorsInFlight.delete(contactId)
    );
    anchorsInFlight.set(contactId, promise);
  }
  return promise;
}

function loadChannelRowsDeduped() {
  if (!channelsInFlight) {
    channelsInFlight = fetchChannelRows().finally(() => {
      channelsInFlight = null;
    });
  }
  return channelsInFlight;
}

/**
 * Canais candidatos a destino de transferência para ESTE contato,
 * avaliados pela regra pura de `lib/channels/transfer.ts` (SPEC 056 §4.3).
 *
 * Espelha `fetchSiblingThreads` de `contact-sidebar.tsx`, com uma
 * diferença deliberada: aqui entram TODOS os canais da conta, não só os
 * que já têm thread com o contato — a transferência é sempre um
 * find-or-create (§1.4), então "ainda não conversaram por ali" não é
 * motivo de exclusão.
 *
 * A janela de sessão de cada canal vem da thread do CONTATO naquele
 * canal, se existir — `null` (sem thread ali) resolve para janela
 * fechada em `resolveSessionWindow`, que é exatamente a leitura que o
 * D-3 pede: uma janela que nunca abriu não está aberta.
 *
 * Por que o status do canal NÃO vem de `useAccountChannels()`
 *
 *   Aquele hook tem cache em nível de módulo, nunca invalidado por
 *   nenhuma tela que muda status de canal (achado do code-review da
 *   SPEC 056) — ótimo para rótulo/ícone de UI, perigoso para decidir
 *   ELEGIBILIDADE de destino: um canal desconectado há segundos podia
 *   continuar aparecendo elegível no diálogo. Este hook lê `channels`
 *   DIRETO do banco a cada `load()`, e `refetch` (abaixo) deixa quem
 *   controla o diálogo forçar uma leitura fresca ao abrir.
 */
export function useTransferChannels(
  contactId: string | null | undefined,
  currentChannelId: string | null | undefined
): {
  evaluations: TransferChannelEvaluation[];
  loading: boolean;
  /** Força uma releitura — chamado pelo diálogo ao abrir (SPEC 056, achado do code-review). */
  refetch: () => void;
} {
  const accountChannels = useAccountChannels();
  const [evaluations, setEvaluations] = useState<TransferChannelEvaluation[]>(
    []
  );
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (
      !contactId ||
      !currentChannelId ||
      accountChannels.loading ||
      accountChannels.count <= 1
    ) {
      setEvaluations([]);
      return;
    }

    setLoading(true);
    // Duas consultas independentes, em paralelo: as âncoras de janela
    // por canal, e o status/tipo dos canais em si (fresco — ver o
    // porquê acima). Deduplicadas contra chamadas simultâneas de outro
    // consumidor deste hook (ver comentário no topo do arquivo).
    const [anchors, channelsRows] = await Promise.all([
      loadAnchorsDeduped(contactId),
      loadChannelRowsDeduped(),
    ]);

    if (anchors.error || channelsRows.error) {
      // Falha fechada: sem saber o estado de algum canal, é mais
      // seguro não oferecer nenhum destino do que oferecer um que a
      // rota recusaria (D-3).
      setEvaluations([]);
      setLoading(false);
      return;
    }

    const anchorByChannel = new Map<string, string | null>(
      (anchors.data ?? []).map((row) => [
        row.channel_id as string,
        row.last_customer_message_at as string | null,
      ])
    );

    const candidates = (
      channelsRows.data as {
        id: string;
        name: string;
        type: ChannelType;
        status: ChannelStatus;
      }[]
    ).map((channel) => {
      const anchor = anchorByChannel.get(channel.id);
      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        status: channel.status,
        sessionWindow: resolveSessionWindow(
          channel.type,
          anchor ? new Date(anchor) : null
        ),
      };
    });

    setEvaluations(evaluateTransferChannels(candidates, currentChannelId));
    setLoading(false);
  }, [
    contactId,
    currentChannelId,
    accountChannels.loading,
    accountChannels.count,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Memoizado (achado do code-review): sem isto, este hook devolvia um
  // objeto novo a cada render — exatamente o padrão que causou o loop
  // infinito já corrigido em `useAccountChannels()`. Nenhum consumidor
  // aciona o bug hoje (todos desestruturam), mas o próximo `useEffect`
  // que capturar o objeto inteiro em vez de um campo faria de novo.
  return useMemo(
    () => ({ evaluations, loading, refetch: load }),
    [evaluations, loading, load]
  );
}
