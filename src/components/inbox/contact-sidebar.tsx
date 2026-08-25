'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import type { Contact, Deal, ContactNote } from '@/types';
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  MessageCircle,
  QrCode,
  BadgeCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format, formatDistanceToNow } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useTagPicker } from '@/components/inbox/tag-picker/tag-picker-context';
import { useDealPicker } from '@/components/inbox/deal-picker/deal-picker-context';
import { canSendMessages } from '@/lib/auth/roles';
import { formatPhoneForDisplay } from '@/lib/phone/br';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { useTransferChannels } from '@/hooks/use-transfer-channels';
import { TransferChannelDialog } from './transfer-channel-dialog';

interface SiblingThread {
  id: string;
  channelId: string;
  lastMessageAt: string | null;
  messageCount: number;
}

interface ContactSidebarProps {
  contact: Contact | null;
  /** Conversa aberta agora — excluída da lista de "irmãs" abaixo. */
  conversationId?: string | null;
  /**
   * Canal da conversa aberta agora (SPEC 056) — precisa junto de
   * `conversationId` para saber por qual canal um "falar por este
   * canal" transferiria. `null` desativa a seção inteira (nenhuma
   * conversa aberta ainda não tem "de onde" transferir).
   */
  currentChannelId?: string | null;
  /** Abre outra thread do mesmo contato (SPEC 049 §4.4 / SPEC 056 §4.2). */
  onOpenConversation?: (conversationId: string) => void;
}

