'use client';

// ============================================================
// DealPickerDialog — modal de criação de negócio a partir do Inbox.
//
// Montado UMA vez pelo DealPickerProvider, no nível da página. Toda a
// rede vive em `use-deal-draft`; aqui só há apresentação.
//
// Selects são `<select>` nativo, e não `ui/select.tsx`: todo o módulo
// de pipelines usa o nativo com estas mesmas classes, e introduzir o
// componente estilizado só aqui criaria dois visuais para a mesma
// escolha dentro da mesma feature.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  DollarSign,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CURRENCIES } from '@/lib/currency';
import type { Contact, Deal } from '@/types';
import { useDealDraft } from './use-deal-draft';

/** Mesmas classes do `<select>` de deal-form.tsx — visual único. */
const SELECT_CLASS =
  'border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:ring-1 disabled:opacity-50';

interface DealPickerDialogProps {
  contact: Contact | null;
  onClose: () => void;
  onCreated: (deal: Deal) => void;
}

export function DealPickerDialog({
  contact,
  onClose,
  onCreated,
}: DealPickerDialogProps) {
  const t = useTranslations('Inbox.dealPicker');
  const tForm = useTranslations('Pipelines.form');

  const titleRef = useRef<HTMLInputElement>(null);
  const [showMore, setShowMore] = useState(false);

  const {
    pipelines,
    stages,
    members,
    loadingPipelines,
    loadingStages,
    submitting,
    draft,
    setDraft,
    canSubmit,
    submit,
  } = useDealDraft({ contact, onCreated, onClose });

  // O `initialFocus` do base-ui coloca o foco no título; o texto
  // pré-preenchido ainda precisa ser selecionado, e isso só pode
  // acontecer depois que o popup montou e moveu o foco.
  useEffect(() => {
    if (!contact) return;
    const frame = requestAnimationFrame(() => titleRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [contact]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      setShowMore(false);
      onClose();
    },
    [onClose]
  );

  const contactName = contact?.name || contact?.phone || '';
  const hasPipelines = pipelines.length > 0;
  const noStages =
    !loadingStages && Boolean(draft.pipelineId) && stages.length === 0;

  return (
    <Dialog open={contact !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" initialFocus={titleRef}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="text-primary size-4 shrink-0" />
            <span className="truncate">
              {t('title', { name: contactName })}
            </span>
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loadingPipelines ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : !hasPipelines ? (
          /* Não semeamos o funil padrão daqui: a RLS de `pipelines` é
             admin+, então para o agent — que é quem vive no Inbox — a
             semeadura falharia com 42501 e o beco sem saída
             continuaria, só que com um erro no lugar da explicação. */
          <div className="space-y-3 py-4 text-center">
            <p className="text-muted-foreground text-sm">{t('noPipelines')}</p>
            <Link
              href="/pipelines"
              className="text-primary inline-flex items-center gap-1.5 text-sm hover:underline"
            >
              <ExternalLink className="size-3.5" />
              {t('goToPipelines')}
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="deal-picker-pipeline">{t('pipeline')}</Label>
              <select
                id="deal-picker-pipeline"
                aria-required
                value={draft.pipelineId}
                onChange={(e) => setDraft({ pipelineId: e.target.value })}
                className={SELECT_CLASS}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="deal-picker-stage">{tForm('stage')}</Label>
              <select
                id="deal-picker-stage"
                aria-required
                value={draft.stageId}
                disabled={loadingStages || stages.length === 0}
                onChange={(e) => setDraft({ stageId: e.target.value })}
                className={SELECT_CLASS}
              >
                {stages.length === 0 && (
                  <option value="">{t('selectStage')}</option>
                )}
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {noStages && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  {t('noStages')}
                  <Link
                    href="/pipelines"
                    className="text-primary hover:underline"
                  >
                    {t('goToPipelines')}
                  </Link>
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="deal-picker-title">{tForm('title')}</Label>
              <Input
                id="deal-picker-title"
                ref={titleRef}
                aria-required
                value={draft.title}
                onChange={(e) => setDraft({ title: e.target.value })}
                placeholder={tForm('titlePlaceholder')}
                maxLength={120}
              />
            </div>

            {/* Valor, moeda e responsável ficam recolhidos: quem só quer
                registrar o lead no funil não precisa vê-los, e quem já
                sabe o valor não precisa ir até /pipelines. */}
            <div className="border-border border-t pt-3">
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                aria-expanded={showMore}
                aria-controls="deal-picker-more"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
              >
                {showMore ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {t('moreOptions')}
              </button>

              {showMore && (
                <div id="deal-picker-more" className="mt-3 space-y-3">
                  <div className="grid grid-cols-[1fr_110px] gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="deal-picker-value">
                        {tForm('value')}
                      </Label>
                      <Input
                        id="deal-picker-value"
                        type="number"
                        min="0"
                        value={draft.value}
                        onChange={(e) => setDraft({ value: e.target.value })}
                        placeholder="0"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="deal-picker-currency">
                        {tForm('currency')}
                      </Label>
                      <select
                        id="deal-picker-currency"
                        value={draft.currency}
                        onChange={(e) => setDraft({ currency: e.target.value })}
                        className={SELECT_CLASS}
                      >
                        {CURRENCIES.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.code}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="deal-picker-assigned">
                      {tForm('assignedTo')}
                    </Label>
                    <select
                      id="deal-picker-assigned"
                      value={draft.assignedTo}
                      onChange={(e) => setDraft({ assignedTo: e.target.value })}
                      className={SELECT_CLASS}
                    >
                      <option value="">{tForm('unassigned')}</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.full_name || m.email}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {tForm('cancel')}
          </Button>
          {hasPipelines && (
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {tForm('saving')}
                </>
              ) : (
                tForm('createDeal')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
