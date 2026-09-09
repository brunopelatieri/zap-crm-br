'use client';

// ============================================================
// Casca React fina sobre `src/lib/emoji/recents.ts`.
//
// Toda a regra (dedupe, teto MRU, tolerância a blob corrompido) já
// está testada na lib pura — este hook só liga estado do React ao
// storage: lê quando `userId` muda, escreve a cada seleção.
//
// A releitura ao trocar de usuário usa o padrão "ajustar estado
// durante o render" (setState condicional no corpo da função, não em
// `useEffect`) — o mesmo espírito do `useState(() =>
// readInitialTheme())` em `use-theme.tsx`. Evita o efeito por
// completo: a leitura de `localStorage` é síncrona e pura dado
// `userId`, não uma assinatura a um sistema externo que muda por
// conta própria, então não há nada para "sincronizar" ao longo do
// tempo — só uma derivação que precisa recalcular quando a chave
// muda. Também evita o ciclo extra de render que um `useEffect`
// causaria (a regra `react-hooks/set-state-in-effect` do projeto
// aceitaria isto só com um eslint-disable, ver `use-transfer-
// channels.ts` para o precedente — mas o caminho sem efeito nem
// precisa da exceção).
//
// `userId` vazio (usuário ainda não resolvido pelo `useAuth()`, ou
// composer renderizado fora de uma sessão) NUNCA toca o storage — sem
// essa guarda, `recentsKey('')` criaria um balde compartilhado por
// toda visita anônima. Na prática o composer só monta dentro de rota
// protegida, então isso cobre apenas a janela curta de hidratação
// antes do usuário resolver.
// ============================================================

import { useCallback, useState } from 'react';
import type { Emoji } from 'frimousse';

import { useAuth } from '@/hooks/use-auth';
import { browserStorage } from '@/lib/emoji/storage';
import {
  clearRecents,
  mergeRecent,
  readRecents,
  writeRecents,
  type RecentEmoji,
} from '@/lib/emoji/recents';

interface UseEmojiRecentsResult {
  recents: RecentEmoji[];
  /** Registra um uso e atualiza `recents` imediatamente (otimista). */
  remember: (emoji: Emoji) => void;
  /** Esvazia a lista do usuário. */
  clear: () => void;
  /** '' enquanto o usuário não resolve — ver nota acima. */
  userId: string;
}

function load(userId: string): RecentEmoji[] {
  return userId ? readRecents(browserStorage(), userId) : [];
}

export function useEmojiRecents(): UseEmojiRecentsResult {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  // Server (sem window) e primeiro render do cliente concordam: os
  // dois caem em `load('')` porque `useAuth()` também começa com
  // `user: null` antes da sessão resolver — sem risco de divergência
  // de hidratação.
  const [loadedFor, setLoadedFor] = useState(userId);
  const [recents, setRecents] = useState<RecentEmoji[]>(() => load(userId));

  if (userId !== loadedFor) {
    setLoadedFor(userId);
    setRecents(load(userId));
  }

  // `mergeRecent` sobre o `current` em memória (via updater funcional),
  // não `pushRecent` (que relê o storage do zero) — achado de code
  // review: o hook já tem a lista certa em `recents`, reler a cada
  // clique era trabalho redundante no caminho mais quente do recurso.
  // Só grava quando `next !== current` (emoji válido de fato mudou
  // algo), mesmo sinal que `pushRecent` usa internamente.
  const remember = useCallback(
    (emoji: Emoji) => {
      if (!userId) return;
      setRecents((current) => {
        const next = mergeRecent(current, emoji);
        if (next !== current) {
          writeRecents(browserStorage(), userId, next);
        }
        return next;
      });
    },
    [userId]
  );

  const clear = useCallback(() => {
    if (!userId) return;
    clearRecents(browserStorage(), userId);
    setRecents([]);
  }, [userId]);

  return { recents, remember, clear, userId };
}