export function ContactSidebar({
  contact,
  conversationId = null,
  currentChannelId = null,
  onOpenConversation,
}: ContactSidebarProps) {
  const tSidebar = useTranslations('Inbox.sidebar');
  const tThread = useTranslations('Inbox.messageThread');
  const tDealPicker = useTranslations('Inbox.dealPicker');

  const { accountId, accountRole } = useAuth();
  const { open: openTagPicker } = useTagPicker();
  const { open: openDealPicker } = useDealPicker();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const accountChannels = useAccountChannels();
  const [siblingThreads, setSiblingThreads] = useState<SiblingThread[]>([]);

  // SPEC 056 §4.1 — entrada secundária. Canais elegíveis que este
  // contato AINDA não tem thread — cada um vira "falar por este canal"
  // em vez do "abrir" que a lista de irmãs mostra.
  const { evaluations: transferEvaluations } = useTransferChannels(
    contact?.id,
    currentChannelId
  );
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferChannelId, setTransferChannelId] = useState<string | null>(
    null
  );
  const openTransferDialog = useCallback((channelId: string) => {
    setTransferChannelId(channelId);
    setTransferDialogOpen(true);
  }, []);

  // As etiquetas vêm de `contact.tags`, já hidratado pela página via
  // CONVERSATION_SELECT (`contact_tags(tags(*))`). Manter uma cópia
  // local aqui criava uma segunda fonte de verdade para o mesmo dado:
  // depois de uma mutação no picker, uma das duas ficava velha. Como
  // efeito colateral, isso também elimina uma query por troca de
  // conversa.
  const tags = contact?.tags ?? [];

  // A política `deals_insert` (migração 017) exige agent+ — ao
  // contrário das etiquetas, cujo catálogo é admin+. Negócio é dado
  // operacional; funil é configuração de conta.
  const canCreateDeal = accountRole ? canSendMessages(accountRole) : false;

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals and notes in parallel
    const [dealsRes, notesRes] = await Promise.all([
      supabase
        .from('deals')
        .select('*, stage:pipeline_stages(*)')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('contact_notes')
        .select('*')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  /**
   * "Também neste contato" (SPEC 049 §4.4) — outras threads do MESMO
   * contato, noutro canal. Só vale a pena consultar numa conta com mais
   * de um canal: numa conta de canal único, uma conversa por (contato,
   * canal) desde a 059 já É a única thread possível.
   *
   * Contagem por irmã via `count: 'exact', head: true` — parece caro e
   * não é: o número de irmãs é limitado pelo número de canais da conta
   * (teto de `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT`, tipicamente ≤ 4).
   */
  const fetchSiblingThreads = useCallback(async () => {
    if (!contact || accountChannels.count <= 1) {
      setSiblingThreads([]);
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase
      .from('conversations')
      .select('id, channel_id, last_message_at')
      .eq('contact_id', contact.id)
      .not('channel_id', 'is', null);
    if (error || !data) {
      setSiblingThreads([]);
      return;
    }
    const siblings = data.filter(
      (row) => row.id !== conversationId && !!row.channel_id
    );
    const withCounts = await Promise.all(
      siblings.map(async (row) => {
        const { count } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', row.id);
        return {
          id: row.id as string,
          channelId: row.channel_id as string,
          lastMessageAt: row.last_message_at as string | null,
          messageCount: count ?? 0,
        };
      })
    );
    setSiblingThreads(withCounts);
  }, [contact, conversationId, accountChannels.count]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSiblingThreads();
  }, [fetchSiblingThreads]);

  // Elegíveis MENOS os que já têm thread — aqueles ganham "abrir" na
  // lista de irmãs acima; estes ganham "falar por este canal" (§4.1).
  const siblingChannelIds = useMemo(
    () => new Set(siblingThreads.map((s) => s.channelId)),
    [siblingThreads]
  );
  const channelsWithoutThread = useMemo(
    () =>
      transferEvaluations
        .filter((e) => e.eligible && !siblingChannelIds.has(e.channel.id))
        .map((e) => e.channel),
    [transferEvaluations, siblingChannelIds]
  );

  // Único destino da criação: esta lista é local, não vive no estado
  // da página (deals não está em CONVERSATION_SELECT nem alimenta
  // filtro nenhum da lista de conversas). A ordem espelha a query de
  // `fetchContactData` — `created_at desc`, o mais novo no topo.
  const handleDealCreated = useCallback((deal: Deal) => {
    setDeals((prev) => [deal, ...prev]);
  }, []);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote('');
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="border-border bg-card flex h-full w-70 items-center justify-center border-l">
        <p className="text-muted-foreground text-sm">
          {tThread('selectConversation')}
        </p>
      </div>
    );
  }

  const displayPhone = formatPhoneForDisplay(contact.phone);
  const displayName = contact.name || displayPhone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="border-border bg-card flex h-full w-70 flex-col border-l">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="bg-muted text-foreground flex h-16 w-16 items-center justify-center rounded-full text-lg font-semibold">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="text-foreground mt-3 text-sm font-semibold">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-muted-foreground text-xs">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="text-muted-foreground hover:bg-muted flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
            >
              <Phone className="text-muted-foreground h-4 w-4" />
              <span className="flex-1 text-left">{displayPhone}</span>
              {copied ? (
                <Check className="text-primary h-3 w-3" />
              ) : (
                <Copy className="text-muted-foreground h-3 w-3" />
              )}
            </button>

            {contact.email && (
              <div className="text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                <Mail className="text-muted-foreground h-4 w-4" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Também neste contato (SPEC 049 §4.4) — outras threads do
              mesmo contato, noutro canal. Só aparece quando existe pelo
              menos uma irmã; sem thread noutro canal, a seção nem
              renderiza (nem vazia) — é ruído numa conta de canal único
              e, mesmo em conta multicanal, na maioria dos contatos. */}
          {(siblingThreads.length > 0 || channelsWithoutThread.length > 0) && (
            <>
              <div className="border-border my-4 border-t" />
              <div>
                <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
                  <MessageCircle className="h-3 w-3" />
                  {tSidebar('alsoInThisContact')}
                </div>
                <div className="mt-2 space-y-1.5">
                  {/* SPEC 056 §4.1 — canais elegíveis SEM thread ainda:
                      "falar por este canal" em vez de "abrir". */}
                  {channelsWithoutThread.map((channel) => (
                    <div
                      key={channel.id}
                      className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2"
                    >
                      {channel.type === 'whatsapp_qr' ? (
                        <QrCode className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <BadgeCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-xs font-medium">
                          {channel.name}
                        </p>
                        <p className="text-muted-foreground truncate text-[11px]">
                          {tSidebar('noThreadYet')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => openTransferDialog(channel.id)}
                        className="text-primary shrink-0 text-xs font-medium hover:underline"
                      >
                        {tSidebar('speakOnThisChannel')}
                      </button>
                    </div>
                  ))}
                  {siblingThreads.map((sibling) => {
                    const ch = accountChannels.byId.get(sibling.channelId);
                    return (
                      <div
                        key={sibling.id}
                        className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2"
                      >
                        {ch?.type === 'whatsapp_qr' ? (
                          <QrCode className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <BadgeCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate text-xs font-medium">
                            {ch?.name ?? tSidebar('unknownChannel')}
                          </p>
                          <p className="text-muted-foreground truncate text-[11px]">
                            {tSidebar('siblingMessageCount', {
                              count: sibling.messageCount,
                            })}
                            {sibling.lastMessageAt &&
                              ` · ${tSidebar('siblingLastMessage', {
                                time: formatDistanceToNow(
                                  new Date(sibling.lastMessageAt),
                                  { addSuffix: true }
                                ),
                              })}`}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => onOpenConversation?.(sibling.id)}
                          className="text-primary shrink-0 text-xs font-medium hover:underline"
                        >
                          {tSidebar('openThread')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Divider */}
          <div className="border-border my-4 border-t" />

          {/* Tags */}
          <div>
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
              <TagIcon className="h-3 w-3" />
              {tSidebar('tags')}
              {/* Único caminho de escrita a partir daqui: todo o fluxo
                  (criar / atribuir / remover) vive no picker. */}
              <button
                type="button"
                onClick={() => openTagPicker(contact)}
                aria-label={tSidebar('manageTags')}
                title={tSidebar('manageTags')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex h-5 w-5 items-center justify-center rounded transition-colors"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="text-muted-foreground px-1 text-xs">
                  {tSidebar('noTags')}
                </p>
              ) : (
                tags.map((tag) => (
                  // `tag.id` é único por contato — garantido pelo
                  // UNIQUE(contact_id, tag_id) da tabela de vínculo.
                  <span
                    key={tag.id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-border my-4 border-t" />

          {/* Active Deals */}
          <div>
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
              <DollarSign className="h-3 w-3" />
              {tSidebar('deals')}
              {/* Não usa <GatedButton>: aquele componente monta o
                  tooltip a partir de um template em inglês
                  hard-coded ("Read-only — your role can't …"), o que
                  violaria o requisito de i18n desta entrega. Aqui
                  aplicamos a mesma técnica dele — o `title` vai no
                  <span> e não no <button>, porque navegadores não
                  disparam mouseover em controle desabilitado — com a
                  string vinda do dicionário. Mesmo caminho já usado
                  no tag-picker-dialog. */}
              <span
                className={cn(
                  'ml-auto inline-flex',
                  !canCreateDeal && 'cursor-not-allowed'
                )}
                title={
                  canCreateDeal
                    ? tSidebar('newDeal')
                    : tDealPicker('onlyAgentsCanCreate')
                }
              >
                <button
                  type="button"
                  disabled={!canCreateDeal}
                  onClick={() =>
                    openDealPicker(contact, { onCreated: handleDealCreated })
                  }
                  aria-label={tSidebar('newDeal')}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded transition-colors disabled:pointer-events-none disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="text-muted-foreground px-1 text-xs">
                  {tSidebar('noDeals')}
                </p>
              ) : (
                deals.map((deal) => (
                  <div key={deal.id} className="bg-muted rounded-lg px-3 py-2">
                    <p className="text-foreground text-sm font-medium">
                      {deal.title}
                    </p>
                    <div className="text-muted-foreground mt-1 flex items-center justify-between text-xs">
                      <span>
                        {deal.currency ?? '$'}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-border my-4 border-t" />

          {/* Notes */}
          <div>
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
              <StickyNote className="h-3 w-3" />
              {tSidebar('notes')}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar('addNotePlaceholder')}
                  rows={2}
                  className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 flex-1 resize-none rounded-lg border px-3 py-2 text-xs outline-none"
                />
                <Button
                  size="sm"
                  className="bg-primary hover:bg-primary/90 h-auto px-2"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="bg-muted rounded-lg px-3 py-2">
                    <p className="text-muted-foreground text-xs whitespace-pre-wrap">
                      {note.note_text}
                    </p>
                    <p className="text-muted-foreground mt-1 text-[10px]">
                      {format(new Date(note.created_at), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {contact && conversationId && currentChannelId && transferChannelId && (
        <TransferChannelDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          sourceConversationId={conversationId}
          contactId={contact.id}
          currentChannelId={currentChannelId}
          initialChannelId={transferChannelId}
          onTransferred={(id) => onOpenConversation?.(id)}
        />
      )}
    </div>
  );
}
