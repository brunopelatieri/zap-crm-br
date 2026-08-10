'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { slugify } from '@/components/flows/shared';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  type InteractiveButtonsPayload,
  type InteractiveListPayload,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { InteractivePreview } from './interactive-preview';

// ------------------------------------------------------------
// Blank payload factories — used to seed a fresh builder and to
// switch kind without losing the shared body/header/footer.
// ------------------------------------------------------------

/**
 * Generate an id that doesn't collide with any already in use. A plain
 * count-based id (`btn_${length+1}`) regenerates an existing id after a
 * middle item is removed, which then trips the duplicate-id validator and
 * silently blocks sending. Increment past any taken id instead.
 */
function nextId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = existing.length + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function blankButtonsPayload(): InteractiveButtonsPayload {
  return {
    kind: 'buttons',
    body: '',
    buttons: [{ id: 'btn_1', title: '' }],
  };
}

export function blankListPayload(): InteractiveListPayload {
  return {
    kind: 'list',
    body: '',
    button_label: 'Menu',
    sections: [{ title: '', rows: [{ id: 'row_1', title: '' }] }],
  };
}

interface InteractiveBuilderProps {
  value: InteractiveMessagePayload;
  onChange: (payload: InteractiveMessagePayload) => void;
  /** Show the live WhatsApp-style preview beside the form. Default true. */
  showPreview?: boolean;
}

/**
 * Controlled builder for a WhatsApp interactive message (reply buttons
 * or list). Enforces Meta's char limits inline (maxLength + counters)
 * and surfaces a single validation error via `validateInteractivePayload`
 * — the same check the server runs before sending. Shared by the inbox
 * composer, the automation Send node, and the quick-replies manager.
 */
