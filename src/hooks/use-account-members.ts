'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types';

export interface UseAccountMembersResult {
  members: Profile[];
  loading: boolean;
}

/**
 * Membros da conta do usuário logado, ordenados por nome.
 *
 * A RLS de `profiles` (`profiles_select`, migração 017) devolve
 * `auth.uid() = user_id OR is_account_member(account_id)` — ou seja,
 * já é escopada por CONTA, não pelo usuário: qualquer membro enxerga
 * todos os colegas. Este hook só existe para não duplicar o fetch em
 * cada consumidor.
 *
 * Dois consumidores hoje:
 *   - o dropdown de atribuição do `MessageThread` (assumir/reatribuir
 *     uma conversa);
 *   - o seletor "ver como" da aba Chat, para admin/owner (SPEC 042,
 *     D7) — supervisionar a carteira de outro agente.
 *
 * Extraído do fetch que antes vivia embutido no `MessageThread` para
 * que os dois não repitam a mesma query.
 *
 * @param enabled Só busca quando `true` (default). O seletor "ver
 * como" só existe para admin/owner — passar `enabled: canViewAll`
 * evita gastar a query para todo agente comum que abre o Inbox.
 */
export function useAccountMembers(enabled = true): UseAccountMembersResult {
  const [members, setMembers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('full_name');
      if (cancelled) return;
      if (error) {
        console.error('[use-account-members] failed to fetch:', error);
        setLoading(false);
        return;
      }
      setMembers((data as Profile[]) ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { members, loading };
}
