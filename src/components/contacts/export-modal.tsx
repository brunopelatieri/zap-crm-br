'use client';

/**
 * Modal de exportação de contatos (SPEC 051 §7). Espelha
 * `import-modal.tsx` na estrutura (Dialog, header fixo/corpo
 * scrollável/footer fixo, `reset()` no fechamento, toasts sonner) —
 * mas o "resultado" aqui é o download em si, não um painel dentro do
 * modal: em caso de sucesso o modal fecha sozinho depois do clique.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  CONTACT_EXPORT_FIELDS,
  DEFAULT_CONTACT_EXPORT_FIELDS,
  type ContactExportFieldId,
} from '@/lib/contacts/export-fields';
import type { ContactExportScope } from '@/lib/contacts/export-fetch';

interface CustomFieldDef {
  id: string;
  field_name: string;
}

export interface ExportModalScopeFilter {
  search: string;
  tagIds: string[];
  channelIds: string[];
}

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Filtro ativo na tela — vira `scope: {mode:'filter', ...}` quando
   *  o usuário escolhe "todos os contatos do filtro". */
  scopeFilter: ExportModalScopeFilter;
  /** Total de contatos que o filtro atual casa (não só a página). */
  filteredCount: number;
  /** Ids marcados na tela — pré-seleciona o escopo "selecionados". */
  selectedIds: string[];
}

/** Colunas que um campo fixo contribui — usado só para a prévia
 *  (a contagem real de `tags`/`channels`/`custom_fields` depende dos
 *  dados e só a rota sabe ao certo). */
function fieldColumnCount(
  id: ContactExportFieldId,
  customFieldCount: number
): number {
  switch (id) {
    case 'custom_fields':
      return customFieldCount;
    case 'whatsapp_status':
      return 2;
    case 'consent':
      return 2;
    case 'last_interaction':
      return 2;
    default:
      return 1;
  }
}

