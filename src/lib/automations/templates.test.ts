import { describe, expect, it } from 'vitest';

import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { AUTOMATION_TEMPLATES, getTemplate } from './templates';
import { validateStepsForActivation } from './validate';
import { isValidMarginMinutes } from './window-trigger';

describe('reengagement_before_window_closes template (SPEC 045 §5.8)', () => {
  const tpl = AUTOMATION_TEMPLATES.reengagement_before_window_closes;
  const step = tpl.steps[0];
  const cfg = step.step_config as Record<string, unknown>;

  it('is wired to the session-window trigger with a valid margin', () => {
    expect(tpl.trigger_type).toBe('session_window_expiring');
    expect(
      isValidMarginMinutes(
        (tpl.trigger_config as { margin_minutes: number }).margin_minutes
      )
    ).toBe(true);
  });

  it('sets on_window_closed EXPLICITLY — a template is code, not builder output', () => {
    // O `blankConfig()` do builder grava 'skip' para steps novos, mas um
    // template não passa por ele: o default de LEITURA que valeria aqui
    // é 'fail' (§5.3.2). Sem esta linha, um tick de cron atrasado
    // produziria um log de falha para algo que o autor não fez de
    // errado.
    expect(cfg.on_window_closed).toBe('skip');
  });

  it('carries an interactive payload Meta will accept', () => {
    // Pega, entre outras coisas, título de botão acima do limite de 20
    // caracteres — que só apareceria como um 400 da Meta em produção.
    expect(validateInteractivePayload(cfg)).toEqual({ ok: true });
  });

  it('can be activated as seeded, with no manual fix-up', () => {
    // Diferente de `welcome_message` (que semeia `add_tag` com
    // `tag_id: ''` de propósito, para o autor escolher a etiqueta),
    // este template precisa funcionar sem edição: ele é a peça
    // pedagógica da feature, e um template pronto que não ativa ensina
    // a coisa errada.
    expect(
      validateStepsForActivation([
        {
          step_type: step.step_type,
          step_config: cfg,
        },
      ])
    ).toEqual([]);
  });

  it('asks something of real utility, not "are you still there?"', () => {
    // §8.1: mensagem de sessão NÃO passa por revisão prévia da Meta, e
    // o erro aparece depois do fato — como queda de quality rating, que
    // alimenta o TIER de disparo em lote. Um texto vazio saindo no
    // template pronto viraria o padrão de fato de toda conta nova.
    //
    // Esta asserção é grosseira de propósito: ela não julga a redação,
    // só trava as fórmulas vazias mais comuns e exige uma saída para
    // quem não precisa de nada.
    const body = String(cfg.body).toLowerCase();
    expect(body).not.toMatch(/still there|ainda (a[íi]|est[áa])/);
    expect(body.length).toBeGreaterThan(40);

    const buttons = cfg.buttons as { title: string }[];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('is reachable through getTemplate by slug', () => {
    expect(getTemplate('reengagement_before_window_closes')?.slug).toBe(
      'reengagement_before_window_closes'
    );
  });
});

describe('template registry', () => {
  it('keeps every slug consistent with its key', () => {
    for (const [key, def] of Object.entries(AUTOMATION_TEMPLATES)) {
      expect(def.slug).toBe(key);
    }
  });
});
