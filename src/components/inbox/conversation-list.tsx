'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { matchesContactFilters } from '@/lib/inbox/conversations';
import type { ConversationTabId } from '@/lib/inbox/tabs';
import type { InboxStatusFilter } from '@/hooks/use-inbox-tabs';
import { cn } from '@/lib/utils';
import type { Contact, Conversation, ConversationStatus, Tag } from '@/types';
import {
  Search,
  ChevronDown,
  Tag as TagIcon,
  X,
  UserPlus,
  Loader2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTagPicker } from '@/components/inbox/tag-picker/tag-picker-context';

interface ConversationListProps {
  /** Qual das duas abas conversacionais esta lista está mostrando. */
  tab: ConversationTabId;
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  /**
   * Conversas JÁ recortadas para esta aba pelo hook
   * `useConversationFeed` — este componente não busca nada, só
   * apresenta e aplica os filtros de busca/etiqueta/empresa/status por
   * cima do que recebeu.
   */
  conversations: Conversation[];
  loading: boolean;
  /** Definições de etiquetas (para o dropdown de filtro), lista de nomes/cores das tags — referência estável, independente da aba. */
  tags: Tag[];
  filters: {
    search: string;
    statusFilter: InboxStatusFilter;
    selectedTagIds: string[];
    selectedCompany: string | null;
  };
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: InboxStatusFilter) => void;
  onToggleTag: (tagId: string) => void;
  onSelectCompany: (company: string | null) => void;
  onClearFilters: () => void;
  /**
   * Dropdown de status/não-lidas. Só faz sentido dentro da fila (aba
   * "Open") — a aba "Chat" mostra as MINHAS conversas em qualquer
   * status, sem esse recorte adicional.
   */
  showStatusFilter: boolean;
  /**
   * Reivindicar uma conversa da fila. Só é passado (e só é renderizado
   * o botão) na aba "Open" — reivindicar uma conversa que já é minha
   * (aba "Chat") não faz sentido.
   */
  onClaim?: (conversation: Conversation) => void;
  /** Id da conversa em processo de reivindicação — bloqueia o botão e mostra o spinner nela. */
  claimingId?: string | null;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

/** Quantas etiquetas o item mostra antes de resumir o resto num "+N".
 *  A lista tem 320px no desktop — acima disto os nomes viram reticências
 *  e deixam de informar qualquer coisa. */
const MAX_VISIBLE_TAGS = 3;

