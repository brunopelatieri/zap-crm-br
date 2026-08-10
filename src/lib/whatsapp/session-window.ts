/**
 * Janela de sessão de 24h da Meta (SPEC 045 §5.1).
 *
 * Por que isto existe
 *
 *   Pelas regras do WhatsApp Cloud API, mensagem de sessão (texto livre,
 *   botões, listas) só pode ser mandada dentro de 24h contadas a partir
 *   da ÚLTIMA mensagem que o CLIENTE enviou. Antes desta função, essa
 *   regra só existia como hint de UI, calculada em memória no navegador
 *   do agente (`message-thread.tsx`) — o motor de automações, que é
 *   quem de fato pode mandar mensagem fora da janela via um `wait`, era
 *   cego a ela. Esta função é o relógio da verdade único: o inbox e o
 *   motor de automações passam a ler daqui, não a recalcular cada um do
 *   seu jeito.
 *
 * Minutos, não horas inteiras
 *
 *   O hint anterior usava `differenceInHours`, que trunca — "faltam 3h"
 *   cobre de 3h00 a 3h59. O servidor precisa de granularidade de
 *   minutos (a margem do trigger de varredura é configurada em minutos
 *   e o cron roda a cada ~5), então esta função trabalha em
 *   milissegundos e expõe `minutesRemaining`.
 *
 * Fechamento exclusivo
 *
 *   Exatamente 24h após a última mensagem do cliente, a janela já está
 *   FECHADA — mesma convenção de `endHour` em `send-window.ts` (a hora
 *   de fechamento é exclusiva).
 */

/** Duração da janela de sessão da Meta. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SessionWindowState {
  lastCustomerMessageAt: Date | null;
  isOpen: boolean;
  /** Minutos restantes até fechar; negativo se já fechada. */
  minutesRemaining: number;
}

/**
 * Estado da janela de sessão a partir da última mensagem do cliente.
 *
 * `lastCustomerMessageAt: null` (cliente nunca escreveu, ou a conversa
 * não tem mensagem de cliente registrada) é tratado como janela
 * fechada — o padrão seguro para "não sei" é fechado, não aberto (é
 * exatamente o bug que a adoção desta função corrige no hint do inbox,
 * §5.9).
 */
export function computeSessionWindow(
  lastCustomerMessageAt: Date | null,
  now: Date = new Date()
): SessionWindowState {
  if (!lastCustomerMessageAt) {
    return {
      lastCustomerMessageAt: null,
      isOpen: false,
      minutesRemaining: -Infinity,
    };
  }

  const elapsedMs = now.getTime() - lastCustomerMessageAt.getTime();
  const remainingMs = SESSION_WINDOW_MS - elapsedMs;

  return {
    lastCustomerMessageAt,
    isOpen: remainingMs > 0,
    minutesRemaining: Math.floor(remainingMs / 60_000),
  };
}
