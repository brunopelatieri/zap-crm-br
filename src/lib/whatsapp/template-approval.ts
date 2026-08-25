// ============================================================
// Guarda de "template aprovado" — SPEC 055 achado E / D-9.
//
// Não existia checagem server-side de `status = 'APPROVED'` em lugar
// nenhum antes desta SPEC: os três `.eq('status', 'APPROVED')`
// existentes (`step1-choose-template.tsx`, `template-picker.tsx`,
// `automation-builder.tsx`) são filtros de LISTAGEM client-side, não
// guardas de envio — `createBroadcast` e `send-message.ts` buscam o
// template só pela forma (`isMessageTemplate`), nunca pelo status.
//
// Função pura sobre uma linha JÁ CARREGADA (e já validada na forma
// pelo chamador via `isMessageTemplate`) — não faz I/O.
// ============================================================

import type { MessageTemplate, MessageTemplateStatus } from '@/types';

export type TemplateApprovalResult =
  | { ok: true; template: MessageTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_approved'; status?: MessageTemplateStatus };

/**
 * `row` é `null`/`undefined` quando a busca não encontrou o template
 * NESTA conta (id inexistente, ou de outra conta — a query do
 * chamador já filtra por `account_id`). Qualquer status diferente de
 * `APPROVED` (`PENDING`, `REJECTED`, `PAUSED`, `DISABLED`,
 * `IN_APPEAL`, `PENDING_DELETION`, ou ausente) reprova.
 */
export function checkTemplateApproval(
  row: MessageTemplate | null | undefined
): TemplateApprovalResult {
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'APPROVED') {
    return { ok: false, reason: 'not_approved', status: row.status };
  }
  return { ok: true, template: row };
}
