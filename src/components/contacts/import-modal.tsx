'use client';

import { useEffect, useMemo, useState } from 'react';
import { Sheet, Upload } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  dedupeByPhone,
  isUniqueViolation,
  normalizeKey,
} from '@/lib/contacts/dedupe';
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Tag,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  ImportSourcePicker,
  type ImportSourceOption,
} from '@/components/import/import-source-picker';
import { SpreadsheetTemplateHint } from '@/components/import/spreadsheet-template-hint';
import { SpreadsheetDropzone } from '@/components/import/spreadsheet-dropzone';
import { ImportRejectSummary } from '@/components/import/import-reject-summary';
import { GoogleSheetsSource } from '@/components/broadcasts/audience/google-sheets-source';
import { useSpreadsheetParser } from '@/hooks/use-spreadsheet-parser';
import type { NormalizedAudienceRow } from '@/lib/audience/types';

const DEFAULT_TAG_COLOR = '#3b82f6';
const PREVIEW_LIMIT = 5;

/** As duas fontes que o importador de contatos oferece (SPEC 052 §5.1). */
type ContactImportSource = 'google_sheets' | 'spreadsheet';

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate',
        maxWidth,
        mono && 'font-mono text-[11px]'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  const t = useTranslations('Contacts.importModal');

  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color =
          tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : t('willBeCreated', { name })}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const tParseError = useTranslations('Broadcasts.audience.parseError');
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [source, setSource] = useState<ContactImportSource>('google_sheets');
  const [file, setFile] = useState<File | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | undefined>();
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsErrorCode, setSheetsErrorCode] = useState<string | null>(null);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(
    new Map()
  );
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    tagsAssigned: number;
  } | null>(null);

  const parser = useSpreadsheetParser();

  const sourceOptions = useMemo<ImportSourceOption<ContactImportSource>[]>(
    () => [
      {
        id: 'google_sheets',
        icon: Sheet,
        label: t('source.googleSheets.label'),
        description: t('source.googleSheets.description'),
        recommended: true,
      },
      {
        id: 'spreadsheet',
        icon: Upload,
        label: t('source.spreadsheet.label'),
        description: t('source.spreadsheet.description'),
      },
    ],
    [t]
  );

  function reset() {
    setSource('google_sheets');
    setFile(null);
    setActiveSheet(undefined);
    setSheetsErrorCode(null);
    setTagColorByKey(new Map());
    setResult(null);
    parser.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleSourceChange(next: ContactImportSource) {
    setSource(next);
    setSheetsErrorCode(null);
    setFile(null);
    setActiveSheet(undefined);
    setResult(null);
    parser.reset();
  }

  function handleFileSelected(selected: File) {
    setFile(selected);
    setActiveSheet(undefined);
    setResult(null);
    parser.parseFile(selected);
  }

  function handleClearFile() {
    setFile(null);
    setActiveSheet(undefined);
    setResult(null);
    parser.reset();
  }

  function handleSheetChange(name: string) {
    if (!file) return;
    setActiveSheet(name);
    parser.parseFile(file, { sheetName: name });
  }

  async function handleSheetsImport(url: string) {
    setSheetsLoading(true);
    setSheetsErrorCode(null);
    setResult(null);
    try {
      const res = await fetch('/api/import/google-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSheetsErrorCode(body.code ?? 'fetch_failed');
        return;
      }

      // O CSV baixado segue o mesmo caminho de um arquivo local — uma
      // única implementação de parsing para as três fontes.
      await parser.parseCsvText(await res.text());
    } catch {
      setSheetsErrorCode('fetch_failed');
    } finally {
      setSheetsLoading(false);
    }
  }

  // Referência estável entre renders (não uma `[]` nova a cada vez) —
  // é dependência de outros `useMemo`/`useEffect` abaixo.
  const rows: NormalizedAudienceRow[] = useMemo(
    () => parser.result?.audience.rows ?? [],
    [parser.result]
  );

  // Cores das etiquetas já existentes na conta — só busca quando a
  // planilha lida realmente carrega alguma etiqueta.
  useEffect(() => {
    if (!accountId || !rows.some((row) => row.tagNames.length > 0)) {
      setTagColorByKey(new Map());
      return;
    }

    let cancelled = false;
    (async () => {
      const client = createClient();
      const { data: tags } = await client
        .from('tags')
        .select('name, color')
        .eq('account_id', accountId);
      if (cancelled) return;
      const colors = new Map<string, string>();
      for (const tag of tags ?? []) {
        const key = tag.name.trim().toLowerCase();
        if (!colors.has(key)) colors.set(key, tag.color);
      }
      setTagColorByKey(colors);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parser.result, accountId]);

  async function handleImport() {
    if (rows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId)
        throw new Error('Your profile is not linked to an account.');

      let imported = 0;
      let skipped = 0;
      let failed = 0;

      // 1) De-dupe within the file by normalized phone (keep first).
      //    A esta altura o normalizador compartilhado (SPEC 052 F2) já
      //    deduplicou dentro do arquivo — isto é uma segunda camada,
      //    barata e inofensiva, não um passo redundante removido.
      const { unique, duplicates: inFileDupes } = dedupeByPhone(rows);
      skipped += inFileDupes;

      // 2) Skip numbers already in this account. One read of the
      //    generated `phone_normalized` column (migration 022) → Set.
      const { data: existingRows } = await supabase
        .from('contacts')
        .select('phone_normalized')
        .eq('account_id', accountId);
      const existing = new Set(
        (existingRows ?? [])
          .map(
            (r) => (r as { phone_normalized: string | null }).phone_normalized
          )
          .filter((p): p is string => !!p)
      );

      const toInsert = unique.filter((row) => {
        if (existing.has(normalizeKey(row.phone))) {
          skipped++;
          return false;
        }
        return true;
      });

      // 3) Resolve tag names → ids (admin+ may auto-create missing tags).
      //    Skip the round-trip when the import carries no tag names.
      const allTagNames = toInsert.flatMap((row) => row.tagNames);
      let tagIdByKey = new Map<string, string>();
      let skippedNames: string[] = [];
      if (allTagNames.length > 0) {
        ({ tagIdByKey, skippedNames } = await resolveImportTagIds(supabase, {
          accountId,
          userId: user.id,
          tagNames: allTagNames,
          canCreateTags: canEditSettings,
        }));
      }

      const tagAssignments: ContactTagAssignment[] = [];

      // 4) Batch insert the genuinely-new rows in chunks of 50. The DB
      //    unique index is the backstop: a 23505 (race, or a format
      //    that normalizes equal) counts as skipped, not failed.
      const chunkSize = 50;

      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize);
        const insertRows = chunk.map((row) => ({
          user_id: user.id,
          account_id: accountId,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .insert(insertRows)
          .select('id');

        if (error) {
          // Retry individually so one bad/duplicate row doesn't sink
          // the whole chunk.
          for (let j = 0; j < insertRows.length; j++) {
            const insertRow = insertRows[j];
            const source = chunk[j];
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(insertRow)
              .select('id')
              .single();

            if (!singleErr && singleData) {
              imported++;
              if (source.tagNames.length > 0) {
                tagAssignments.push({
                  contactId: singleData.id,
                  tagNames: source.tagNames,
                });
              }
            } else if (isUniqueViolation(singleErr)) {
              skipped++;
            } else {
              failed++;
            }
          }
        } else {
          const inserted = data ?? [];
          imported += inserted.length;
          // inserted[j] ↔ chunk[j] only holds because a single INSERT
          // preserves RETURNING order. If this path is ever split into
          // parallel inserts, zip by phone or returned id instead.
          for (let j = 0; j < inserted.length; j++) {
            const source = chunk[j];
            if (!source || source.tagNames.length === 0) continue;
            tagAssignments.push({
              contactId: inserted[j].id,
              tagNames: source.tagNames,
            });
          }
        }
      }

      // 5) Wire tags onto the contacts we just created. Failure here must
      //    not mask a successful contact import.
      let tagsAssigned = 0;
      try {
        tagsAssigned = await assignImportedContactTags(
          supabase,
          tagAssignments,
          tagIdByKey
        );
      } catch {
        toast.warning(t('toastTagsWarning'));
      }

      setResult({ imported, skipped, failed, tagsAssigned });
      if (imported > 0) {
        toast.success(t('toastImported', { count: imported }));
        onImported();
      }
      if (tagsAssigned > 0) {
        toast.success(t('toastTagsAssigned', { count: tagsAssigned }));
      }
      if (skippedNames.length > 0) {
        const sample = skippedNames.slice(0, 3).join(', ');
        const more =
          skippedNames.length > 3 ? ` (+${skippedNames.length - 3} more)` : '';
        toast.info(t('toastTagsSkipped', { sample, more }));
      }
      if (skipped > 0) {
        toast.info(t('toastSkipped', { count: skipped }));
      }
      if (failed > 0) {
        toast.error(t('toastFailed', { count: failed }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = rows.slice(0, PREVIEW_LIMIT);
  const previewHasTags = rows.some((row) => row.tagNames.length > 0);
  const previewHasCompany = rows.some((row) => row.company?.trim());

  const tagStats = useMemo(() => {
    const names = new Set<string>();
    let rowsWithTags = 0;
    for (const row of rows) {
      if (row.tagNames.length === 0) continue;
      rowsWithTags++;
      for (const name of row.tagNames) names.add(name.trim().toLowerCase());
    }
    return { unique: names.size, rowsWithTags };
  }, [rows]);

  const canSubmit =
    rows.length > 0 && !importing && !parser.parsing && !sheetsLoading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground flex max-h-[min(90vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="border-border/80 shrink-0 space-y-4 border-b px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-popover-foreground text-lg">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground leading-relaxed">
              {t('desc')}
            </DialogDescription>
          </DialogHeader>

          <ImportSourcePicker
            value={source}
            onChange={handleSourceChange}
            options={sourceOptions}
            recommendedLabel={t('source.recommended')}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {/* Modelo + colunas aceitas. Vem ANTES do campo de upload de
              propósito: quem chega aqui sem planilha pronta baixa o
              modelo em vez de descobrir o formato pelo erro de parsing. */}
          <SpreadsheetTemplateHint
            namespace="Contacts.importModal.template"
            showTagsNote
            showTagCreationNote
            showHeaderNote
          />

          {source === 'google_sheets' && (
            <GoogleSheetsSource
              onImport={handleSheetsImport}
              loading={sheetsLoading || parser.parsing}
              errorCode={sheetsErrorCode}
            />
          )}

          {source === 'spreadsheet' && (
            <SpreadsheetDropzone
              file={file}
              parsing={parser.parsing}
              progress={parser.progress}
              onFileSelected={handleFileSelected}
              onClear={handleClearFile}
              sheetNames={parser.result?.sheetNames}
              activeSheet={activeSheet}
              onSheetChange={handleSheetChange}
            />
          )}

          {parser.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {tParseError(parser.error.code, parser.error.meta ?? {})}
            </div>
          )}

          {preview.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
                  {t('preview', { count: preview.length })}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tagStats.rowsWithTags > 0 && (
                    <span className="bg-muted/90 text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]">
                      <Tag className="text-primary/80 size-3" />
                      {t('previewTags', {
                        tags: tagStats.unique,
                        contacts: tagStats.rowsWithTags,
                      })}
                    </span>
                  )}
                </div>
              </div>

              <div className="border-border ring-border/50 overflow-hidden rounded-xl border ring-1">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="border-border bg-background/60 border-b">
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium whitespace-nowrap">
                          {t('columns.phone')}
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium whitespace-nowrap">
                          {t('columns.name')}
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-left font-medium whitespace-nowrap">
                          {t('columns.email')}
                        </th>
                        {previewHasCompany && (
                          <th className="text-muted-foreground px-3 py-2 text-left font-medium whitespace-nowrap">
                            {t('columns.company')}
                          </th>
                        )}
                        {previewHasTags && (
                          <th className="text-muted-foreground px-3 py-2 text-left font-medium whitespace-nowrap">
                            {t('columns.tags')}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-border/70 divide-y">
                      {preview.map((row, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 hover:bg-muted/30 transition-colors"
                        >
                          <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                            <PreviewCell
                              value={row.phone}
                              mono
                              maxWidth="max-w-[7.5rem]"
                            />
                          </td>
                          <td className="text-popover-foreground px-3 py-2">
                            <PreviewCell
                              value={row.name || '—'}
                              maxWidth="max-w-[8.5rem]"
                            />
                          </td>
                          <td className="text-muted-foreground px-3 py-2">
                            <PreviewCell
                              value={row.email || '—'}
                              maxWidth="max-w-[10rem]"
                            />
                          </td>
                          {previewHasCompany && (
                            <td className="text-muted-foreground px-3 py-2">
                              <PreviewCell
                                value={row.company || '—'}
                                maxWidth="max-w-[7rem]"
                              />
                            </td>
                          )}
                          {previewHasTags && (
                            <td className="px-3 py-2 align-top">
                              <ImportPreviewTags
                                tagNames={row.tagNames}
                                tagColorByKey={tagColorByKey}
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {rows.length > PREVIEW_LIMIT && (
                <p className="text-muted-foreground text-center text-[11px]">
                  {t('moreRows', { count: rows.length - PREVIEW_LIMIT })}
                </p>
              )}
            </div>
          )}

          {/* SPEC 052 D-3: continua visível junto do resultado — antes
              o resumo sumia assim que a importação terminava, que é
              exatamente quando o usuário quer conferir o que ficou de
              fora. */}
          {parser.result && (
            <ImportRejectSummary
              namespace="Contacts.importModal.summary"
              stats={parser.result.audience.stats}
              invalid={parser.result.audience.invalid}
              sheetName={
                source === 'spreadsheet' ? parser.result.sheetName : undefined
              }
            />
          )}

          {result && (
            <div className="border-border bg-background/50 rounded-xl border p-4">
              <p className="text-popover-foreground text-sm font-medium">
                {t('importComplete')}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultImported', { count: result.imported })}
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultTags', { count: result.tagsAssigned })}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultSkipped', { count: result.skipped })}
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-border/80 bg-background/50 mt-0 shrink-0 gap-2 border-t px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {t('importBtn', { count: rows.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
