'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { toast } from 'sonner';
import type { Contact } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Users, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';

const PAGE_SIZE = 25;

/**
 * Aba "Contacts" do Inbox — diretório com busca (spec: "A contact
 * directory list featuring a search bar", sem filtro de etiquetas —
 * isso já existe na página /contacts completa).
 *
 * Visibilidade (decisão D2 do plano): derivada das conversas, não uma
 * coluna nova em `contacts`.
 *   - admin/owner (`canViewAllConversations`) → todos os contatos da
 *     conta, igual à página /contacts.
 *   - agent → só contatos com pelo menos uma conversa ATRIBUÍDA A ELE.
 *     `contacts` não tem RLS restrita por atribuição (não carrega
 *     conteúdo de conversa — Fase 1 deliberadamente não mexeu nela),
 *     então essa restrição é aplicada aqui: resolve os `contact_id`
 *     das minhas conversas primeiro, depois filtra `contacts` por
 *     `.in('id', ...)`. O índice único (account_id, contact_id) da
 *     migração 036 garante no máximo uma conversa por contato+conta,
 *     então este conjunto é do tamanho da minha carteira, não da base
 *     inteira — mesmo trade-off de escala que `lib/dashboard/queries.ts`
 *     já documenta para o resto do app.
 */
export function ContactsDirectory() {
  const t = useTranslations('Inbox.contactsDirectory');
  const { user, profileLoading } = useAuth();
  // Extraído do objeto `user` para uma primitiva estável: o callback
  // abaixo só toca `userId`, nunca `user` diretamente, para casar com o
  // que o React Compiler infere como dependência (senão a memoização
  // manual do `useCallback` e a inferida divergem e ele desiste de
  // otimizar o componente).
  const userId = user?.id ?? null;
  const canViewAll = useCan('view-all-conversations');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);

  // Mesma guarda de corrida que a página /contacts usa: só o fetch
  // mais recente pode gravar seu resultado.
  const fetchSeq = useRef(0);

  const fetchContacts = useCallback(async () => {
    // Espera o papel resolver — senão `canViewAll` lê `false` durante
    // o loading (useCan) e um admin veria brevemente "meus contatos"
    // antes de trocar para "todos" assim que o perfil chegasse.
    if (profileLoading || !userId) return;

    const seq = ++fetchSeq.current;
    setLoading(true);

    const supabase = createClient();
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();
    const like = term ? `%${term}%` : null;

    let contactIdsFilter: string[] | null = null;

    if (!canViewAll) {
      const { data: myConvs, error: convErr } = await supabase
        .from('conversations')
        .select('contact_id')
        .eq('assigned_agent_id', userId);
      if (seq !== fetchSeq.current) return;
      if (convErr) {
        toast.error(t('loadError'));
        setLoading(false);
        return;
      }
      contactIdsFilter = Array.from(
        new Set((myConvs ?? []).map((c) => c.contact_id))
      );
      if (contactIdsFilter.length === 0) {
        setContacts([]);
        setTotalCount(0);
        setLoading(false);
        return;
      }
    }

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (contactIdsFilter) query = query.in('id', contactIdsFilter);
    if (like) {
      query = query.or(
        `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
      );
    }

    const { data, count, error } = await query;
    if (seq !== fetchSeq.current) return;
    if (error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }

    setContacts(data ?? []);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [profileLoading, userId, canViewAll, page, search, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  const openDetail = useCallback((id: string) => {
    setDetailContactId(id);
    setDetailOpen(true);
  }, []);

  const emptyMessage = search.trim()
    ? t('noneMatch')
    : canViewAll
      ? t('noneYet')
      : t('noneAssigned');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-border space-y-3 border-b p-4">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {canViewAll ? t('subtitleAll') : t('subtitleMine')}
          </p>
        </div>
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // Resultado muda de tamanho — a página N pode não valer mais.
              setPage(0);
            }}
            placeholder={t('searchPlaceholder')}
            className="bg-muted border-border pl-8"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Users className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <div className="divide-border divide-y">
            {contacts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => openDetail(c.id)}
                className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <div className="bg-muted text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium">
                  {(c.name || c.phone).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">
                    {c.name || (
                      <span className="text-muted-foreground italic">
                        {t('unnamed')}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {c.phone}
                  </p>
                </div>
                {c.company && (
                  <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                    {c.company}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="border-border flex items-center justify-between border-t px-4 py-2">
          <p className="text-muted-foreground text-xs">
            {t('pageCount', { page: page + 1, total: totalPages })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />
    </div>
  );
}
