/**
 * Card de estatística com badge de percentual — promovido de
 * `[id]/page.tsx` para ser reusado pelos cards da conta (SPEC 044
 * §5.2a, fase 5).
 */

import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: number;
  /**
   * Denominador do badge de percentual no canto superior. Omitido = sem
   * badge — usado quando não há um "total" que faça sentido (ex.:
   * contatos alcançados) ou quando `value` já É uma taxa (`format:
   * 'percent'`).
   */
  total?: number;
  icon: ReactNode;
  color: string;
  /**
   * 'count' (padrão) formata `value` com `toLocaleString`. 'percent'
   * anexa '%' ao número grande e não mostra o badge de percentual — o
   * valor já é uma taxa, então um percentual-do-percentual não faria
   * sentido.
   */
  format?: 'count' | 'percent';
}

export function StatCard({
  label,
  value,
  total,
  icon,
  color,
  format = 'count',
}: StatCardProps) {
  const pct =
    format === 'count' && total !== undefined
      ? total > 0
        ? Math.round((value / total) * 100)
        : 0
      : null;

  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}
        >
          {icon}
        </div>
        {pct !== null && (
          <span className="text-muted-foreground text-xs">{pct}%</span>
        )}
      </div>
      <p className="text-foreground mt-3 text-2xl font-bold">
        {format === 'percent' ? `${value}%` : value.toLocaleString()}
      </p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  );
}
