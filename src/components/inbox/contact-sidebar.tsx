'use client';

import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useTagPicker } from '@/components/inbox/tag-picker/tag-picker-context';
import { useDealPicker } from '@/components/inbox/deal-picker/deal-picker-context';
import { canSendMessages } from '@/lib/auth/roles';
import { formatPhoneForDisplay } from '@/lib/phone/br';

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
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
    </div>
  );
}
