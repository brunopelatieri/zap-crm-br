/**
 * Localização dos templates de automação prontos.
 *
 * Por que o conteúdo semeado não pode ficar só em `templates.ts`
 *
 *   O texto dos seeds não é rótulo de interface: é a MENSAGEM que sai
 *   para o cliente final no WhatsApp. Num CRM localizado para o Brasil,
 *   um template pronto que abre escrito em inglês é inutilizável sem
 *   reescrever tudo à mão — e reescrever à mão é exatamente o trabalho
 *   que um template pronto existe para poupar.
 *
 *   Cravar português direto no catálogo resolveria para o Brasil e
 *   quebraria o outro lado: o projeto mantém `en` para times
 *   internacionais, e eles passariam a receber seeds em português. Daí
 *   o dicionário ser a fonte da verdade do texto, com o catálogo em
 *   código servindo de fallback — que é o mesmo arranjo que os cards da
 *   lista de automações já usam para nome e descrição.
 *
 * O que é traduzido, e o que não é
 *
 *   Só campos de TEXTO visível: corpo de mensagem, rodapé, títulos de
 *   botão, e as palavras-chave do gatilho do `lead_qualifier` (que o
 *   cliente digita — "pricing" nunca vai casar com uma conversa em
 *   português). Ids de botão, tipos de passo e configuração estrutural
 *   continuam em código: mudá-los por locale quebraria o
 *   `interactive_reply` que casa por id.
 *
 * ⚠️ Limites da Meta valem para o texto traduzido
 *
 *   Título de botão é ≤ 20 caracteres e rodapé ≤ 60 — em QUALQUER
 *   idioma. Uma tradução mais longa que o original só falharia no envio,
 *   como um 400 da Meta no meio da conversa. `template-i18n.test.ts`
 *   valida os dois dicionários contra `validateInteractivePayload`
 *   justamente para esse erro morrer no CI, não em produção.
 */

import type { AutomationStepType } from '@/types';
import {
  type AutomationTemplateDefinition,
  type TemplateSlug,
  type TemplateStepSeed,
} from './templates';

/**
 * Tradutor com teste de existência. É o formato que o `useTranslations`
 * do next-intl já entrega (`t` + `t.has`); recebido como interface para
 * este módulo continuar puro e testável sem montar um provider.
 *
 * As chaves são relativas ao namespace `Automations`.
 */
export interface SeedTranslator {
  has: (key: string) => boolean;
  (key: string): string;
}

/** Texto do dicionário, ou o valor semeado em código quando não houver. */
function pick(tr: SeedTranslator, key: string, fallback: unknown): string {
  return tr.has(key) ? tr(key) : String(fallback ?? '');
}

/**
 * Aplica um patch ao PRIMEIRO passo do tipo indicado.
 *
 * Por posição seria mais curto e mais frágil: o `follow_up_reminder`
 * começa com um `wait`, e o `out_of_office` tem o `send_message` dentro
 * de um branch. Buscar por tipo sobrevive a essas duas formas — e a
 * qualquer reordenação futura dos seeds.
 */
function patchFirst(
  steps: TemplateStepSeed[],
  stepType: AutomationStepType,
  patch: (cfg: Record<string, unknown>) => Record<string, unknown>
): TemplateStepSeed[] {
  let done = false;
  return steps.map((step) => {
    if (done || step.step_type !== stepType) return step;
    done = true;
    return {
      ...step,
      step_config: patch(step.step_config as Record<string, unknown>),
    };
  });
}

/**
 * Devolve uma cópia do template com nome, descrição e conteúdo dos
 * passos vindos do dicionário do locale ativo.
 *
 * Nunca lança e nunca devolve chave crua: todo campo cai no valor
 * semeado em código quando a tradução falta — o que mantém um template
 * novo utilizável antes de alguém traduzi-lo.
 */
export function localizeTemplate(
  tpl: AutomationTemplateDefinition,
  tr: SeedTranslator
): AutomationTemplateDefinition {
  const slug = tpl.slug;
  const seed = (field: string) => `templateSeeds.${slug}.${field}`;

  let steps = tpl.steps;
  let triggerConfig = tpl.trigger_config;

  switch (slug) {
    case 'welcome_message':
      steps = patchFirst(steps, 'send_message', (c) => ({
        ...c,
        text: pick(tr, seed('greeting'), c.text),
      }));
      break;

    case 'out_of_office':
      steps = patchFirst(steps, 'send_message', (c) => ({
        ...c,
        text: pick(tr, seed('reply'), c.text),
      }));
      break;

    case 'lead_qualifier': {
      steps = patchFirst(steps, 'send_message', (c) => ({
        ...c,
        text: pick(tr, seed('question'), c.text),
      }));
      // As palavras-chave são o que o CLIENTE digita: "pricing" não casa
      // com uma conversa em português. Guardadas como uma string
      // separada por vírgula (o mesmo formato que o campo do construtor
      // exibe) e quebradas aqui.
      const keywordsKey = seed('keywords');
      if (tr.has(keywordsKey)) {
        const keywords = tr(keywordsKey)
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
        if (keywords.length > 0) {
          triggerConfig = { ...triggerConfig, keywords };
        }
      }
      break;
    }

    case 'follow_up_reminder':
      steps = patchFirst(steps, 'send_message', (c) => ({
        ...c,
        text: pick(tr, seed('nudge'), c.text),
      }));
      break;

    case 'reengagement_before_window_closes':
      steps = patchFirst(steps, 'send_buttons', (c) => {
        const buttons = (c.buttons as { id: string; title: string }[]) ?? [];
        return {
          ...c,
          body: pick(tr, seed('body'), c.body),
          footer: pick(tr, seed('footer'), c.footer),
          // Traduz o TÍTULO e preserva o `id`: é o id que o
          // `interactive_reply` casa quando o cliente toca, então
          // traduzi-lo quebraria qualquer automação encadeada.
          buttons: buttons.map((b) => ({
            ...b,
            title: pick(tr, seed(`button.${b.id}`), b.title),
          })),
        };
      });
      break;
  }

  return {
    ...tpl,
    name: pick(tr, `list.templateCards.${slug}.name`, tpl.name),
    description: pick(
      tr,
      `list.templateCards.${slug}.description`,
      tpl.description
    ),
    trigger_config: triggerConfig,
    steps,
  };
}

/** Todos os slugs, para o teste de cobertura dos dicionários. */
export const LOCALIZABLE_SLUGS: TemplateSlug[] = [
  'welcome_message',
  'out_of_office',
  'lead_qualifier',
  'follow_up_reminder',
  'reengagement_before_window_closes',
];
