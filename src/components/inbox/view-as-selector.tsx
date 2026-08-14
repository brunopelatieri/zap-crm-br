'use client';

import { Check, ChevronDown, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { Profile } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ViewAsSelectorProps {
  members: Profile[];
  membersLoading: boolean;
  selfUserId: string;
  /** `null` = vendo minhas próprias conversas (o padrão). */
  value: string | null;
  onChange: (userId: string | null) => void;
}

/**
 * Seletor "ver como" — supervisão de admin/owner sobre a carteira de
 * outro agente na aba "Chat" (SPEC 042, D7).
 *
 * Só é montado pelo chamador quando `useCan('view-all-conversations')`
 * é verdadeiro — não há checagem de papel aqui dentro. A RLS da 039 é
 * quem de fato autoriza: mesmo que este componente fosse renderizado
 * para um agente comum (não deveria acontecer, mas por defesa em
 * profundidade), escolher outro alvo aqui só produziria uma lista
 * vazia — `conversations_select` não devolve linha nenhuma para
 * `assigned_agent_id = <outro agente>` a quem não é dono, admin ou
 * owner.
 *
 * O predicado por trás disto é sempre `assigned_agent_id = <alvo>`
 * (`lib/inbox/tabs.ts`) — só muda quem é o alvo. Escolher "a mim
 * mesmo" na lista tem o MESMO efeito de escolher null (o componente
 * trata os dois como "voltar para minhas conversas"), porque o
 * predicado resultante é idêntico.
 */
export function ViewAsSelector({
  members,
  membersLoading,
  selfUserId,
  value,
  onChange,
}: ViewAsSelectorProps) {
  const t = useTranslations('Inbox.tabs');

  const viewingOther = value !== null && value !== selfUserId;
  const observedMember = viewingOther
    ? members.find((m) => m.user_id === value)
    : undefined;

  const triggerLabel = viewingOther
    ? (observedMember?.full_name ?? t('viewAsUnknownMember'))
    : t('viewAsMe');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-muted inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          viewingOther ? 'text-primary' : 'text-muted-foreground'
        )}
        aria-label={t('viewAsAriaLabel')}
        title={t('viewAsAriaLabel')}
      >
        <Eye className="h-3.5 w-3.5" />
        <span className="max-w-32 truncate sm:max-w-48">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        <DropdownMenuItem
          onClick={() => onChange(null)}
          className={cn(
            'text-sm',
            !viewingOther ? 'text-primary' : 'text-popover-foreground'
          )}
        >
          <span className="flex-1">{t('viewAsMe')}</span>
          {!viewingOther && <Check className="ml-2 h-3 w-3" />}
        </DropdownMenuItem>

        {membersLoading ? (
          <DropdownMenuItem disabled className="text-muted-foreground text-sm">
            {t('viewAsLoadingMembers')}
          </DropdownMenuItem>
        ) : (
          members
            .filter((m) => m.user_id !== selfUserId)
            .map((m) => {
              const isSelected = m.user_id === value;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => onChange(m.user_id)}
                  className={cn(
                    'text-sm',
                    isSelected ? 'text-primary' : 'text-popover-foreground'
                  )}
                >
                  <span className="flex-1 truncate">{m.full_name}</span>
                  {isSelected && <Check className="ml-2 h-3 w-3 shrink-0" />}
                </DropdownMenuItem>
              );
            })
        )}

        {members.filter((m) => m.user_id !== selfUserId).length === 0 &&
          !membersLoading && (
            <>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                disabled
                className="text-muted-foreground text-sm"
              >
                {t('viewAsNoTeammates')}
              </DropdownMenuItem>
            </>
          )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
