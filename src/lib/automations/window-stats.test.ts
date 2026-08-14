import { describe, expect, it, vi } from 'vitest';

import {
  deriveWindowStats,
  loadWindowStats,
  rate,
  type WindowStatsRow,
} from './window-stats';

function row(patch: Partial<WindowStatsRow> = {}): WindowStatsRow {
  return {
    claims_total: 0,
    sent: 0,
    failed: 0,
    reopened: 0,
    opted_out_after: 0,
    ...patch,
  };
}

/** Cliente mínimo com só o `.rpc()` que `loadWindowStats` usa. */
function fakeClient(result: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn(async () => result),
  } as never;
}

describe('rate', () => {
  it('is null without a denominator — "no data" is not "zero percent"', () => {
    // Uma automação que nunca disparou não tem taxa de reabertura de
    // 0%; ela não tem taxa nenhuma. O null é o que faz a UI escrever
    // "—" em vez de um zero que parece fracasso.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
  });

  it('computes the fraction otherwise', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 4)).toBe(0);
  });
});

describe('deriveWindowStats', () => {
  it('divides by sent, not by claims_total', () => {
    // 10 claims, 8 enviados, 4 reabriram, 2 falharam no despacho.
    // Dividir por claims_total daria 40%; o certo é 50%, porque os 2
    // claims que falharam nunca tiveram chance de reabrir a janela.
    // Sem isso, uma indisponibilidade da Meta viraria "queda na taxa de
    // reengajamento" — atribuindo ao CONTEÚDO da mensagem um problema
    // que foi de infraestrutura.
    const stats = deriveWindowStats(
      row({ claims_total: 10, sent: 8, failed: 2, reopened: 4 })
    );
    expect(stats.reopenRate).toBe(0.5);
  });

  it('computes the opt-out rate over sent as well', () => {
    const stats = deriveWindowStats(row({ sent: 20, opted_out_after: 1 }));
    expect(stats.optOutRate).toBe(0.05);
  });

  it('leaves both rates null when nothing was sent', () => {
    const stats = deriveWindowStats(row({ claims_total: 3, failed: 3 }));
    expect(stats.reopenRate).toBeNull();
    expect(stats.optOutRate).toBeNull();
  });
});

describe('loadWindowStats', () => {
  it('unwraps the single row of a RETURNS TABLE result', async () => {
    const db = fakeClient({
      data: [row({ claims_total: 5, sent: 5, reopened: 2 })],
      error: null,
    });

    const stats = await loadWindowStats(db, 'a1');

    expect(stats?.sent).toBe(5);
    expect(stats?.reopenRate).toBe(0.4);
  });

  it('coerces bigint-as-string counts to numbers', async () => {
    // PostgREST devolve BIGINT como string em alguns caminhos; sem a
    // coerção, `reopened / sent` viraria NaN silenciosamente.
    const db = fakeClient({
      data: [
        {
          claims_total: '4',
          sent: '4',
          failed: '0',
          reopened: '1',
          opted_out_after: '0',
        },
      ],
      error: null,
    });

    const stats = await loadWindowStats(db, 'a1');

    expect(stats?.sent).toBe(4);
    expect(stats?.reopenRate).toBe(0.25);
  });

  it('returns null instead of throwing when the RPC is missing or refuses', async () => {
    // Deploy sem a migração 053, ou chamador que não é membro da conta:
    // os dois significam a mesma coisa para a UI — não há painel. A
    // página de logs é útil por si só e não pode quebrar por isso.
    const db = fakeClient({
      data: null,
      error: { message: 'function does not exist' },
    });

    await expect(loadWindowStats(db, 'a1')).resolves.toBeNull();
  });

  it('returns null on an empty result set', async () => {
    const db = fakeClient({ data: [], error: null });
    await expect(loadWindowStats(db, 'a1')).resolves.toBeNull();
  });
});
