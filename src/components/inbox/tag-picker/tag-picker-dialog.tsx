'use client';

// ============================================================
// TagPickerDialog — modal único de etiquetagem de leads no Inbox.
//
// Montado UMA vez pelo TagPickerProvider, no nível da página. Não
// recebe props: lê o contato aberto e o callback de mudança do
// context. Adicionar um novo ponto de acionamento custa uma chamada
// a `useTagPicker().open(contact)` — nenhum prop novo, nenhuma
// segunda instância de <Dialog>.
//
// Sem botão "Salvar": cada toggle persiste na hora, mesmo padrão do
// contact-detail-view. O rodapé só fecha.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Search, Tag as TagIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, canSendMessages } from '@/lib/auth/roles';
import { DEFAULT_TAG_COLOR, PRESET_COLORS, normalizeTagName } from '@/lib/tags';
import { cn } from '@/lib/utils';
import type { Contact, Tag } from '@/types';
import { useContactTags } from './use-contact-tags';

interface TagPickerDialogProps {
  contact: Contact | null;
  onClose: () => void;
  onTagsChanged: (contactId: string, tags: Tag[]) => void;
}

export function TagPickerDialog({
  contact,
  onClose,
  onTagsChanged,
}: TagPickerDialogProps) {
  const t = useTranslations('Inbox.tagPicker');
  const tColors = useTranslations('Settings.tagsAndFields.colors');
  const { accountRole } = useAuth();

  const [search, setSearch] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_TAG_COLOR);

  const { allTags, assigned, loading, creating, toggle, createAndAssign } =
    useContactTags({ contact, onTagsChanged });

  // Gates de role via os predicados de lib/auth/roles — nunca
  // comparando strings de role inline.
  //   - atribuir/remover: agent+ (política contact_tags_modify)
  //   - criar etiqueta:   admin+ (política tags_insert, migração 017)
  // A divergência é intencional: o catálogo de etiquetas é tratado
  // como configuração de conta, não como dado operacional.
  const canAssign = accountRole ? canSendMessages(accountRole) : false;
  const canCreate = accountRole ? canEditSettings(accountRole) : false;

  const assignedIds = useMemo(
    () => new Set(assigned.map((tag) => tag.id)),
    [assigned]
  );

  const filtered = useMemo(() => {
    const q = normalizeTagName(search);
    if (!q) return allTags;
    return allTags.filter((tag) => normalizeTagName(tag.name).includes(q));
  }, [allTags, search]);

  // A linha "Criar …" só aparece quando há texto e nenhuma etiqueta
  // bate exatamente com ele (case-insensitive, mesma normalização do
  // índice único da migração 038).
  const trimmedSearch = search.trim();
  const hasExactMatch = useMemo(
    () =>
      allTags.some(
        (tag) => normalizeTagName(tag.name) === normalizeTagName(search)
      ),
    [allTags, search]
  );
  const showCreateRow = canCreate && trimmedSearch.length > 0 && !hasExactMatch;

  const handleCreate = useCallback(async () => {
    if (!showCreateRow || creating) return;
    await createAndAssign(trimmedSearch, color);
    setSearch('');
    setColor(DEFAULT_TAG_COLOR);
  }, [color, creating, createAndAssign, showCreateRow, trimmedSearch]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      setSearch('');
      setColor(DEFAULT_TAG_COLOR);
      onClose();
    },
    [onClose]
  );

  const contactName = contact?.name || contact?.phone || '';

  return (
    <Dialog open={contact !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="text-primary size-4 shrink-0" />
            <span className="truncate">
              {t('title', { name: contactName })}
            </span>
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {/* Busca — Input controlado + filtro em useMemo. O design system
            não tem combobox/command, e uma dependência nova (cmdk) não
            se justifica para uma lista desse tamanho. */}
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreate();
              }
            }}
            placeholder={t('searchPlaceholder')}
            maxLength={40}
            className="pl-9"
            aria-label={t('searchPlaceholder')}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : (
          <ScrollArea className="max-h-64">
            {filtered.length === 0 ? (
              <p className="text-muted-foreground px-1 py-6 text-center text-xs">
                {allTags.length === 0 ? t('noTags') : t('noResults')}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((tag) => {
                  const checked = assignedIds.has(tag.id);
                  return (
                    <li key={tag.id}>
                      <label
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors',
                          canAssign
                            ? 'hover:bg-muted cursor-pointer'
                            : 'cursor-not-allowed opacity-60'
                        )}
                        // Explica o estado desabilitado num ancestral
                        // não-disabled, que recebe mouseover em todos os
                        // navegadores (mesma razão do GatedButton).
                        title={canAssign ? undefined : t('readOnly')}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!canAssign}
                          onCheckedChange={() => toggle(tag)}
                        />
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        {/* O nome é sempre texto legível — a cor é
                            redundante, nunca a única informação. */}
                        <span className="text-foreground truncate">
                          {tag.name}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        )}

        {/* Criação — só admin/owner. A política tags_insert (017)
            restringe o INSERT em `tags` a admin+, então mostrar o
            formulário para um agent produziria um 42501 garantido. */}
        {showCreateRow && (
          <div className="border-border space-y-2.5 border-t pt-3">
            <div className="flex gap-1.5">
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setColor(preset.value)}
                  aria-label={t('useColor', { color: tColors(preset.name) })}
                  aria-pressed={color === preset.value}
                  title={tColors(preset.name)}
                  className={cn(
                    'size-6 rounded-md transition-transform hover:scale-110',
                    color === preset.value &&
                      'outline-primary outline outline-2 outline-offset-2'
                  )}
                  style={{ backgroundColor: preset.value }}
                />
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              <span className="truncate">
                {t('createTag', { name: trimmedSearch })}
              </span>
            </Button>
          </div>
        )}

        {/* Sem permissão de criar: explica em vez de simplesmente não
            mostrar nada quando a busca não encontra resultado. */}
        {!canCreate && trimmedSearch.length > 0 && !hasExactMatch && (
          <p className="text-muted-foreground border-border border-t pt-3 text-xs">
            {t('onlyAdminsCanCreate')}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
