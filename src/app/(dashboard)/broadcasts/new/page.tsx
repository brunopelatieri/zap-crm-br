'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import {
  Step4ScheduleSend,
  type SendOptions,
} from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { AB_DEFAULT_SPLIT_PERCENT } from '@/lib/broadcasts/ab-test';
import type { AudienceConfig } from '@/lib/audience/estimate';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resumeDraftId = searchParams.get('draftId');
  const t = useTranslations('Broadcasts.new');
  const tAudience = useTranslations('Broadcasts.audience');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } =
    useBroadcastSending();

  // Retoma de um rascunho já triado (SPEC 044 §3.3): a triagem não
  // guarda `template`/`variables` — só navega de volta para cá com
  // `?draftId=`, e é aqui que o template é reidratado a partir do que
  // o stage já persistiu (`template_name`/`template_language`).
  const [resuming, setResuming] = useState(Boolean(resumeDraftId));

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  // ── Teste A/B (SPEC 044 §6.6) ──────────────────────────────────
  // O segundo template tem os PRÓPRIOS placeholders e a própria mídia
  // de header: um mapa de variáveis compartilhado mandaria o valor
  // errado no lugar certo para metade da audiência.
  const [variantTemplate, setVariantTemplate] =
    useState<MessageTemplate | null>(null);
  const [variantVariables, setVariantVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [variantHeaderMediaUrl, setVariantHeaderMediaUrl] = useState('');
  const [splitPercent, setSplitPercent] = useState(AB_DEFAULT_SPLIT_PERCENT);

  useEffect(() => {
    if (!resumeDraftId) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data: draft } = await supabase
        .from('broadcasts')
        .select('id, status, template_name, template_language')
        .eq('id', resumeDraftId)
        .maybeSingle();

      if (cancelled) return;

      if (!draft || draft.status !== 'draft') {
        toast.error(tAudience('triage.draftNotFound'));
        router.replace('/broadcasts/new');
        return;
      }

      const { data: templateRow } = await supabase
        .from('message_templates')
        .select('*')
        .eq('name', draft.template_name)
        .eq('language', draft.template_language)
        .maybeSingle();

      if (cancelled) return;

      if (!templateRow) {
        toast.error(tAudience('triage.draftNotFound'));
        router.replace('/broadcasts/new');
        return;
      }

      setTemplate(templateRow as MessageTemplate);
      setAudience({ type: 'staged', draftId: resumeDraftId });
      setCurrentStep(2);
      setResuming(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDraftId]);

  /**
   * Trocar o template A pode invalidar a variante B: ela precisa ser
   * outro template E da mesma categoria (§6.6 — categorias diferentes
   * excluem opt-out de formas diferentes, ver `planAbTestBroadcast`).
   * Limpar aqui é o que impede o wizard de carregar até o passo 4 uma
   * combinação que o servidor vai recusar.
   */
  function handleTemplateSelect(next: MessageTemplate) {
    setTemplate(next);
    if (
      variantTemplate &&
      (variantTemplate.id === next.id ||
        variantTemplate.category !== next.category)
    ) {
      handleVariantSelect(null);
    }
  }

  function handleVariantSelect(next: MessageTemplate | null) {
    setVariantTemplate(next);
    // O mapeamento pertence ao template: mantê-lo ao trocar de variante
    // reaproveitaria `{{1}}` de um texto em outro que quer outra coisa.
    setVariantVariables({});
    setVariantHeaderMediaUrl('');
  }

  async function handleSend(options: SendOptions) {
    if (!template) return;

    try {
      const result = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
          draftId: audience.draftId,
        },
        variables,
        headerMediaUrl,
        scheduledAt: options.scheduledAt,
        windowOverride: options.windowOverride,
        abTest: variantTemplate
          ? {
              template: variantTemplate,
              variables: variantVariables,
              headerMediaUrl: variantHeaderMediaUrl,
              splitPercent,
            }
          : undefined,
      });

      // Agendado não tem progresso para acompanhar — a tela de detalhe
      // mostraria uma campanha parada, o que parece defeito. A lista, com
      // o status `scheduled` e a data, é a resposta certa.
      if (result.status === 'scheduled') {
        toast.success(
          tAudience('schedule.scheduledToast', {
            when: result.scheduledAt
              ? new Date(result.scheduledAt).toLocaleString()
              : '',
          })
        );
        router.push('/broadcasts');
        return;
      }

      router.push(`/broadcasts/${result.broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      // Persiste a `AudienceConfig` inteira, não só `{type, tagIds}` —
      // é o que fecha a lacuna da §1.5: sem isto, um rascunho salvo com
      // `custom_field`, uma importação ou uma triagem já feita
      // (`draftId`) perdia tudo além do tipo ao ser reaberto.
      audience_filter: audience,
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-primary bg-primary/10 text-primary border-2'
                        : 'border-border bg-muted text-muted-foreground border'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive
                      ? 'text-foreground'
                      : isCompleted
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        {resuming ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div
            className="transition-all duration-300 ease-in-out"
            style={{
              opacity: isProcessing ? 0.6 : 1,
              pointerEvents: isProcessing ? 'none' : 'auto',
            }}
          >
            {currentStep === 0 && (
              <Step1ChooseTemplate
                selectedTemplate={template}
                onSelect={handleTemplateSelect}
                variantTemplate={variantTemplate}
                onVariantSelect={handleVariantSelect}
                splitPercent={splitPercent}
                onSplitPercentChange={setSplitPercent}
                onNext={() => setCurrentStep(1)}
                onBack={() => router.push('/broadcasts')}
              />
            )}
            {currentStep === 1 && template && (
              <Step2SelectAudience
                template={template}
                audience={audience}
                onUpdate={setAudience}
                onBack={() => setCurrentStep(0)}
              />
            )}
            {currentStep === 2 && template && (
              <Step3Personalize
                template={template}
                variables={variables}
                onUpdate={setVariables}
                headerMediaUrl={headerMediaUrl}
                onHeaderMediaUrlChange={setHeaderMediaUrl}
                variantTemplate={variantTemplate}
                variantVariables={variantVariables}
                onVariantUpdate={setVariantVariables}
                variantHeaderMediaUrl={variantHeaderMediaUrl}
                onVariantHeaderMediaUrlChange={setVariantHeaderMediaUrl}
                onNext={() => setCurrentStep(3)}
                onBack={() =>
                  // Uma audiência `staged` não tem "passo 2" para voltar
                  // — a triagem que produziu o rascunho é que faz esse
                  // papel. `setCurrentStep(1)` aqui reabriria um Step2
                  // sem a fonte original (Sheets/Excel/tags/…), então
                  // volta para a triagem em vez de reconstruir um estado
                  // que já não existe no cliente.
                  audience.type === 'staged' && audience.draftId
                    ? router.push(`/broadcasts/new/${audience.draftId}/triage`)
                    : setCurrentStep(1)
                }
              />
            )}
            {currentStep === 3 && template && (
              <Step4ScheduleSend
                name={name}
                onNameChange={setName}
                template={template}
                variantTemplate={variantTemplate}
                splitPercent={splitPercent}
                audience={audience}
                onSend={handleSend}
                onSaveDraft={
                  // Rascunho guarda UM template (`template_name`), então
                  // salvar um teste A/B perderia a variante B em
                  // silêncio. Some o botão em vez de mentir sobre o que
                  // foi salvo — agendar continua disponível e preserva
                  // as duas variantes (§6.6).
                  audience.type === 'staged' || variantTemplate
                    ? undefined
                    : handleSaveDraft
                }
                onBack={() => setCurrentStep(2)}
                isProcessing={isProcessing}
                progress={progress}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
