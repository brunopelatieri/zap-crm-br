// ============================================================
// Notas de contato — escrita para o webhook de entrada (SPEC 055
// achado C / F3).
//
// Extrai para `src/lib/` a lógica que hoje só existe dentro de
// `addNote()` em `contact-detail-view.tsx` (e sua segunda cópia em
// `contact-sidebar.tsx`) — a mesma forma de insert (`contact_id`,
// `account_id`, `user_id`, `note_text`), sem UI. Notas nunca são
// deduplicadas nem substituídas: cada POST empilha (SPEC 055 D-7).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export class IngestNotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestNotesError';
  }
}

export interface InsertContactNotesParams {
  accountId: string;
  userId: string;
  contactId: string;
  /** Texto já normalizado por `parseIngestPayload` — trimado, não vazio. */
  notes: string[];
}

/**
 * Insere uma linha em `contact_notes` por entrada de `notes`, na
 * ordem dada. No-op (sem chamada ao banco) quando `notes` está vazio.
 */
export async function insertContactNotes(
  db: SupabaseClient,
  { accountId, userId, contactId, notes }: InsertContactNotesParams
): Promise<{ inserted: number }> {
  if (notes.length === 0) return { inserted: 0 };

  const { error } = await db.from('contact_notes').insert(
    notes.map((note_text) => ({
      contact_id: contactId,
      account_id: accountId,
      user_id: userId,
      note_text,
    }))
  );

  if (error) {
    throw new IngestNotesError('Failed to insert contact notes');
  }

  return { inserted: notes.length };
}
