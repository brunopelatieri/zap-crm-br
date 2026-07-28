'use client';

// ============================================================
// use-contact-tags — camada de dados do picker de etiquetas.
//
// Responsável por: carregar o catálogo da conta, manter a lista de
// etiquetas do contato aberto, e expor as três mutações (atribuir,
// remover, criar-e-atribuir) com atualização otimista + rollback.
//
// A UI (tag-picker-dialog) não fala com o Supabase — só consome este
// hook. Isso mantém o componente de apresentação testável sem mock de
// rede, e permite que a lógica de reconciliação (que é a parte
// delicada, ver `commit` abaixo) viva num lugar só.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  DEFAULT_TAG_COLOR,
  assignTag,
  createTag,
  fetchTags,
  findTagByName,
  unassignTag,
} from '@/lib/tags';
import type { Contact, Tag } from '@/types';

interface UseContactTagsOptions {
  /** Contato aberto no modal, ou null quando fechado. */
  contact: Contact | null;
  /**
   * Chamado após cada mutação (otimista e no rollback) com a lista
   * completa de etiquetas do contato. O consumidor propaga isso para
   * o estado da página — sem isso o filtro por etiqueta da lista de
   * conversas fica desatualizado (ver §4.2 do SPEC).
   */
  onTagsChanged: (contactId: string, tags: Tag[]) => void;
}

export interface UseContactTagsResult {
  /** Catálogo de etiquetas da conta. */
  allTags: Tag[];
  /** Etiquetas atribuídas ao contato aberto. */
  assigned: Tag[];
  /** Catálogo ainda carregando. */
  loading: boolean;
  /** Uma criação está em voo (a única mutação não-otimista). */
  creating: boolean;
  toggle: (tag: Tag) => Promise<void>;
  createAndAssign: (name: string, color?: string) => Promise<void>;
}

export function useContactTags({
  contact,
  onTagsChanged,
}: UseContactTagsOptions): UseContactTagsResult {
  const t = useTranslations('Inbox.tagPicker');
  const { user, accountId } = useAuth();

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [assigned, setAssigned] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Mantém o callback do consumidor fora das deps das mutações. A
  // página recria `handleContactTagsChanged` sempre que o estado de
  // conversas muda; sem o ref, cada `toggle` teria identidade nova a
  // cada render e invalidaria a memoização do dialog.
  const onTagsChangedRef = useRef(onTagsChanged);
  useEffect(() => {
    onTagsChangedRef.current = onTagsChanged;
  });

  const contactId = contact?.id ?? null;

  // O contato já chega com `tags` hidratado pela página (via
  // CONVERSATION_SELECT). Semear a partir dele evita um flash de
  // "sem etiquetas" ao abrir o modal — não há refetch das etiquetas
  // do contato, o estado da página é a fonte da verdade.
  useEffect(() => {
    setAssigned(contact?.tags ?? []);
  }, [contact]);

  // Catálogo: carregado a cada abertura para pegar etiquetas criadas
  // em outra aba ou por outro operador desde a última vez.
  useEffect(() => {
    if (!contactId) return;

    const supabase = createClient();
    let cancelled = false;

    setLoading(true);
    (async () => {
      try {
        const tags = await fetchTags(supabase);
        if (!cancelled) setAllTags(tags);
      } catch (err) {
        console.error('Falha ao carregar catálogo de etiquetas:', err);
        if (!cancelled) toast.error(t('failedToLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contactId, t]);

  /** Aplica uma lista de etiquetas localmente e propaga para a página. */
  const commit = useCallback((id: string, next: Tag[]) => {
    setAssigned(next);
    onTagsChangedRef.current(id, next);
  }, []);

  const toggle = useCallback(
    async (tag: Tag) => {
      if (!contactId) return;

      const previous = assigned;
      const isAssigned = previous.some((t) => t.id === tag.id);
      const next = isAssigned
        ? previous.filter((t) => t.id !== tag.id)
        : [...previous, tag];

      // Otimista: o efeito aparece antes do round-trip. A lista é
      // pequena e a percepção de latência domina a UX de etiquetagem.
      commit(contactId, next);

      try {
        const supabase = createClient();
        if (isAssigned) {
          await unassignTag(supabase, contactId, tag.id);
        } else {
          await assignTag(supabase, contactId, tag.id);
        }
      } catch (err) {
        console.error('Falha ao alternar etiqueta:', err);
        commit(contactId, previous);
        toast.error(isAssigned ? t('failedToRemove') : t('failedToAssign'));
      }
    },
    [assigned, commit, contactId, t]
  );

  const createAndAssign = useCallback(
    async (name: string, color: string = DEFAULT_TAG_COLOR) => {
      const trimmed = name.trim();
      if (!contactId || !trimmed) return;

      if (!user || !accountId) {
        toast.error(t('failedToCreate'));
        return;
      }

      // Criação não é otimista: o id da etiqueta só existe depois do
      // round-trip, e sem id não há como atribuir nem reverter.
      setCreating(true);
      try {
        const supabase = createClient();
        const tag = await createTag(supabase, {
          userId: user.id,
          accountId,
          name: trimmed,
          color,
        });

        await assignTag(supabase, contactId, tag.id);

        // `createTag` faz get-or-create — a etiqueta pode já existir no
        // catálogo (outro operador criou entre o load e agora), então
        // deduplicamos antes de inserir.
        setAllTags((prev) =>
          prev.some((existing) => existing.id === tag.id)
            ? prev
            : [...prev, tag].sort((a, b) => a.name.localeCompare(b.name))
        );

        // Idem para o vínculo: se o contato já carregava esta etiqueta,
        // atribuir de novo é no-op (o upsert absorve) e a lista local
        // não deve ganhar duplicata.
        if (!assigned.some((existing) => existing.id === tag.id)) {
          commit(contactId, [...assigned, tag]);
        }
      } catch (err) {
        console.error('Falha ao criar etiqueta:', err);
        toast.error(t('failedToCreate'));
      } finally {
        setCreating(false);
      }
    },
    [accountId, assigned, commit, contactId, t, user]
  );

  return { allTags, assigned, loading, creating, toggle, createAndAssign };
}

/** Reexportado para a UI checar colisão de nome sem importar de dois lugares. */
export { findTagByName };
