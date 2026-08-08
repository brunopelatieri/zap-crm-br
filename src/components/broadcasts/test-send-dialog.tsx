'use client';

/**
 * "Enviar teste" — simulação a seco (SPEC 044 §6.7).
 *
 * Manda o template para até `MAX_TEST_SEND_RECIPIENTS` contatos
 * escolhidos a dedo, com a MESMA resolução de variáveis
 * (`variables`/`headerMediaUrl`) que o passo 4 vai usar no disparo de
 * verdade — a rota faz a chamada de verdade a `sendTemplateMessage`,
 * sem criar `broadcasts`/`broadcast_recipients`. É a diferença entre
 * isto e a pré-visualização estática logo abaixo no passo 3: aqui o
 * usuário recebe a mensagem de verdade no celular, com os dados de um
 * contato real.
 *
 * A busca de contatos é uma leitura direta sob RLS (mesmo padrão do
 * `ContactsDirectory` do inbox) — não precisa de rota própria porque
 * não é nada que a RLS de `contacts` já não deixe o usuário ver.
 */

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  Search,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import type { Contact, MessageTemplate } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type VariableType = 'static' | 'field' | 'custom_field';
interface VariableMapping {
  type: VariableType;
  value: string;
}

type TestSendStatus =
  'sent' | 'failed' | 'invalid_phone' | 'opted_out' | 'not_found';

interface TestSendResult {
  contactId: string;
  name: string | null;
  phone: string;
  status: TestSendStatus;
  error?: string;
  messageId?: string;
}

export const MAX_TEST_SEND_RECIPIENTS = 5;

interface TestSendDialogProps {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  headerMediaUrl: string;
}

export function TestSendDialog({
  template,
  variables,
  headerMediaUrl,
}: TestSendDialogProps) {
  const t = useTranslations('Broadcasts.wizard.personalize.testSend');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<TestSendResult[] | null>(null);

  // Busca com debounce, só enquanto o diálogo está aberto.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoadingContacts(true);
      const supabase = createClient();
      const term = search.trim();
      let query = supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like}`);
      }
      const { data } = await query;
      if (!cancelled) {
        setContacts((data ?? []) as Contact[]);
        setLoadingContacts(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, search]);

  function toggleContact(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TEST_SEND_RECIPIENTS) return prev;
      return [...prev, id];
    });
  }

  async function handleSend() {
    if (selectedIds.length === 0) return;
    setSending(true);
    try {
      const res = await fetch('/api/broadcasts/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateName: template.name,
          templateLanguage: template.language ?? 'en_US',
          variables,
          headerMediaUrl,
          contactIds: selectedIds,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string' ? data.error : t('toastFailed')
        );
      }
      setResults(data.results as TestSendResult[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastFailed'));
    } finally {
      setSending(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Reabrir mostra um estado limpo em vez do resultado do teste
      // anterior — cada abertura é uma nova rodada.
      setResults(null);
      setSelectedIds([]);
      setSearch('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="border-border text-muted-foreground hover:bg-muted"
          />
        }
      >
        <FlaskConical className="h-4 w-4" />
        {t('button')}
      </DialogTrigger>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('dialogSubtitle', { max: MAX_TEST_SEND_RECIPIENTS })}
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {results.map((r) => (
              <div
                key={r.contactId}
                className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="text-foreground truncate font-medium">
                    {r.name || r.phone || r.contactId}
                  </p>
                  {r.phone && (
                    <p className="text-muted-foreground truncate text-xs">
                      {r.phone}
                    </p>
                  )}
                  {r.error && (
                    <p
                      className="mt-0.5 truncate text-xs text-red-400"
                      title={r.error}
                    >
                      {r.error}
                    </p>
                  )}
                </div>
                <Badge
                  variant="outline"
                  className={
                    r.status === 'sent'
                      ? 'border-emerald-500/30 text-emerald-400'
                      : 'border-amber-500/30 text-amber-300'
                  }
                >
                  {r.status === 'sent' ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  {t(`status.${r.status}`)}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground pl-8"
              />
            </div>

            <p className="text-muted-foreground text-xs">
              {t('selectedCount', {
                count: selectedIds.length,
                max: MAX_TEST_SEND_RECIPIENTS,
              })}
            </p>

            <div className="border-border max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
              {loadingContacts ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="text-primary h-4 w-4 animate-spin" />
                </div>
              ) : contacts.length === 0 ? (
                <p className="text-muted-foreground p-3 text-center text-xs">
                  {t('noResults')}
                </p>
              ) : (
                contacts.map((c) => {
                  const checked = selectedIds.includes(c.id);
                  const capped =
                    !checked && selectedIds.length >= MAX_TEST_SEND_RECIPIENTS;
                  return (
                    <label
                      key={c.id}
                      className={`hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                        capped ? 'opacity-50' : 'cursor-pointer'
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={capped}
                        onCheckedChange={() => toggleContact(c.id)}
                      />
                      <span className="text-foreground truncate">
                        {c.name || c.phone}
                      </span>
                      {c.name && (
                        <span className="text-muted-foreground truncate text-xs">
                          {c.phone}
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button
              variant="outline"
              onClick={() => {
                setResults(null);
                setSelectedIds([]);
              }}
              className="border-border text-muted-foreground"
            >
              {t('testAgain')}
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={selectedIds.length === 0 || sending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FlaskConical className="h-4 w-4" />
              )}
              {sending ? t('sending') : t('send')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
