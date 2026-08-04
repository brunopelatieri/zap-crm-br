'use client';

import { MessageCircle, Inbox, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { TAB_DEFINITIONS, type TabId } from '@/lib/inbox/tabs';

interface InboxTabsProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  /**
   * Slot opcional ao final da barra, alinhado à direita. Hoje só o
   * seletor "ver como" da aba Chat (SPEC 042, D7) — fica aqui, e não
   * dentro deste componente, porque `InboxTabs` é deliberadamente
   * genérico (sem noção de papel de conta); quem decide SE o seletor
   * aparece é o chamador (`inbox/page.tsx`, sob
   * `useCan('view-all-conversations')`).
   */
  trailing?: React.ReactNode;
}

// Ícone por aba — mora aqui (não em lib/inbox/tabs.ts) porque tabs.ts
// é um módulo puro, sem React/lucide, para poder ser testado sem
// nenhum runtime de UI (src/lib/inbox/tabs.test.ts).
const TAB_ICONS: Record<TabId, typeof MessageCircle> = {
  chat: MessageCircle,
  open: Inbox,
  contacts: Users,
};

/**
 * Barra de 3 abas do Inbox — Chat / Open / Contacts. Fica acima do
 * conteúdo (lista+thread+sidebar, ou o diretório de contatos) e
 * permanece visível independentemente de qual aba está ativa, para que
 * trocar de aba nunca dependa de "voltar" primeiro.
 *
 * A 3ª aba (Contacts) é compacta — só o ícone — porque é a de uso mais
 * raro das três; o rótulo vira só `aria-label` + `title`.
 */
export function InboxTabs({ activeTab, onChange, trailing }: InboxTabsProps) {
  const t = useTranslations('Inbox.tabs');

  return (
    <div
      role="tablist"
      aria-label={t('tablistLabel')}
      className="border-border bg-card flex shrink-0 items-center gap-1 border-b px-3 py-1.5"
    >
      {TAB_DEFINITIONS.map((def) => {
        const Icon = TAB_ICONS[def.id];
        const isActive = def.id === activeTab;
        const label = t(def.labelKey);
        // Contacts é compacta — só ícone. As outras duas mostram
        // texto (o rótulo literal pedido: "Chat" / "Open").
        const compact = def.id === 'contacts';

        return (
          <button
            key={def.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            title={label}
            onClick={() => onChange(def.id)}
            className={cn(
              'inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
              compact ? 'w-8 px-0' : 'px-3',
              isActive
                ? 'bg-muted text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  );
}
