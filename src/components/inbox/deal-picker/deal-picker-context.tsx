'use client';

// ============================================================
// DealPickerProvider — dono do estado do modal de criação de negócio.
//
// Por que um provider, se há um único trigger:
//
//   A ContactSidebar é REMOVIDA da árvore quando o agente colapsa o
//   painel de contato. Um <Dialog> montado ali desapareceria no meio
//   do preenchimento, levando junto o título já digitado — e este
//   modal, diferente do picker de etiquetas, tem um formulário com
//   rascunho, então perder o estado é uma falha visível.
//
//   De quebra, um segundo gatilho (header do MessageThread, quando o
//   mobile virar requisito) passa a custar uma linha.
//
// Diferença deliberada do TagPickerProvider: o callback de sucesso
// vem por chamada, em `open(contact, { onCreated })`, e não como prop
// do provider. Lá quem precisava do resultado era a PÁGINA (o filtro
// por etiqueta lê `conversation.contact.tags`); aqui é o TRIGGER — a
// sidebar é a única dona da lista de negócios, que não vive no estado
// da página nem em CONVERSATION_SELECT.
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Contact, Deal } from '@/types';
import { DealPickerDialog } from './deal-picker-dialog';

interface DealPickerOptions {
  /** Chamado com o negócio criado, já com `stage` embutido. */
  onCreated?: (deal: Deal) => void;
}

interface DealPickerContextValue {
  /** Abre o modal para o contato informado. */
  open: (contact: Contact, options?: DealPickerOptions) => void;
  close: () => void;
  /** Contato atualmente no modal, ou null quando fechado. */
  contact: Contact | null;
  isOpen: boolean;
}

const DealPickerContext = createContext<DealPickerContextValue | null>(null);

export function DealPickerProvider({ children }: { children: ReactNode }) {
  // `isOpen` é derivado de `contact` em vez de ser um segundo
  // useState — elimina por construção o estado inconsistente
  // "aberto sem contato".
  const [contact, setContact] = useState<Contact | null>(null);

  // Num ref e não em estado: trocar o callback não deve provocar
  // render, e ele precisa sobreviver ao unmount do trigger (o agente
  // pode colapsar o painel de contato com o modal aberto).
  const onCreatedRef = useRef<((deal: Deal) => void) | undefined>(undefined);

  const open = useCallback((next: Contact, options?: DealPickerOptions) => {
    onCreatedRef.current = options?.onCreated;
    setContact(next);
  }, []);

  const close = useCallback(() => {
    setContact(null);
    onCreatedRef.current = undefined;
  }, []);

  // Wrapper estável: o dialog nunca vê a identidade do callback mudar.
  // Se a sidebar desmontou no meio do preenchimento, isto vira no-op —
  // e não é bug: ao reabrir o painel, o `fetchContactData` da sidebar
  // roda de novo e traz o negócio recém-criado.
  const notifyCreated = useCallback((deal: Deal) => {
    onCreatedRef.current?.(deal);
  }, []);

  const value = useMemo<DealPickerContextValue>(
    () => ({ open, close, contact, isOpen: contact !== null }),
    [open, close, contact]
  );

  return (
    <DealPickerContext.Provider value={value}>
      {children}
      <DealPickerDialog
        contact={contact}
        onClose={close}
        onCreated={notifyCreated}
      />
    </DealPickerContext.Provider>
  );
}

/**
 * Acessa o picker de negócios. Lança fora do provider — um trigger
 * que não abre nada é um bug silencioso difícil de rastrear, então
 * falhamos alto no desenvolvimento.
 */
export function useDealPicker(): DealPickerContextValue {
  const ctx = useContext(DealPickerContext);
  if (!ctx) {
    throw new Error(
      'useDealPicker deve ser usado dentro de <DealPickerProvider>'
    );
  }
  return ctx;
}
