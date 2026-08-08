'use client';

/**
 * Funil em CSS puro: barras de largura decrescente.
 *
 * Vivia dentro de `[id]/page.tsx` até a §6.6 precisar de dois funis lado
 * a lado na comparação de variantes. Saiu de lá sem mudar de forma — o
 * único acréscimo é o `title`, porque "Funnel" estava cravado em inglês
 * no meio de uma tela traduzida.
 */

export interface FunnelStep {
  label: string;
  value: number;
  /** Classe Tailwind de fundo da barra, ex. `bg-primary`. */
  color: string;
}

interface FunnelChartProps {
  steps: FunnelStep[];
  title: string;
  /** Linha extra sob o título — usada pela comparação A/B. */
  subtitle?: string;
  className?: string;
}

export function FunnelChart({
  steps,
  title,
  subtitle,
  className,
}: FunnelChartProps) {
  // A largura é relativa ao maior passo (tipicamente "enviadas"), então a
  // primeira barra sempre aparece cheia e as demais proporcionais.
  const max = Math.max(...steps.map((s) => s.value), 1);

  return (
    <div
      className={`border-border bg-card rounded-xl border p-4 ${className ?? ''}`}
    >
      <div className="mb-4">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {subtitle && (
          <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
        )}
      </div>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="text-muted-foreground w-20 shrink-0 text-xs">
                {step.label}
              </span>
              <div className="bg-muted relative h-7 flex-1 rounded-full">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="text-foreground absolute inset-0 flex items-center px-3 text-xs font-medium text-white">
                  {step.value.toLocaleString()}
                  <span className="text-muted-foreground/80 ml-2 text-white">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
