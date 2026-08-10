'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  AutomationBuilder,
  type BuilderInitial,
  type BuilderStep,
} from '@/components/automations/automation-builder';
import { localizeTemplate } from '@/lib/automations/template-i18n';
import {
  AUTOMATION_TEMPLATES,
  type TemplateSlug,
} from '@/lib/automations/templates';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

export default function NewAutomationPage() {
  const params = useSearchParams();
  const t = useTranslations('Automations');
  const template = params.get('template') as TemplateSlug | null;

  const initial: BuilderInitial = useMemo(() => {
    if (template && AUTOMATION_TEMPLATES[template]) {
      // O catálogo em código é o fallback; o texto que o autor de fato
      // vê (e que sai para o cliente no WhatsApp) vem do dicionário do
      // locale ativo. Sem isto, escolher um template pronto abre o
      // construtor inteiro em inglês mesmo com a interface em pt-BR.
      const tpl = localizeTemplate(AUTOMATION_TEMPLATES[template], t);
      const steps = expandFromSeeds(
        tpl.steps.map((seed, idx) => ({
          index: idx,
          step_type: seed.step_type,
          step_config: seed.step_config as Record<string, unknown>,
          branch: seed.branch ?? null,
          parent_index: seed.parent_index ?? null,
        }))
      );
      return {
        name: tpl.name,
        description: tpl.description,
        trigger_type: tpl.trigger_type,
        trigger_config: tpl.trigger_config as Record<string, unknown>,
        is_active: false,
        steps,
      };
    }
    return {
      name: '',
      description: '',
      trigger_type: 'new_message_received' as AutomationTriggerType,
      trigger_config: {},
      is_active: false,
      steps: [],
    };
  }, [template, t]);

  return <AutomationBuilder initial={initial} />;
}

interface SeedRow {
  index: number;
  step_type: AutomationStepType;
  step_config: Record<string, unknown>;
  branch: 'yes' | 'no' | null;
  parent_index: number | null;
}

function uid(): string {
  return (
    'c_' +
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  );
}

/** Template seeds are flat with parent_index references. Expand into the
 *  builder's nested tree, preserving order within each scope. */
function expandFromSeeds(rows: SeedRow[]): BuilderStep[] {
  const nodes: BuilderStep[] = rows.map((r) => ({
    cid: uid(),
    step_type: r.step_type,
    step_config: r.step_config,
    branches: r.step_type === 'condition' ? { yes: [], no: [] } : undefined,
  }));
  const roots: BuilderStep[] = [];
  rows.forEach((r, i) => {
    if (r.parent_index == null) {
      roots.push(nodes[i]);
      return;
    }
    const parent = nodes[r.parent_index];
    if (!parent.branches) parent.branches = { yes: [], no: [] };
    parent.branches[r.branch ?? 'yes'].push(nodes[i]);
  });
  return roots;
}