export function ExportModal({
  open,
  onOpenChange,
  scopeFilter,
  filteredCount,
  selectedIds,
}: ExportModalProps) {
  const t = useTranslations('Contacts.exportModal');
  const tFields = useTranslations('Contacts.exportFields');
  const supabase = createClient();

  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [scopeMode, setScopeMode] = useState<'filter' | 'selection'>(
    selectedIds.length > 0 ? 'selection' : 'filter'
  );
  const [fields, setFields] = useState<Set<ContactExportFieldId>>(
    new Set(DEFAULT_CONTACT_EXPORT_FIELDS)
  );
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([]);
  const [customFieldIds, setCustomFieldIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // Reabrir com uma seleção nova recalcula o escopo padrão — "quem
  // marcou, quer só o que marcou" (§6.2).
  useEffect(() => {
    if (!open) return;
    setScopeMode(selectedIds.length > 0 ? 'selection' : 'filter');
  }, [open, selectedIds.length]);

  useEffect(() => {
    if (!open) return;
    supabase
      .from('custom_fields')
      .select('id, field_name')
      .order('field_name', { ascending: true })
      .then(({ data }) => {
        const defs = (data ?? []) as CustomFieldDef[];
        setCustomFieldDefs(defs);
        setCustomFieldIds(new Set(defs.map((d) => d.id)));
      });
  }, [open, supabase]);

  function reset() {
    setFormat('xlsx');
    setFields(new Set(DEFAULT_CONTACT_EXPORT_FIELDS));
    setCustomFieldIds(new Set(customFieldDefs.map((d) => d.id)));
    setExporting(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function toggleField(id: ContactExportFieldId) {
    if (id === 'phone') return; // travado — identidade do contato
    setFields((prev) => {
      const next = new Set(prev);
      const turningOn = !next.has(id);
      if (turningOn) next.add(id);
      else next.delete(id);

      if (id === 'custom_fields') {
        setCustomFieldIds(
          turningOn ? new Set(customFieldDefs.map((d) => d.id)) : new Set()
        );
      }
      return next;
    });
  }

  function toggleCustomField(id: string) {
    setCustomFieldIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFields() {
    setFields(new Set(CONTACT_EXPORT_FIELDS.map((f) => f.id)));
    setCustomFieldIds(new Set(customFieldDefs.map((d) => d.id)));
  }

  function clearFields() {
    setFields(new Set<ContactExportFieldId>(['phone']));
    setCustomFieldIds(new Set());
  }

  const rowCount =
    scopeMode === 'selection' ? selectedIds.length : filteredCount;
  const columnCount = [...fields].reduce(
    (sum, id) => sum + fieldColumnCount(id, customFieldIds.size),
    0
  );
  const customFieldsChecked = fields.has('custom_fields');
  const customFieldsIndeterminate =
    customFieldsChecked &&
    customFieldDefs.length > 0 &&
    customFieldIds.size > 0 &&
    customFieldIds.size < customFieldDefs.length;

  async function handleExport() {
    if (rowCount === 0) {
      toast.info(t('toastEmpty'));
      return;
    }

    setExporting(true);
    try {
      const scope: ContactExportScope =
        scopeMode === 'selection'
          ? { mode: 'selection', ids: selectedIds }
          : {
              mode: 'filter',
              search: scopeFilter.search,
              tagIds: scopeFilter.tagIds,
              channelIds: scopeFilter.channelIds,
            };

      const res = await fetch('/api/contacts/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          fields: [...fields],
          customFieldIds: customFieldsChecked ? [...customFieldIds] : undefined,
          scope,
        }),
      });

      if (!res.ok) {
        if (res.status === 413) {
          const data = (await res.json().catch(() => null)) as {
            total?: number;
          } | null;
          toast.error(t('toastTooLarge', { count: data?.total ?? rowCount }));
        } else {
          toast.error(t('toastFailed'));
        }
        return;
      }

      const rowCountHeader = res.headers.get('X-Export-Row-Count');
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = filenameMatch?.[1] ?? `contacts.${format}`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      // O anchor precisa estar no documento para o `click()` disparar o
      // download no Firefox — não basta criar o elemento solto.
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Revogar na próxima tarefa: revogar em seguida ao clique cancela
      // o download que o navegador ainda não começou a ler.
      setTimeout(() => URL.revokeObjectURL(url), 0);

      const count = rowCountHeader ? Number(rowCountHeader) : rowCount;
      toast.success(t('toastDone', { count }));
      handleOpenChange(false);
    } catch {
      toast.error(t('toastFailed'));
    } finally {
      setExporting(false);
    }
  }

  const groups = [
    { key: 'basic' as const, label: t('groupBasic') },
    { key: 'extra' as const, label: t('groupExtra') },
    { key: 'advanced' as const, label: t('groupAdvanced') },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="border-border/80 shrink-0 space-y-4 border-b px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-popover-foreground text-lg">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground leading-relaxed">
              {t('desc')}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {/* Formato */}
          <div className="space-y-2">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
              {t('formatLabel')}
            </p>
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as 'xlsx' | 'csv')}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem value="xlsx" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="text-popover-foreground flex items-center gap-1.5 text-sm font-medium">
                    <FileSpreadsheet className="text-primary size-3.5" />
                    {t('formatXlsx')}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {t('formatXlsxHint')}
                  </span>
                </span>
              </label>
              <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem value="csv" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="text-popover-foreground flex items-center gap-1.5 text-sm font-medium">
                    <FileText className="text-primary size-3.5" />
                    {t('formatCsv')}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {t('formatCsvHint')}
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          {/* Escopo */}
          <div className="space-y-2">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
              {t('scopeLabel')}
            </p>
            {selectedIds.length > 0 ? (
              <RadioGroup
                value={scopeMode}
                onValueChange={(value) =>
                  setScopeMode(value as 'filter' | 'selection')
                }
                className="gap-1.5"
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem value="filter" />
                  <span className="text-popover-foreground">
                    {t('scopeFiltered', { count: filteredCount })}
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem value="selection" />
                  <span className="text-popover-foreground">
                    {t('scopeSelected', { count: selectedIds.length })}
                  </span>
                </label>
              </RadioGroup>
            ) : (
              <p className="text-popover-foreground text-sm">
                {t('scopeFiltered', { count: filteredCount })}
              </p>
            )}
          </div>

          {/* Campos */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
                {t('fieldsLabel')}
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={selectAllFields}
                  className="text-primary text-xs font-medium hover:underline"
                >
                  {t('selectAllFields')}
                </button>
                <button
                  type="button"
                  onClick={clearFields}
                  className="text-muted-foreground hover:text-foreground text-xs"
                >
                  {t('clearFields')}
                </button>
              </div>
            </div>

            {groups.map((group) => (
              <div key={group.key} className="space-y-1.5">
                <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                  {group.label}
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {CONTACT_EXPORT_FIELDS.filter(
                    (f) => f.group === group.key
                  ).map((field) => (
                    <label
                      key={field.id}
                      className={`flex items-center gap-2 text-sm ${
                        field.locked
                          ? 'cursor-not-allowed opacity-70'
                          : 'cursor-pointer'
                      }`}
                      title={field.locked ? t('phoneLocked') : undefined}
                    >
                      <Checkbox
                        checked={fields.has(field.id) || !!field.locked}
                        disabled={field.locked}
                        indeterminate={
                          field.id === 'custom_fields'
                            ? customFieldsIndeterminate
                            : undefined
                        }
                        onCheckedChange={() => toggleField(field.id)}
                      />
                      <span className="text-popover-foreground">
                        {tFields(field.id)}
                      </span>
                    </label>
                  ))}
                </div>

                {group.key === 'extra' &&
                  customFieldsChecked &&
                  customFieldDefs.length > 0 && (
                    <div className="border-border/60 ml-6 space-y-1 border-l pl-3">
                      {customFieldDefs.map((def) => (
                        <label
                          key={def.id}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={customFieldIds.has(def.id)}
                            onCheckedChange={() => toggleCustomField(def.id)}
                          />
                          <span className="text-popover-foreground">
                            {def.field_name}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
              </div>
            ))}
          </div>

          <p className="text-muted-foreground text-xs">
            {t('preview', { columns: columnCount, rows: rowCount })}
          </p>
        </div>

        <DialogFooter className="border-border/80 bg-background/50 mt-0 shrink-0 gap-2 border-t px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={exporting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={exporting}
            onClick={handleExport}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {exporting ? t('exporting') : t('exportBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
