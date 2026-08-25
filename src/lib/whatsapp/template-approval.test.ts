import { describe, expect, it } from 'vitest';

import { checkTemplateApproval } from './template-approval';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';

function templateWithStatus(status: MessageTemplateStatus): MessageTemplate {
  return {
    id: 't1',
    user_id: 'u1',
    name: 'promo',
    category: 'Marketing',
    body_text: 'Hello',
    status,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('checkTemplateApproval', () => {
  it('rejects a missing row as not_found', () => {
    expect(checkTemplateApproval(null)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(checkTemplateApproval(undefined)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  const NOT_APPROVED: MessageTemplateStatus[] = [
    'DRAFT',
    'PENDING',
    'REJECTED',
    'PAUSED',
    'DISABLED',
    'IN_APPEAL',
    'PENDING_DELETION',
  ];

  it.each(NOT_APPROVED)('rejects status %s as not_approved', (status) => {
    const row = templateWithStatus(status);
    expect(checkTemplateApproval(row)).toEqual({
      ok: false,
      reason: 'not_approved',
      status,
    });
  });

  it('accepts APPROVED', () => {
    const row = templateWithStatus('APPROVED');
    expect(checkTemplateApproval(row)).toEqual({ ok: true, template: row });
  });

  it('rejects a row with no status at all as not_approved', () => {
    const row = { ...templateWithStatus('APPROVED'), status: undefined };
    expect(checkTemplateApproval(row)).toEqual({
      ok: false,
      reason: 'not_approved',
      status: undefined,
    });
  });
});
