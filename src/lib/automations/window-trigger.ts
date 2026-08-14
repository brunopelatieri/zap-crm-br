/**
 * Configuração do trigger `session_window_expiring` (SPEC 045 §5.5/§5.7.1).
 *
 * Módulo deliberadamente PURO — sem cliente de banco, sem React. É
 * importado por três lados que não podem se importar entre si: a
 * validação de ativação (`validate.ts`), a varredura server-side
 * (`window-scan.ts`) e o construtor no navegador
 * (`automation-builder.tsx`). Um `import` de `admin-client` aqui
 * arrastaria a service-role key para o bundle do cliente.
 *
 * Por que o piso é 15 e não 1
 *
 *   A conversa fica elegível enquanto `now - last_customer_message_at`
 *   está em `[24h − margem, 24h)`, ou seja: **a largura da faixa de
 *   elegibilidade é exatamente `margin_minutes`**. O cron pinga a cada
 *   ~5 min. Uma margem de 1 minuto cria uma faixa de 1 minuto que o
 *   tick só acerta em ~1 de cada 5 janelas — a automação "funciona",
 *   dispara às vezes, e o autor não tem como descobrir por quê. O valor
 *   não é apenas inútil, é enganoso.
 *
 *   O piso matemático seria 5 (com ticks perfeitamente periódicos, uma
 *   faixa de 5 min sempre contém um tick). O piso PRÁTICO é maior
 *   porque os ticks não são periódicos: o `pg_net` é beta por admissão
 *   do próprio `cron-jobs.sql`, que assume que uma execução pode falhar
 *   e conta com a seguinte. Daí 15 minutos = 3 ticks, que tolera duas
 *   execuções perdidas seguidas.
 *
 * Por que o teto é 1440
 *
 *   Sanidade, não recomendação: margem = 1440 significa "elegível desde
 *   o instante em que o cliente escreveu", o que transforma o trigger
 *   num `new_message_received` com atraso de até 5 min.
 */

/** Margem padrão: 4h de antecedência (§10, pergunta 1). */
export const DEFAULT_MARGIN_MINUTES = 240;

/** 3 ticks de cron — tolera duas execuções perdidas seguidas. */
export const MIN_MARGIN_MINUTES = 15;

/** 24h: acima disso o trigger deixa de ser "janela fechando". */
export const MAX_MARGIN_MINUTES = 1440;

/**
 * Acima deste valor a UI avisa (não bloqueia): uma margem de mais de
 * 12h reengaja gente que acabou de falar com a gente.
 */
export const MARGIN_WARN_ABOVE_MINUTES = 720;

/** `true` se o valor é aceitável para ativar a automação. */
export function isValidMarginMinutes(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_MARGIN_MINUTES &&
    v <= MAX_MARGIN_MINUTES
  );
}

/**
 * Margem efetiva de um `trigger_config` vindo do JSONB.
 *
 * Ausente cai no padrão; qualquer coisa fora da faixa é CLAMPADA em vez
 * de rejeitada — este é o caminho de execução, e uma automação já ativa
 * com um valor estranho (gravado antes da validação existir, ou por
 * escrita direta no banco) precisa fazer algo sensato, não explodir a
 * varredura inteira das outras contas.
 */
export function resolveMarginMinutes(triggerConfig: unknown): number {
  const raw = (triggerConfig as { margin_minutes?: unknown } | null)
    ?.margin_minutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_MARGIN_MINUTES;
  }
  return Math.min(
    MAX_MARGIN_MINUTES,
    Math.max(MIN_MARGIN_MINUTES, Math.round(raw))
  );
}
