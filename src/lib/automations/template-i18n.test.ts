import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { LOCALIZABLE_SLUGS, localizeTemplate } from './template-i18n';
import { AUTOMATION_TEMPLATES } from './templates';
import type { SeedTranslator } from './template-i18n';

/**
 * Tradutor sobre um dicionário real, com a mesma superfície que o
 * `useTranslations('Automations')` do next-intl entrega: chamável, com
 * `.has()`. Sem provider, sem React — o módulo é puro de propósito.
 */
function translatorFor(dict: Record<string, unknown>): SeedTranslator {
  const lookup = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined,
        dict.Automations
      );

  const tr = ((key: string) => {
    const v = lookup(key);
    if (typeof v !== 'string') throw new Error(`missing key: ${key}`);
    return v;
  }) as SeedTranslator;
  tr.has = (key: string) => typeof lookup(key) === 'string';
  return tr;
}

const LOCALES = {
  en: translatorFor(en as unknown as Record<string, unknown>),
  'pt-BR': translatorFor(ptBR as unknown as Record<string, unknown>),
};

describe.each(Object.entries(LOCALES))('seed localization — %s', (_, tr) => {
  it.each(LOCALIZABLE_SLUGS)(
    'translates every visible text field of %s',
    (slug) => {
      const localized = localizeTemplate(AUTOMATION_TEMPLATES[slug], tr);

      expect(localized.name.trim()).not.toBe('');
      expect(localized.description.trim()).not.toBe('');

      for (const step of localized.steps) {
        const cfg = step.step_config as Record<string, unknown>;
        // Nenhum campo de texto pode sair vazio ou como chave crua — os
        // dois são o sintoma de uma chave faltando no dicionário.
        for (const field of ['text', 'body', 'footer'] as const) {
          if (typeof cfg[field] === 'string') {
            expect(cfg[field]).not.toBe('');
            expect(cfg[field]).not.toMatch(/^templateSeeds\./);
          }
        }
      }
    }
  );

  it('keeps the reengagement payload inside Meta limits after translation', () => {
    // ⚠️ O teste que justifica este arquivo. Título de botão é ≤ 20
    // caracteres em QUALQUER idioma; uma tradução mais longa que o
    // original passaria despercebida até virar um 400 da Meta no meio
    // de uma conversa real.
    const localized = localizeTemplate(
      AUTOMATION_TEMPLATES.reengagement_before_window_closes,
      tr
    );
    const cfg = localized.steps[0].step_config as Record<string, unknown>;

    expect(validateInteractivePayload(cfg)).toEqual({ ok: true });
  });

  it('preserves button ids while translating their titles', () => {
    // O `interactive_reply` casa pelo ID. Traduzi-lo quebraria qualquer
    // automação encadeada no toque do botão.
    const localized = localizeTemplate(
      AUTOMATION_TEMPLATES.reengagement_before_window_closes,
      tr
    );
    const cfg = localized.steps[0].step_config as Record<string, unknown>;
    const ids = (cfg.buttons as { id: string }[]).map((b) => b.id);

    expect(ids).toEqual(['reengage_yes', 'reengage_no']);
  });

  it('translates lead_qualifier trigger keywords into a non-empty array', () => {
    // "pricing" nunca vai casar com uma conversa em português — as
    // palavras-chave são o que o CLIENTE digita.
    const localized = localizeTemplate(AUTOMATION_TEMPLATES.lead_qualifier, tr);
    const keywords = (localized.trigger_config as { keywords?: string[] })
      .keywords;

    expect(Array.isArray(keywords)).toBe(true);
    expect(keywords!.length).toBeGreaterThan(0);
    expect(keywords!.every((k) => k.trim().length > 0)).toBe(true);
  });
});

describe('localizeTemplate fallbacks', () => {
  /** Dicionário vazio: nenhuma chave existe. */
  const empty = (() => {
    const tr = ((key: string) => {
      throw new Error(`should not be called: ${key}`);
    }) as unknown as SeedTranslator;
    tr.has = () => false;
    return tr;
  })();

  it('falls back to the seeded catalogue when no translation exists', () => {
    // Um template novo precisa continuar utilizável antes de alguém
    // traduzi-lo — nunca aparecer como chave crua.
    const source = AUTOMATION_TEMPLATES.reengagement_before_window_closes;
    const localized = localizeTemplate(source, empty);

    expect(localized.name).toBe(source.name);
    expect(localized.description).toBe(source.description);
    expect(localized.steps[0].step_config).toEqual(source.steps[0].step_config);
  });

  it('does not mutate the shared catalogue', () => {
    // AUTOMATION_TEMPLATES é um singleton de módulo: mutá-lo faria o
    // primeiro locale renderizado vazar para todos os seguintes.
    const before = JSON.stringify(AUTOMATION_TEMPLATES.lead_qualifier);
    localizeTemplate(AUTOMATION_TEMPLATES.lead_qualifier, LOCALES['pt-BR']);
    expect(JSON.stringify(AUTOMATION_TEMPLATES.lead_qualifier)).toBe(before);
  });
});
