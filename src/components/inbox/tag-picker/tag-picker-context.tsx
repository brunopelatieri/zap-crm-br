'use client';

// ============================================================
// TagPickerProvider — dono do estado do modal de etiquetas do Inbox.
//
// Por que um provider e não um <Dialog> dentro de cada trigger:
//
//   Os dois pontos de acionamento (ConversationList e ContactSidebar)
//   vivem em subárvores irmãs que montam e desmontam de forma
//   independente. O ContactSidebar é REMOVIDO da árvore quando o
//   agente colapsa o painel de contato — um modal montado ali
//   desapareceria junto com ele. Duplicar o <Dialog> nos dois lugares
//   resolveria isso ao custo de duplicar estado, fetch e lógica de
//   mutação.
//
//   Aqui o <Dialog> é montado uma vez, no nível da página, e os
//   triggers só chamam `open(contact)`.
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Contact, Tag } from '@/types';
import { TagPickerDialog } from './tag-picker-dialog';

interface TagPickerContextValue {
  /** Abre o modal para o contato informado. */
  open: (contact: Contact) => void;
  close: () => void;
  /** Contato atualmente no modal, ou null quando fechado. */
  contact: Contact | null;
  isOpen: boolean;
}

const TagPickerContext = createContext<TagPickerContextValue | null>(null);

interface TagPickerProviderProps {
  children: ReactNode;
  /**
   * Chamado após TODA mutação (inclusive no rollback de uma que
   * falhou) com a lista completa de etiquetas do contato.
   *
   * A página usa isso para manter `conversations[].contact.tags` e
   * `activeContact` em sincronia. Não é opcional: o filtro por
   * etiqueta da lista de conversas lê `conversation.contact.tags`,
   * então sem essa propagação uma conversa não entra nem sai da
   * lista filtrada até um refetch.
   */
  onTagsChanged: (contactId: string, tags: Tag[]) => void;
}

export function TagPickerProvider({
  children,
  onTagsChanged,
}: TagPickerProviderProps) {
  // `isOpen` é derivado de `contact` em vez de ser um segundo
  // useState — elimina por construção o estado inconsistente
  // "aberto sem contato".
  const [contact, setContact] = useState<Contact | null>(null);

  const open = useCallback((next: Contact) => setContact(next), []);
  const close = useCallback(() => setContact(null), []);

  const value = useMemo<TagPickerContextValue>(
    () => ({ open, close, contact, isOpen: contact !== null }),
    [open, close, contact]
  );

  return (
    <TagPickerContext.Provider value={value}>
      {children}
      <TagPickerDialog
        contact={contact}
        onClose={close}
        onTagsChanged={onTagsChanged}
      />
    </TagPickerContext.Provider>
  );
}

/**
 * Acessa o picker de etiquetas. Lança fora do provider — um trigger
 * que não abre nada é um bug silencioso difícil de rastrear, então
 * falhamos alto no desenvolvimento.
 */
export function useTagPicker(): TagPickerContextValue {
  const ctx = useContext(TagPickerContext);
  if (!ctx) {
    throw new Error(
      'useTagPicker deve ser usado dentro de <TagPickerProvider>'
    );
  }
  return ctx;
}