export function ConversationList({
  tab,
  activeConversationId,
  onSelect,
  conversations,
  loading,
  tags,
  filters,
  onSearchChange,
  onStatusFilterChange,
  onToggleTag,
  onSelectCompany,
  onClearFilters,
  showStatusFilter,
  onClaim,
  claimingId,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const { open: openTagPicker } = useTagPicker();

  const FILTER_OPTIONS: { label: string; value: InboxStatusFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t]
  );

  const { search, statusFilter, selectedTagIds, selectedCompany } = filters;

  // Company options são derivadas das conversas JÁ carregadas nesta
  // aba — não há uma tabela de empresas separada, e só empresas com
  // uma conversa viva nesta aba valem a pena oferecer como filtro.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const tag of tags) m.set(tag.id, tag);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (showStatusFilter) {
      if (statusFilter === 'unread') {
        result = result.filter((c) => c.unread_count > 0);
      } else if (statusFilter !== 'all') {
        result = result.filter((c) => c.status === statusFilter);
      }
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    showStatusFilter,
    statusFilter,
    search,
    selectedTagIds,
    selectedCompany,
  ]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSearchChange(e.target.value);
    },
    [onSearchChange]
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === statusFilter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full flex-col border-r lg:w-80">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {showStatusFilter && (
            <DropdownMenu>
              <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
                {activeFilter?.label ?? t('filterAll')}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover"
              >
                {FILTER_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => onStatusFilterChange(opt.value)}
                    className={cn(
                      'text-sm',
                      statusFilter === opt.value
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag.id}
                    checked={selectedTagIds.includes(tag.id)}
                    onCheckedChange={() => onToggleTag(tag.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => onSelectCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => onSelectCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => onToggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => onSelectCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={onClearFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                onOpenTags={openTagPicker}
                showClaim={tab === 'open' && !!onClaim}
                isClaiming={claimingId === conv.id}
                onClaim={onClaim}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Abre o picker de etiquetas para o contato desta conversa. */
  onOpenTags: (contact: Contact) => void;
  /** Mostra o botão "Assumir" — só na aba "Open". */
  showClaim: boolean;
  isClaiming: boolean;
  onClaim?: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onOpenTags,
  showClaim,
  isClaiming,
  onClaim,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = displayName.charAt(0).toUpperCase();

  // As etiquetas já chegam hidratadas em `contact.tags` pelo
  // CONVERSATION_SELECT (`contact_tags(tags(*))`) e o TagPickerProvider
  // as mantém em dia via `onTagsChanged` — não há nada a buscar aqui.
  const contactTags = contact?.tags ?? [];
  const visibleTags = contactTags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTags = contactTags.slice(MAX_VISIBLE_TAGS);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // O item era um <button>. Como ele passou a conter o gatilho de
  // etiquetas — outro botão —, precisou virar um div com role/tabIndex:
  // HTML proíbe <button> dentro de <button>, e o React não só avisa
  // como o clique interno deixa de se comportar de forma previsível.
  // O papel e o comportamento de teclado são reimplementados aqui.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Só reage quando o próprio item tem o foco — Enter/Espaço com
      // o foco no botão de etiquetas pertence àquele botão.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(conversation);
      }
    },
    [onSelect, conversation]
  );

  const handleOpenTags = useCallback(
    (e: React.MouseEvent) => {
      // Sem isto, o clique borbulha até o item e troca a conversa
      // ativa junto com a abertura do modal.
      e.stopPropagation();
      if (contact) onOpenTags(contact);
    },
    [contact, onOpenTags]
  );

  const handleClaimClick = useCallback(
    (e: React.MouseEvent) => {
      // Mesmo motivo do botão de etiquetas: reivindicar não deve
      // também trocar a conversa ativa (embora abrir a thread depois
      // do sucesso seja o próprio `onClaim` que decide fazer).
      e.stopPropagation();
      onClaim?.(conversation);
    },
    [conversation, onClaim]
  );

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'hover:bg-muted/50 focus-visible:ring-primary group flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
        isActive && 'border-primary bg-muted/70 border-l-2'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Botão "Assumir" — só na fila (aba Open). Reivindica a
                conversa via RPC atômico (claim_conversation); o estado
                `isClaiming` vem do pai porque a chamada de rede também
                mora lá (o pai é quem move a conversa entre os feeds e
                troca de aba no sucesso). */}
            {showClaim && (
              <button
                type="button"
                onClick={handleClaimClick}
                disabled={isClaiming}
                aria-label={t('claimConversation', { name: displayName })}
                title={t('claimConversationShort')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-primary flex h-5 w-5 items-center justify-center rounded-full transition-[opacity,background-color,color] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
              >
                {isClaiming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <UserPlus className="h-3 w-3" />
                )}
              </button>
            )}
            {/* Gatilho do picker de etiquetas.
                Sempre visível abaixo de lg: não há :hover no toque, e
                no mobile esta lista é o ÚNICO caminho até o modal (a
                ContactSidebar é hidden lg:block). Em telas grandes ele
                aparece no hover/foco do item para não poluir a lista
                em repouso. */}
            {contact && (
              <button
                type="button"
                onClick={handleOpenTags}
                aria-label={t('manageTags', { name: displayName })}
                title={t('manageTagsShort')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-primary flex h-5 w-5 items-center justify-center rounded-full transition-[opacity,background-color,color] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
              >
                <TagIcon className="h-3 w-3" />
              </button>
            )}
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>

        {/* Etiquetas do contato.
            Sem etiquetas nada é renderizado — nenhuma margem sobra para
            desalinhar o item em relação aos vizinhos.
            Uma linha só, sem wrap: as pills encolhem e truncam
            (`min-w-0` + `truncate`) em vez de empurrar a altura do item,
            o que deixaria a lista com itens de alturas irregulares. O
            excedente vira um "+N" fixo à direita. */}
        {contactTags.length > 0 && (
          <div className="mt-1 flex items-center gap-1 overflow-hidden">
            {visibleTags.map((tag) => (
              // `tag.id` é único por contato — garantido pelo
              // UNIQUE(contact_id, tag_id) da tabela de vínculo.
              <span
                key={tag.id}
                title={tag.name}
                className="min-w-0 truncate rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
            {hiddenTags.length > 0 && (
              <span
                title={hiddenTags.map((tag) => tag.name).join(', ')}
                className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium"
              >
                +{hiddenTags.length}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Definições de etiquetas para o dropdown de filtro. Fetch próprio,
 * independente da aba — os NOMES/CORES das etiquetas são referência
 * estável, ao contrário das etiquetas SELECIONADAS (que vivem em
 * `useInboxTabs`, por aba). Hook interno para não duplicar o
 * `useEffect` de fetch nos dois lugares onde `<ConversationList>` é
 * montado (Chat e Open).
 */
export function useInboxTagDefinitions(): Tag[] {
  const [tags, setTags] = useState<Tag[]>([]);
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('tags').select('*').order('name');
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}
