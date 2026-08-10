import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types';

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'reengagement_before_window_closes';

export interface TemplateStepSeed {
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  branch?: 'yes' | 'no' | null;
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null;
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  steps: TemplateStepSeed[];
}

export const AUTOMATION_TEMPLATES: Record<
  TemplateSlug,
  AutomationTemplateDefinition
> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.',
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?',
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Just circling back — did you have any other questions for us? Happy to help!',
        },
      },
    ],
  },
  // SPEC 045 §5.8 — a versão correta do que `follow_up_reminder` tenta
  // fazer. Aquele ancora a espera na mensagem que disparou o trigger e
  // manda o lembrete `wait 1 day` depois, ou seja, EXATAMENTE no
  // instante em que a janela de 24h fecha: a pior hora possível para
  // tentar reengajar sem template. Este dispara com antecedência
  // configurável, recalculada contra a mensagem mais recente do cliente.
  reengagement_before_window_closes: {
    slug: 'reengagement_before_window_closes',
    name: 'Re-engage Before the 24h Window Closes',
    description:
      'Ask an open question while a free-form reply is still allowed, so the conversation does not fall out of the 24-hour session window.',
    trigger_type: 'session_window_expiring',
    trigger_config: { margin_minutes: 240 },
    steps: [
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          // ⚠️ Este texto é a principal peça PEDAGÓGICA da feature, e
          // por isso não é um "oi, ainda está aí?" (§8.1). Mensagem de
          // sessão NÃO passa por revisão prévia da Meta — não há
          // categoria, não há aprovação, e o erro aparece depois do
          // fato, como reclamação e queda de quality rating. Um texto
          // sem valor real que saísse no template pronto viraria o
          // padrão de fato de toda conta nova, e o quality rating
          // alimenta o TIER de disparo em lote: um reengajamento mal
          // escrito encolhe a capacidade de broadcast da conta inteira.
          //
          // Daí uma pergunta de UTILIDADE (retomar um atendimento em
          // aberto), com uma saída explícita para quem não precisa de
          // nada — que é o que evita a reclamação.
          body: 'Before we wrap up: is there anything still open on your side? Tap an option and we will pick it up right away.',
          footer: 'You can also just reply with your question.',
          buttons: [
            { id: 'reengage_yes', title: 'Yes, I need help' },
            { id: 'reengage_no', title: 'All sorted, thanks' },
          ],
          // Explícito, e não herdado do default: um template é CÓDIGO,
          // não passa pelo `blankConfig()` do builder (§5.3.2), então o
          // default de LEITURA que valeria aqui é 'fail'. Se o tick do
          // cron atrasar e a janela fechar entre a varredura e o envio,
          // pular em silêncio é melhor que um log de falha para algo
          // que o autor não fez de errado.
          on_window_closed: 'skip',
        },
      },
    ],
  },
};

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null;
}