export function InteractiveBuilder({
  value,
  onChange,
  showPreview = true,
}: InteractiveBuilderProps) {
  const t = useTranslations('Interactive.builder');
  const [advanced, setAdvanced] = useState(false);
  const validation = validateInteractivePayload(value);

  const setField = (patch: Partial<InteractiveMessagePayload>) =>
    onChange({ ...value, ...patch } as InteractiveMessagePayload);

  const switchKind = (kind: 'buttons' | 'list') => {
    if (kind === value.kind) return;
    const shared = {
      body: value.body,
      header: value.header,
      footer: value.footer,
    };
    onChange(
      kind === 'buttons'
        ? { ...blankButtonsPayload(), ...shared }
        : { ...blankListPayload(), ...shared }
    );
  };

  return (
    // ⚠️ Container queries (`@container` + `@xl:`), NÃO breakpoints de
    // viewport. Este builder é montado em larguras muito diferentes: os
    // diálogos do composer do inbox e das respostas rápidas (~640px de
    // conteúdo: `sm:max-w-2xl` menos o `p-4` do DialogContent) e o card
    // de 320px do passo `send_buttons`/`send_list` no construtor de
    // automações (~288px depois do `px-4`).
    //
    // Com `md:flex-row` a decisão saía do tamanho da JANELA: num
    // desktop, o card de 320px também virava duas colunas — a
    // pré-visualização de 280px (`shrink-0`) comia a largura inteira e a
    // coluna do formulário colapsava para perto de zero, renderizando o
    // textarea com uma letra por linha.
    //
    // O limiar é `@xl` (576px) e não `@2xl` (672px) porque 672px cairia
    // ACIMA dos 640px dos diálogos e os faria empilhar — trocaria um
    // layout quebrado por outro. 576px separa exatamente os dois casos.
    <div className="@container flex flex-col gap-4 @xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* Kind toggle */}
        <div className="flex gap-2">
          <KindButton
            active={value.kind === 'buttons'}
            label={t('kindButtons')}
            onClick={() => switchKind('buttons')}
          />
          <KindButton
            active={value.kind === 'list'}
            label={t('kindList')}
            onClick={() => switchKind('list')}
          />
        </div>

        <Field
          label={t('body')}
          counter={`${value.body.length}/${INTERACTIVE_LIMITS.bodyMaxLength}`}
        >
          <Textarea
            value={value.body}
            maxLength={INTERACTIVE_LIMITS.bodyMaxLength}
            onChange={(e) => setField({ body: e.target.value })}
            placeholder={t('bodyPlaceholder')}
            className="bg-muted text-foreground min-h-20"
          />
        </Field>

        {/* Cabeçalho e rodapé lado a lado só quando cabem: em ~290px de
            container, duas colunas dão ~140px cada e os rótulos
            ("Cabeçalho (opcional)") sobrepõem o contador. */}
        <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
          <Field
            label={t('header')}
            counter={`${(value.header ?? '').length}/${INTERACTIVE_LIMITS.headerTextMaxLength}`}
          >
            <Input
              value={value.header ?? ''}
              maxLength={INTERACTIVE_LIMITS.headerTextMaxLength}
              onChange={(e) => setField({ header: e.target.value })}
              className="bg-muted text-foreground"
            />
          </Field>
          <Field
            label={t('footer')}
            counter={`${(value.footer ?? '').length}/${INTERACTIVE_LIMITS.footerMaxLength}`}
          >
            <Input
              value={value.footer ?? ''}
              maxLength={INTERACTIVE_LIMITS.footerMaxLength}
              onChange={(e) => setField({ footer: e.target.value })}
              className="bg-muted text-foreground"
            />
          </Field>
        </div>

        {value.kind === 'buttons' ? (
          <ButtonsEditor
            value={value}
            onChange={onChange}
            advanced={advanced}
          />
        ) : (
          <ListEditor value={value} onChange={onChange} advanced={advanced} />
        )}

        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvanced(e.target.checked)}
            className="accent-primary h-3.5 w-3.5"
          />
          {t('showIds')}
        </label>

        {!validation.ok && (
          <p className="text-xs text-red-400">{validation.error}</p>
        )}
      </div>

      {showPreview && (
        <div className="flex shrink-0 flex-col gap-1.5 @xl:w-[280px]">
          <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {t('preview')}
          </span>
          <div className="bg-muted/40 rounded-lg p-3">
            <InteractivePreview payload={value} />
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Buttons editor
// ------------------------------------------------------------

function ButtonsEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveButtonsPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
}) {
  const t = useTranslations('Interactive.builder');
  const buttons = value.buttons;
  const update = (
    idx: number,
    patch: Partial<InteractiveButtonsPayload['buttons'][number]>
  ) =>
    onChange({
      ...value,
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  const add = () =>
    onChange({
      ...value,
      buttons: [
        ...buttons,
        {
          id: nextId(
            buttons.map((b) => b.id),
            'btn_'
          ),
          title: '',
        },
      ],
    });
  const remove = (idx: number) =>
    onChange({ ...value, buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <div>
      <label className="text-muted-foreground mb-2 block text-xs">
        {t('buttonsCount', {
          count: buttons.length,
          max: INTERACTIVE_LIMITS.maxButtons,
        })}
      </label>
      <div className="flex flex-col gap-2">
        {buttons.map((b, i) => (
          <div
            key={i}
            className="border-border bg-muted/40 rounded-md border p-2"
          >
            {/* O campo de id ocupa a linha inteira em container estreito:
                empilhado com o título ele deixaria ~70px para cada um. */}
            {advanced && (
              <Input
                value={b.id}
                onChange={(e) =>
                  update(i, { id: slugify(e.target.value, `btn_${i + 1}`) })
                }
                placeholder="id"
                className="bg-muted mb-2 w-full font-mono text-xs @sm:mb-0 @sm:inline-flex @sm:w-28"
              />
            )}
            <div className="flex items-center gap-2">
              <Input
                value={b.title}
                maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
                onChange={(e) => update(i, { title: e.target.value })}
                placeholder={t('buttonLabelPlaceholder')}
                className="bg-muted min-w-0 flex-1"
              />
              <span className="text-muted-foreground w-10 shrink-0 text-right text-[10px]">
                {b.title.length}/{INTERACTIVE_LIMITS.buttonTitleMaxLength}
              </span>
              {buttons.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(i)}
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {buttons.length < INTERACTIVE_LIMITS.maxButtons && (
        <Button variant="ghost" size="sm" onClick={add} className="mt-2">
          <Plus className="h-3.5 w-3.5" />
          {t('addButton')}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// List editor
// ------------------------------------------------------------

function ListEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveListPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
}) {
  const t = useTranslations('Interactive.builder');
  const sections = value.sections;
  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  const allRowIds = () => sections.flatMap((s) => s.rows.map((r) => r.id));

  const updateSection = (
    sIdx: number,
    patch: Partial<InteractiveListPayload['sections'][number]>
  ) =>
    onChange({
      ...value,
      sections: sections.map((s, i) => (i === sIdx ? { ...s, ...patch } : s)),
    });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<InteractiveListPayload['sections'][number]['rows'][number]>
  ) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s
      ),
    });
  const addRow = (sIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [...s.rows, { id: nextId(allRowIds(), 'row_'), title: '' }],
            }
          : s
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s
      ),
    });
  const addSection = () =>
    onChange({
      ...value,
      sections: [
        ...sections,
        { title: '', rows: [{ id: nextId(allRowIds(), 'row_'), title: '' }] },
      ],
    });
  const removeSection = (sIdx: number) =>
    onChange({ ...value, sections: sections.filter((_, i) => i !== sIdx) });

  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('listButtonLabel')}
        counter={`${value.button_label.length}/${INTERACTIVE_LIMITS.buttonTitleMaxLength}`}
      >
        <Input
          value={value.button_label}
          maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
          onChange={(e) => onChange({ ...value, button_label: e.target.value })}
          className="bg-muted text-foreground"
        />
      </Field>

      <label className="text-muted-foreground block text-xs">
        {t('rowsCount', {
          count: totalRows,
          max: INTERACTIVE_LIMITS.maxListRowsTotal,
        })}
      </label>

      {sections.map((section, sIdx) => (
        <div
          key={sIdx}
          className="border-border bg-muted/40 rounded-md border p-2"
        >
          <div className="mb-2 flex items-center gap-2">
            <Input
              value={section.title ?? ''}
              onChange={(e) => updateSection(sIdx, { title: e.target.value })}
              placeholder={t('sectionTitlePlaceholder')}
              className="bg-muted min-w-0 flex-1 text-xs"
            />
            {sections.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeSection(sIdx)}
                className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className="border-border bg-card rounded border p-2"
              >
                {advanced && (
                  <Input
                    value={row.id}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, {
                        id: slugify(e.target.value, `row_${rIdx + 1}`),
                      })
                    }
                    placeholder="id"
                    className="bg-muted mb-2 w-full font-mono text-xs @sm:w-24"
                  />
                )}
                <div className="flex items-center gap-2">
                  <Input
                    value={row.title}
                    maxLength={INTERACTIVE_LIMITS.listRowTitleMaxLength}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, { title: e.target.value })
                    }
                    placeholder={t('rowTitlePlaceholder')}
                    className="bg-muted min-w-0 flex-1"
                  />
                  <span className="text-muted-foreground w-10 shrink-0 text-right text-[10px]">
                    {row.title.length}/
                    {INTERACTIVE_LIMITS.listRowTitleMaxLength}
                  </span>
                  {totalRows > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(sIdx, rIdx)}
                      className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Input
                  value={row.description ?? ''}
                  maxLength={INTERACTIVE_LIMITS.listRowDescriptionMaxLength}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { description: e.target.value })
                  }
                  placeholder={t('rowDescriptionPlaceholder')}
                  className="bg-muted mt-2 text-xs"
                />
              </div>
            ))}
          </div>
          {totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addRow(sIdx)}
              className="mt-2"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('addRow')}
            </Button>
          )}
        </div>
      ))}

      {sections.length < INTERACTIVE_LIMITS.maxListSections &&
        totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
          <Button variant="ghost" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            {t('addSection')}
          </Button>
        )}
    </div>
  );
}

// ------------------------------------------------------------
// Small presentational helpers
// ------------------------------------------------------------

function KindButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}

function Field({
  label,
  counter,
  children,
}: {
  label: string;
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      {/* `min-w-0` + `shrink-0` no contador: sem os dois, um rótulo longo
          ("Cabeçalho (opcional)") num container estreito empurra o
          contador para fora da caixa e os dois se sobrepõem. */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-muted-foreground min-w-0 text-xs">{label}</label>
        {counter && (
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {counter}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
