'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import {
  matchesConversationTab,
  visibleTabDefinitions,
  type ConversationTabId,
  type TabId,
} from '@/lib/inbox/tabs';
import type {
  Conversation,
  Message,
  Contact,
  ConversationStatus,
  Tag,
} from '@/types';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useAccountMembers } from '@/hooks/use-account-members';
import { useRealtime } from '@/hooks/use-realtime';
import { useInboxTabs } from '@/hooks/use-inbox-tabs';
import { useConversationFeed } from '@/hooks/use-conversation-feed';
import {
  ConversationList,
  useInboxTagDefinitions,
} from '@/components/inbox/conversation-list';
import { InboxTabs } from '@/components/inbox/inbox-tabs';
import { ViewAsSelector } from '@/components/inbox/view-as-selector';
import { ContactsDirectory } from '@/components/inbox/contacts-directory';
import { AssignmentBoard } from '@/components/inbox/assignment-board/assignment-board';
import { MessageThread } from '@/components/inbox/message-thread';
import { ContactSidebar } from '@/components/inbox/contact-sidebar';
import { TagPickerProvider } from '@/components/inbox/tag-picker/tag-picker-context';
import { DealPickerProvider } from '@/components/inbox/deal-picker/deal-picker-context';
import { toast } from 'sonner';
import { WifiOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = 'wacrm:inbox:contact-panel-open';

/**
 * Insere/atualiza `fresh` num array de conversas por `id`, preservando
 * o `contact` já em cache quando `fresh` não traz um — payloads de
 * realtime e o retorno das RPCs de atribuição nunca carregam o embed
 * de contato.
 */
function upsertConversation(
  list: Conversation[],
  fresh: Conversation
): Conversation[] {
  const idx = list.findIndex((c) => c.id === fresh.id);
  if (idx === -1) return [fresh, ...list];
  const copy = list.slice();
  copy[idx] = { ...fresh, contact: fresh.contact ?? copy[idx].contact };
  return copy;
}

export default function InboxPage() {
  const t = useTranslations('Inbox.page');
  const tTabs = useTranslations('Inbox.tabs');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isViewer, accountRole, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  // D7 (SPEC 042): só admin/owner podem supervisionar a carteira de
  // outro agente pelo seletor "ver como".
  const canViewAll = useCan('view-all-conversations');

  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list, a notification, or a
   * teammate's shared link so the right thread opens automatically
   * instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get('c');

  const {
    activeTab,
    viewAsUserId,
    filters,
    setSearch,
    setStatusFilter,
    toggleTag,
    setSelectedCompany,
    clearContactFilters,
    visitedTabs,
  } = useInboxTabs({ accountRole, profileLoading });

  const tags = useInboxTagDefinitions();

  // Alvo REAL do predicado `assigned_agent_id = <alvo>` da aba Chat
  // (D7 da SPEC 042). `viewAsUserId` vem da URL e não é confiável por
  // si só — degradar para a própria sessão quando `canViewAll` é falso
  // é defesa em profundidade por UX, não por segurança: mesmo sem esta
  // linha, um agente comum que forçasse `?viewAs=<outro>` na barra de
  // endereço não receberia nenhuma linha (a RLS da 039 não devolve
  // `assigned_agent_id = <outro>` para quem não é dono, admin ou
  // owner). O motivo de degradar aqui mesmo assim é não deixar a UI de
  // um agente comum, por acidente (link colado, aba duplicada),
  // mostrar um estado "vendo a carteira de Fulano" vazio e confuso.
  const chatTarget = (canViewAll ? viewAsUserId : null) ?? userId;

  const { members: accountMembers, loading: accountMembersLoading } =
    useAccountMembers(canViewAll);

  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  /**
   * Bumped whenever we want children to refetch from the DB — used as
   * a safety net against missed realtime events. Bumped on WS
   * reconnect and on tab visibility → visible. Drives both
   * conversation feeds' refetch AND the active-conversation
   * reconciliation-by-absence effect below.
   */
  const [resyncToken, setResyncToken] = useState(0);
  /** Id da conversa em processo de reivindicação (fila → minha). */
  const [claimingId, setClaimingId] = useState<string | null>(null);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === 'true');
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Os dois feeds conversacionais. "Lazy": só buscam depois que a
  // respectiva aba foi visitada ao menos uma vez (`visitedTabs`).
  //
  // O feed "chat" usa `chatTarget`, não `userId` diretamente — é a
  // mesma dependência de sempre para o `useEffect` do hook, só que o
  // valor pode ser o de OUTRO agente quando um admin está "vendo como"
  // ele (D7). Trocar de alvo já dispara um refetch completo (o efeito
  // do hook depende de `userId`/`chatTarget`), que SUBSTITUI o array —
  // nunca mescla — então trocar e voltar nunca mistura carteiras de
  // agentes diferentes na mesma lista.
  const chatFeed = useConversationFeed({
    tab: 'chat',
    userId: chatTarget,
    enabled: visitedTabs.has('chat'),
    resyncToken,
  });
  const openFeed = useConversationFeed({
    tab: 'open',
    userId,
    enabled: visitedTabs.has('open'),
    resyncToken,
  });

  const readFeed = useCallback(
    (tab: ConversationTabId): Conversation[] =>
      tab === 'chat' ? chatFeed.conversations : openFeed.conversations,
    [chatFeed.conversations, openFeed.conversations]
  );

  // `setConversations` de um `useState` é referencialmente estável —
  // depender só dele (não do objeto `chatFeed`/`openFeed` inteiro, que
  // é recriado a cada render do hook) mantém `patchFeed` estável entre
  // renders, o que por sua vez estabiliza tudo que depende dela.
  const patchFeed = useCallback(
    (
      tab: ConversationTabId,
      updater: (prev: Conversation[]) => Conversation[]
    ) => {
      if (tab === 'chat') chatFeed.setConversations(updater);
      else openFeed.setConversations(updater);
    },
    [chatFeed.setConversations, openFeed.setConversations]
  );

  // Bookkeeping: em qual aba cada conversa mora AGORA. Derivado
  // reativamente dos dois arrays via os dois efeitos abaixo — nunca
  // escrito à mão nos handlers. Existe porque o roteamento de eventos
  // de `messages` (que só carregam `conversation_id`) precisa saber
  // SINCRONAMENTE qual feed patchear, sem esperar o próximo render.
  // Mesmo motivo do antigo `knownConvIdsRef` (issue #105/#106):
  // um `let` lido dentro do mesmo tick de um `setState` funcional lê o
  // valor ANTERIOR, porque o updater roda na reconciliação, depois do
  // corpo síncrono do handler.
  const convTabMapRef = useRef<Map<string, ConversationTabId>>(new Map());
  useEffect(() => {
    const ids = new Set(chatFeed.conversations.map((c) => c.id));
    for (const c of chatFeed.conversations)
      convTabMapRef.current.set(c.id, 'chat');
    for (const [id, tab] of convTabMapRef.current) {
      if (tab === 'chat' && !ids.has(id)) convTabMapRef.current.delete(id);
    }
  }, [chatFeed.conversations]);
  useEffect(() => {
    const ids = new Set(openFeed.conversations.map((c) => c.id));
    for (const c of openFeed.conversations)
      convTabMapRef.current.set(c.id, 'open');
    for (const [id, tab] of convTabMapRef.current) {
      if (tab === 'open' && !ids.has(id)) convTabMapRef.current.delete(id);
    }
  }, [openFeed.conversations]);

  // Ao trocar o alvo do "ver como" (D7), as entradas de 'chat' no mapa
  // pertencem ao alvo ANTERIOR e estão prestes a ficar obsoletas. O
  // efeito acima só as remove DEPOIS que `chatFeed.conversations`
  // terminar de refazer o fetch — até lá, um evento de realtime que
  // chegasse routearia por uma entrada do agente que deixamos de
  // observar. Risco chamado explicitamente na SPEC 042 (§5): limpar
  // aqui, de forma síncrona e imediata, fecha essa janela.
  useEffect(() => {
    for (const [id, tab] of convTabMapRef.current) {
      if (tab === 'chat') convTabMapRef.current.delete(id);
    }
  }, [chatTarget]);

  // Espelha `activeConversation` num ref para ser lido dentro de
  // closures assíncronas (resync, deep-link, handlers de realtime) sem
  // precisar declará-lo como dependência — senão cada troca de
  // conversa recriaria esses callbacks/efeitos à toa. Mutado em
  // efeito, não durante o render (regra de refs do React 19); os
  // leitores só acessam `.current` depois de um await, quando o render
  // que atualizou o ref já rodou.
  const activeConversationRef = useRef<Conversation | null>(null);
  useEffect(() => {
    activeConversationRef.current = activeConversation;
  });

  // Mesmo padrão, para a aba visível — o handler de evento realtime
  // (abaixo) precisa saber se a conversa ativa mudou de aba SEM entrar
  // como dependência do `useCallback`, senão toda troca de aba
  // recriaria o handler e o `useRealtime` resubscreveria à toa.
  const activeTabRef = useRef<TabId | null>(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  });

  // Idem para `searchParams` — o efeito de reconciliação por ausência
  // só deve rodar em cima de `resyncToken`, não a cada mudança de URL.
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  });

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight —
  // dedupe para não disparar duas buscas pelo mesmo id quando o
  // conv-INSERT e o first-message-INSERT chegam a poucos ms um do outro.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const authUser = session?.user;
      if (!authUser) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('account_id')
        .eq('user_id', authUser.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from('whatsapp_config')
        .select('status')
        .eq('account_id', accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === 'connected');
    };

    checkConnection();
  }, []);

  // Fetch por id, compartilhado por três necessidades: hidratar uma
  // conversa desconhecida referenciada por um evento realtime, resolver
  // o deep-link `?c=`, e reconciliar por ausência a conversa ativa a
  // cada resync. Um fetch direto — não depende de nenhum feed já ter
  // carregado, o que importa especialmente para o deep-link: um admin
  // abrindo, via notificação, uma conversa atribuída a OUTRO agente não
  // aparece nem em "Chat" nem em "Open" dele — a menos que ele também
  // troque o seletor "ver como" para aquele agente (D7, SPEC 042) — mas
  // a conversa continua acessível por id, e o banner de
  // `message-thread.tsx` avisa que responder vai assumi-la.
  const fetchConversationById = useCallback(
    async (id: string): Promise<Conversation | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.error('[inbox] failed to fetch conversation by id:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return null;
      }
      if (!data) return null;
      return normalizeConversation(data);
    },
    []
  );

  const tabOfConversation = useCallback(
    (conv: Conversation): ConversationTabId | null => {
      // `chatTarget`, não `userId`: quando um admin está "vendo como"
      // outro agente (D7), uma conversa atribuída a ESSE agente é que
      // pertence à aba "Chat" desta sessão — não as atribuídas ao
      // admin. O predicado de 'open' não usa o alvo (é sempre "sem
      // dono"), então esta troca não muda nada para a fila.
      if (!chatTarget) return null;
      if (matchesConversationTab('chat', conv.assigned_agent_id, chatTarget))
        return 'chat';
      if (matchesConversationTab('open', conv.assigned_agent_id, chatTarget))
        return 'open';
      return null;
    },
    [chatTarget]
  );

  // Hidrata uma conversa desconhecida (evento realtime referenciando um
  // id que nenhum feed conhece ainda) e a mescla no cache certo — se a
  // aba correspondente já tiver sido visitada. Também atualiza
  // `activeConversation` se for ela.
  const hydrateConversation = useCallback(
    async (convId: string) => {
      if (hydratingConvIdsRef.current.has(convId)) return;
      hydratingConvIdsRef.current.add(convId);
      try {
        const fetched = await fetchConversationById(convId);
        if (!fetched) return;

        const tab = tabOfConversation(fetched);
        if (tab && visitedTabs.has(tab)) {
          patchFeed(tab, (prev) => upsertConversation(prev, fetched));
        }

        setActiveConversation((prev) =>
          prev && prev.id === fetched.id
            ? { ...fetched, contact: fetched.contact ?? prev.contact }
            : prev
        );
      } finally {
        hydratingConvIdsRef.current.delete(convId);
      }
    },
    [fetchConversationById, tabOfConversation, visitedTabs, patchFeed]
  );

  // Abre uma conversa — seleção manual na lista, resolução de
  // deep-link, ou o resultado de uma reivindicação bem-sucedida.
  const openConversation = useCallback(
    (conv: Conversation) => {
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      autoSelectedForDeepLinkRef.current = conv.id;
      // Optimistically clear the unread badge for this conv in
      // whichever feed holds it. The server-side reset is fired by the
      // unread-reset effect inside MessageThread (which reads
      // activeConversation.unread_count, not the list copy — so we
      // deliberately leave `conv` itself untouched here to keep that
      // effect firing), and the realtime UPDATE that comes back will
      // sync to 0 again as a no-op.
      if (conv.unread_count > 0) {
        const tab = tabOfConversation(conv);
        if (tab) {
          patchFeed(tab, (prev) =>
            prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c))
          );
        }
      }
    },
    [tabOfConversation, patchFeed]
  );

  // Resolve o deep-link `?c=`. Roda uma vez por valor de URL via o ref
  // — realtime refreshes dos feeds não devem repetir a auto-seleção
  // depois que o usuário já navegou para outro lugar.
  useEffect(() => {
    if (!deepLinkConvId) return;
    if (autoSelectedForDeepLinkRef.current === deepLinkConvId) return;
    if (activeConversationRef.current?.id === deepLinkConvId) {
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      return;
    }

    let cancelled = false;
    (async () => {
      const fresh = await fetchConversationById(deepLinkConvId);
      if (cancelled) return;
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      if (!fresh) {
        // Genérico de propósito (F-11 do SPEC): nunca "sem permissão",
        // que confirmaria a existência do recurso a quem sondar ids.
        toast.error(t('conversationNotFound'));
        return;
      }
      openConversation(fresh);
    })();

    return () => {
      cancelled = true;
    };
  }, [deepLinkConvId, fetchConversationById, openConversation, t]);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === 'INSERT') {
        // Add to messages if it belongs to active conversation
        if (
          activeConversationRef.current &&
          newMsg.conversation_id === activeConversationRef.current.id
        ) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith('temp-')
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Update conversation list preview in whichever feed currently
        // holds this conversation. `convTabMapRef` is what makes this
        // synchronous — see the comment where it's declared.
        const tab = convTabMapRef.current.get(newMsg.conversation_id);
        const isActive =
          activeConversationRef.current?.id === newMsg.conversation_id;
        if (tab) {
          patchFeed(tab, (prev) =>
            prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? '',
                    last_message_at: newMsg.created_at,
                    unread_count: isActive ? 0 : c.unread_count + 1,
                  }
                : c
            )
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, was missed, or its tab isn't visited
          // yet. Hydrate from the DB — the eventual visit to the right
          // tab will also pick it up via its own fresh fetch.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === 'UPDATE') {
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [patchFeed, hydrateConversation]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;
      const targetTab = tabOfConversation(conv);
      const previousTab = convTabMapRef.current.get(conv.id) ?? null;

      if (event.eventType === 'INSERT') {
        // A conversa nova pertence à fila (webhook) OU já nasce minha
        // (envio a partir de um Contato, Fase 2) — `tabOfConversation`
        // resolve os dois casos. Para outro agente vista por um admin,
        // `targetTab` é null e a linha não entra em nenhum feed daqui
        // (consistente com "Chat" ser sempre por-agente, nunca "todas
        // as atribuídas", inclusive para admin).
        if (targetTab && visitedTabs.has(targetTab)) {
          patchFeed(targetTab, (prev) =>
            prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]
          );
          // O payload de realtime nunca traz o embed `contact` — hidrata
          // para preenchê-lo, como o código anterior já fazia.
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === 'UPDATE') {
        // A atribuição mudou de aba — sai de onde estava.
        if (previousTab && previousTab !== targetTab) {
          patchFeed(previousTab, (prev) =>
            prev.filter((c) => c.id !== conv.id)
          );
        }

        if (targetTab && visitedTabs.has(targetTab)) {
          const isActive = activeConversationRef.current?.id === conv.id;
          const wasPresent = readFeed(targetTab).some((c) => c.id === conv.id);
          patchFeed(targetTab, (prev) => {
            const idx = prev.findIndex((c) => c.id === conv.id);
            if (idx === -1) {
              return [
                { ...conv, unread_count: isActive ? 0 : conv.unread_count },
                ...prev,
              ];
            }
            const copy = prev.slice();
            copy[idx] = {
              ...copy[idx],
              ...conv,
              unread_count: isActive ? 0 : conv.unread_count,
            };
            return copy;
          });
          // Entrou nesta aba agora (mudou de aba, ou é a primeira vez
          // que aparece aqui) — falta o `contact`, hidrata.
          if (previousTab !== targetTab || !wasPresent) {
            hydrateConversation(conv.id);
          }
        }

        if (activeConversationRef.current?.id === conv.id) {
          setActiveConversation((prev) => (prev ? { ...prev, ...conv } : prev));
        }

        // A conversa ATIVA mudou de aba — a aba visível acompanha. Cobre
        // o caso que não passa pelo `handleClaim` explícito: o primeiro
        // envio a uma conversa da fila a reivindica automaticamente no
        // servidor (F-07 do SPEC), e o único aviso que o cliente recebe
        // é este evento de UPDATE. Sem isto, a lista à esquerda continua
        // mostrando a aba antiga (ex.: "Fila"), onde o item já não está
        // mais — o agente segue digitando na thread sem ver onde ela foi
        // parar até trocar de aba manualmente.
        if (
          targetTab &&
          targetTab !== previousTab &&
          activeConversationRef.current?.id === conv.id &&
          activeTabRef.current !== targetTab
        ) {
          const params = new URLSearchParams(
            searchParamsRef.current.toString()
          );
          params.set('tab', targetTab);
          router.replace(`/inbox?${params.toString()}`, { scroll: false });
        }
      }
    },
    [
      tabOfConversation,
      visitedTabs,
      patchFeed,
      readFeed,
      hydrateConversation,
      router,
    ]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: 'inbox-realtime',
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    // Desligado enquanto o quadro de atribuição (SPEC 043) está aberto:
    // ele mantém o próprio canal, e nenhuma das superfícies que este
    // aqui alimenta (os dois feeds, a thread) está renderizada naquela
    // aba. Sem isto, as duas assinaturas coexistiriam e o tráfego de
    // realtime do cliente dobraria.
    //
    // Voltar para uma aba conversacional reassina, e a transição
    // desconectado → conectado abaixo já dispara um `resyncToken` — que
    // é exatamente o catch-up necessário para os eventos perdidos no
    // intervalo.
    enabled: activeTab !== 'board',
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by each feed's on-mount fetch; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the feeds + the reconciliation effect
   * below dedupe on their own.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  /**
   * Reconciliação por ausência (F-04 do SPEC): revogação de acesso é
   * SILÊNCIO, não evento — se um admin reatribui a conversa ativa para
   * outro agente, a política de UPDATE já não deixa o UPDATE chegar ao
   * assinante realtime deste usuário, então nenhum evento avisa. A
   * cada resync, refaz o fetch direto da conversa ATIVA (por ref, não
   * por dependência — não queremos refazer isto a cada troca de
   * conversa, só nos gatilhos de resync):
   *   - sumiu (fetch retorna null) → não é mais visível; limpa a tela.
   *   - mudou mas continua visível → sincroniza os campos.
   */
  useEffect(() => {
    const current = activeConversationRef.current;
    if (!current) return;

    let cancelled = false;
    (async () => {
      const fresh = await fetchConversationById(current.id);
      if (cancelled) return;

      if (!fresh) {
        setActiveConversation(null);
        setActiveContact(null);
        setMessages([]);
        autoSelectedForDeepLinkRef.current = null;
        toast.error(t('conversationNoLongerAvailable'));
        const params = new URLSearchParams(searchParamsRef.current.toString());
        params.delete('c');
        const qs = params.toString();
        router.replace(qs ? `/inbox?${qs}` : '/inbox', { scroll: false });
        return;
      }

      setActiveConversation((prev) =>
        prev ? { ...fresh, contact: fresh.contact ?? prev.contact } : fresh
      );
      setActiveContact((prev) => fresh.contact ?? prev);
    })();

    return () => {
      cancelled = true;
    };
    // Depende SÓ de `resyncToken` de propósito — `activeConversation` é
    // lido via ref para este efeito não refazer o fetch a cada seleção
    // de conversa (só nos gatilhos de resync: reconexão/visibilidade).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resyncToken, fetchConversationById, router, t]);

  const handleTabChange = useCallback(
    (tab: TabId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', tab);
      // Trocar de aba não fecha a conversa aberta — o thread permanece
      // montado (evita reproduzir o bug de #411-419 do histórico: um
      // `setActiveConversation(null)` aqui zeraria `messages` e a
      // próxima visita ao Chat exigiria um refetch completo).
      router.replace(`/inbox?${params.toString()}`, { scroll: false });
    },
    [searchParams, router]
  );

  /**
   * Troca o alvo do seletor "ver como" (D7). `null` volta para a
   * própria sessão — remove o parâmetro em vez de gravá-lo vazio, para
   * `/inbox?tab=chat` continuar sendo a forma canônica de "minhas
   * conversas" (sem isso, um link compartilhado com `viewAs=` vazio
   * ficaria esteticamente diferente de um sem o parâmetro, embora
   * signifiquem a mesma coisa).
   *
   * Mesma decisão de não fechar a conversa ativa que `handleTabChange`
   * já toma — a thread permanece montada; só a lista à esquerda troca
   * de carteira.
   */
  const handleViewAsChange = useCallback(
    (targetUserId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (targetUserId && targetUserId !== userId) {
        params.set('viewAs', targetUserId);
      } else {
        params.delete('viewAs');
      }
      router.replace(`/inbox?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, userId]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // messages array without a matching refetch (MessageThread only
      // refetches when conversationId changes) — bail out early.
      if (activeConversationRef.current?.id === conv.id) return;
      openConversation(conv);
      const params = new URLSearchParams(searchParams.toString());
      params.set('c', conv.id);
      router.replace(`/inbox?${params.toString()}`, { scroll: false });
    },
    [openConversation, searchParams, router]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param (preserving ?tab=) so a refresh
  // lands on the list instead of re-opening the thread the user just
  // backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    autoSelectedForDeepLinkRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('c');
    const qs = params.toString();
    router.replace(qs ? `/inbox?${qs}` : '/inbox', { scroll: false });
  }, [searchParams, router]);

  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      const tab = convTabMapRef.current.get(conversationId);
      if (tab) {
        patchFeed(tab, (prev) =>
          prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
        );
      }
      setActiveConversation((prev) =>
        prev && prev.id === conversationId ? { ...prev, status } : prev
      );
    },
    [patchFeed]
  );

  /**
   * Move uma conversa entre os dois feeds quando a atribuição muda —
   * usado tanto pelo `onAssignChange` do MessageThread/AiThreadBanner
   * (dropdown de atribuir, take-over da IA) quanto pelo sucesso de uma
   * reivindicação. `patchedRow`, quando informado, é a linha JÁ FRESCA
   * vinda do servidor (ex.: o retorno do RPC de claim); sem ele, a
   * função procura a linha em qualquer lugar que já a tenha (o feed de
   * origem, ou a conversa ativa) para não fabricar uma linha parcial.
   */
  const moveConversationAssignment = useCallback(
    (
      conversationId: string,
      assignedAgentId: string | null,
      patchedRow?: Conversation
    ) => {
      const previousTab = convTabMapRef.current.get(conversationId) ?? null;
      // `chatTarget`, pelo mesmo motivo de `tabOfConversation` acima —
      // reatribuir uma conversa para alguém que não é o alvo observado
      // a tira da aba Chat desta sessão, mesmo que o novo dono seja o
      // próprio admin (ele está "vendo como" outra pessoa no momento).
      const newTab: ConversationTabId | null = !chatTarget
        ? null
        : matchesConversationTab('chat', assignedAgentId, chatTarget)
          ? 'chat'
          : matchesConversationTab('open', assignedAgentId, chatTarget)
            ? 'open'
            : null;

      const existingRow =
        patchedRow ??
        (previousTab ? readFeed(previousTab) : []).find(
          (c) => c.id === conversationId
        ) ??
        (activeConversationRef.current?.id === conversationId
          ? activeConversationRef.current
          : null);

      if (previousTab && previousTab !== newTab) {
        patchFeed(previousTab, (prev) =>
          prev.filter((c) => c.id !== conversationId)
        );
      }

      if (newTab && visitedTabs.has(newTab)) {
        if (previousTab === newTab) {
          patchFeed(newTab, (prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? { ...c, assigned_agent_id: assignedAgentId }
                : c
            )
          );
        } else if (existingRow) {
          const fresh = { ...existingRow, assigned_agent_id: assignedAgentId };
          patchFeed(newTab, (prev) => upsertConversation(prev, fresh));
        }
        // Sem `existingRow`: não fabricamos uma linha parcial que
        // quebraria a renderização — a próxima visita a esta aba faz
        // um fetch fresco que já inclui a conversa.
      }

      setActiveConversation((prev) =>
        prev && prev.id === conversationId
          ? { ...prev, assigned_agent_id: assignedAgentId }
          : prev
      );

      // Mesma lógica de "seguir a aba" do handler de realtime (abaixo) —
      // aqui cobre a reatribuição feita pelo dropdown/banner de IA
      // enquanto a conversa está ativa, que não passa pelo `handleClaim`
      // explícito nem, necessariamente, por um evento de UPDATE com
      // `previousTab !== targetTab` (o `convTabMapRef` já pode ter sido
      // atualizado por este mesmo `patchFeed` antes do evento chegar).
      if (
        newTab &&
        newTab !== previousTab &&
        activeConversationRef.current?.id === conversationId &&
        activeTabRef.current !== newTab
      ) {
        const params = new URLSearchParams(searchParamsRef.current.toString());
        params.set('tab', newTab);
        router.replace(`/inbox?${params.toString()}`, { scroll: false });
      }
    },
    [chatTarget, visitedTabs, readFeed, patchFeed, router]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      moveConversationAssignment(conversationId, assignedAgentId);
    },
    [moveConversationAssignment]
  );

  /**
   * Reivindica uma conversa da fila (aba "Open") a partir do item da
   * lista. Chama o RPC atômico `claim_conversation` (via
   * /api/inbox/conversations/[id]/claim) — nunca um `.update()` direto,
   * que reintroduziria a corrida que o RPC existe para prevenir (F-02
   * do SPEC): dois agentes clicando a mesma conversa no mesmo instante
   * só têm UM vencedor, garantido pelo banco via
   * `WHERE assigned_agent_id IS NULL`.
   */
  const handleClaim = useCallback(
    async (conv: Conversation) => {
      if (claimingId) return; // um de cada vez
      setClaimingId(conv.id);
      try {
        const res = await fetch(`/api/inbox/conversations/${conv.id}/claim`, {
          method: 'POST',
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          if (json?.code === 'CONVERSATION_ALREADY_CLAIMED') {
            toast.error(t('claimedByAnother'));
            // Sob a RLS, uma conversa agora atribuída a outro some do
            // meu ponto de vista de qualquer forma — remove já, sem
            // esperar o próximo resync.
            patchFeed('open', (prev) => prev.filter((c) => c.id !== conv.id));
          } else {
            toast.error(json?.error || t('claimFailed'));
          }
          return;
        }

        // O RPC devolve a linha CRUA de `conversations` (sem embed de
        // contato) — anexa o `contact` que a lista já tinha em cache.
        const claimedRaw = json.conversation as Conversation;
        const claimed: Conversation = { ...claimedRaw, contact: conv.contact };

        moveConversationAssignment(
          conv.id,
          claimed.assigned_agent_id ?? null,
          claimed
        );
        openConversation(claimed);

        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', 'chat');
        params.set('c', claimed.id);
        router.replace(`/inbox?${params.toString()}`, { scroll: false });
      } catch {
        toast.error(t('networkError'));
      } finally {
        setClaimingId(null);
      }
    },
    [
      claimingId,
      patchFeed,
      moveConversationAssignment,
      openConversation,
      searchParams,
      router,
      t,
    ]
  );

  /**
   * Propaga uma mudança de etiquetas feita no picker para todo o
   * estado da página. Precisa atingir DOIS lugares, e esquecer o
   * primeiro é o bug mais fácil de introduzir aqui:
   *
   *   1. `contact.tags` nos DOIS feeds — é o que `matchesContactFilters`
   *      lê para o filtro por etiqueta da lista. Sem atualizar, uma
   *      conversa não entra nem sai da lista filtrada até um refetch.
   *   2. `activeContact.tags` — o que a ContactSidebar renderiza.
   *
   * O `map` casa por `contact.id` e não para no primeiro acerto de
   * propósito: um mesmo contato pode ter mais de uma conversa
   * (encerradas persistem depois do dedupe da migração 036).
   */
  const handleContactTagsChanged = useCallback(
    (contactId: string, tagsList: Tag[]) => {
      const patch = (list: Conversation[]) =>
        list.map((c) =>
          c.contact?.id === contactId
            ? { ...c, contact: { ...c.contact, tags: tagsList } }
            : c
        );
      chatFeed.setConversations(patch);
      openFeed.setConversations(patch);
      setActiveContact((prev) =>
        prev?.id === contactId ? { ...prev, tags: tagsList } : prev
      );
    },
    [chatFeed.setConversations, openFeed.setConversations]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">{t('whatsappNotConnected')}</p>
        </div>
      )}

      {activeTab === null ? (
        // Papel da conta ainda carregando (`profileLoading`). `resolveTab`
        // devolve `null` de propósito neste meio-tempo (SPEC 043, §3.7):
        // um admin com deep link para `?tab=board` não pode ver a barra
        // de abas destacar "Fila" por um instante antes do quadro, nem a
        // URL ser reescrita no meio do caminho. Segura o render aqui, sem
        // aba nenhuma renderizada, até o papel resolver.
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      ) : (
        <>
          {/* Barra de abas — sempre visível, independente do que está
              renderizado abaixo, para trocar de aba nunca depender de
              "voltar" primeiro. */}
          <InboxTabs
            activeTab={activeTab}
            tabs={visibleTabDefinitions(accountRole)}
            onChange={handleTabChange}
            trailing={
              // Seletor "ver como" (D7): só na aba Chat, só para quem pode
              // supervisionar. `userId` sempre não-nulo aqui na prática (a
              // página inteira depende de sessão), mas o guard evita passar
              // `selfUserId=''` numa janela de hidratação improvável.
              activeTab === 'chat' && canViewAll && userId ? (
                <ViewAsSelector
                  members={accountMembers}
                  membersLoading={accountMembersLoading}
                  selfUserId={userId}
                  value={viewAsUserId}
                  onChange={handleViewAsChange}
                />
              ) : undefined
            }
          />

          {activeTab === 'contacts' ? (
            <div className="flex flex-1 overflow-hidden">
              <ContactsDirectory />
            </div>
          ) : activeTab === 'board' ? (
            <div className="flex flex-1 overflow-hidden">
              <AssignmentBoard />
            </div>
          ) : (
            // `activeTab` está narrowed para ConversationTabId aqui — os
            // branches acima já cobriram 'contacts' e 'board'.
            <TagPickerProvider onTagsChanged={handleContactTagsChanged}>
              {/* Sem prop de callback: nenhum estado desta página depende
              de `deals`. Quem precisa do negócio criado é o trigger —
              a ContactSidebar, única dona dessa lista — e ele passa o
              seu próprio callback em `open(contact, { onCreated })`. */}
              <DealPickerProvider>
                <div className="flex flex-1 overflow-hidden">
                  {/* Left panel: Conversation list.
              Hidden on mobile when a conversation is selected so the
              thread can occupy the full width. Always visible on lg+. */}
                  <div
                    className={cn(
                      'flex h-full flex-1 flex-col lg:flex-none',
                      hasActiveConv ? 'hidden lg:flex' : 'flex'
                    )}
                  >
                    {/* "Vendo a carteira de {nome}" (D7). Só quando o admin
                  está de fato observando outra pessoa — nunca aparece
                  para o caso comum (viewAsUserId nulo ou igual à
                  própria sessão), então a maioria dos usuários nunca vê
                  esta faixa. */}
                    {activeTab === 'chat' &&
                      chatTarget &&
                      chatTarget !== userId && (
                        <div className="border-primary/20 bg-primary/5 flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
                          <span className="text-foreground truncate">
                            {t('viewingOthersInbox', {
                              name:
                                accountMembers.find(
                                  (m) => m.user_id === chatTarget
                                )?.full_name ?? tTabs('viewAsUnknownMember'),
                            })}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleViewAsChange(null)}
                            className="text-primary shrink-0 font-medium hover:underline"
                          >
                            {t('backToMine')}
                          </button>
                        </div>
                      )}
                    {/* `min-h-0 flex-1`: `ConversationList` é `h-full` por
                  dentro, o que só funciona porque este wrapper (e não o
                  pai `flex-col`) lhe dá uma altura definida — sem ele, a
                  lista somaria 100% da altura do pai POR CIMA da faixa
                  "vendo a carteira de" acima, transbordando o painel. */}
                    <div className="min-h-0 flex-1">
                      <ConversationList
                        tab={activeTab}
                        activeConversationId={activeConversation?.id ?? null}
                        onSelect={handleSelectConversation}
                        conversations={
                          activeTab === 'chat'
                            ? chatFeed.conversations
                            : openFeed.conversations
                        }
                        loading={
                          activeTab === 'chat'
                            ? chatFeed.loading
                            : openFeed.loading
                        }
                        tags={tags}
                        filters={filters[activeTab]}
                        onSearchChange={(v) => setSearch(activeTab, v)}
                        onStatusFilterChange={(v) =>
                          setStatusFilter(activeTab, v)
                        }
                        onToggleTag={(id) => toggleTag(activeTab, id)}
                        onSelectCompany={(c) =>
                          setSelectedCompany(activeTab, c)
                        }
                        onClearFilters={() => clearContactFilters(activeTab)}
                        showStatusFilter
                        onClaim={activeTab === 'open' ? handleClaim : undefined}
                        claimingId={claimingId}
                        emptyMessageOverride={
                          // D5 (SPEC 042): o `viewer` nunca é atribuído a nada
                          // (não pode responder, não pode reivindicar) — a aba
                          // Chat dele fica sempre vazia, e sem isto o vazio é
                          // indistinguível de um erro de carregamento.
                          activeTab === 'chat' && isViewer
                            ? t('viewerChatEmpty')
                            : undefined
                        }
                      />
                    </div>
                  </div>

                  {/* Center panel: Message thread.
              Hidden on mobile when no conversation is selected so the
              list can occupy the full width. Always visible on lg+
              (shows its own empty-state if no thread is picked yet).

              `min-w-0` is load-bearing: without it, a single wide piece
              of content inside the thread (long quote preview, very
              long URL in a message body) forces the flex child past
              its share and pushes the contact-sidebar panel off-screen
              on the right. Issue #165. */}
                  <div
                    className={cn(
                      'flex h-full min-w-0 flex-1 lg:flex',
                      hasActiveConv ? 'flex' : 'hidden lg:flex'
                    )}
                  >
                    <MessageThread
                      conversation={activeConversation}
                      contact={activeContact}
                      messages={messages}
                      onMessagesLoaded={handleMessagesLoaded}
                      onNewMessage={handleNewMessage}
                      onUpdateMessage={handleUpdateMessage}
                      onStatusChange={handleStatusChange}
                      onAssignChange={handleAssignChange}
                      onBack={handleCloseConversation}
                      resyncToken={resyncToken}
                      onRefresh={handleManualRefresh}
                      contactPanelOpen={contactPanelOpen}
                      onToggleContactPanel={handleToggleContactPanel}
                    />
                  </div>

                  {/* Right panel: Contact sidebar — desktop only, and only when the
              agent hasn't collapsed it via the thread-header toggle (#258).
              On mobile it's always hidden (the `lg:block` below), so the
              toggle — which is itself desktop-only — never affects it. */}
                  {contactPanelOpen && (
                    <div className="hidden h-full lg:block">
                      <ContactSidebar contact={activeContact} />
                    </div>
                  )}
                </div>
              </DealPickerProvider>
            </TagPickerProvider>
          )}
        </>
      )}
    </div>
  );
}
