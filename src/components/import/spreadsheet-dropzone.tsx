'use client';

/**
 * Seleção/arraste de `.csv` e `.xlsx` (SPEC 044 §3.1).
 *
 * Estética alinhada ao `import-modal.tsx` de contatos — mesma
 * linguagem visual para a mesma operação, em dois lugares diferentes
 * do produto.
 *
 * O parsing não acontece aqui: o componente só entrega o `File` ao
 * `useSpreadsheetParser` e reflete `parsing` / `progress`. Isso mantém
 * o componente livre de qualquer conhecimento de fatiamento ou
 * cancelamento.
 *
 * Namespace i18n fixo em `Import.upload` (SPEC 052 F7), não por prop —
 * ao contrário de `SpreadsheetTemplateHint`, o texto aqui já é o mesmo
 * para os dois consumidores (disparo e contatos), então não há por que
 * cada um trazer sua própria cópia.
 */

import { useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { MAX_SPREADSHEET_BYTES } from '@/lib/spreadsheet/types';

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

interface SpreadsheetDropzoneProps {
  file: File | null;
  parsing: boolean;
  /** Progresso da normalização fatiada. `null` em arquivo pequeno. */
  progress?: { processed: number; total: number } | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  /** Abas disponíveis quando o arquivo é .xlsx com mais de uma. */
  sheetNames?: string[];
  activeSheet?: string;
  onSheetChange?: (name: string) => void;
}

export function SpreadsheetDropzone({
  file,
  parsing,
  progress,
  onFileSelected,
  onClear,
  sheetNames,
  activeSheet,
  onSheetChange,
}: SpreadsheetDropzoneProps) {
  const t = useTranslations('Import.upload');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const selected = files?.[0];
    if (selected) onFileSelected(selected);
  }

  function handleClear() {
    if (inputRef.current) inputRef.current.value = '';
    onClear();
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed p-6 text-center transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-border bg-card/50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id="audience-file-input"
        />

        {file ? (
          <div className="flex items-center justify-center gap-3">
            {parsing ? (
              <Loader2 className="text-primary h-5 w-5 shrink-0 animate-spin" />
            ) : (
              <FileSpreadsheet className="text-primary h-5 w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1 text-left">
              <p className="text-foreground truncate text-sm font-medium">
                {file.name}
              </p>
              <p className="text-muted-foreground text-xs">
                {parsing
                  ? progress
                    ? t('parsingProgress', {
                        processed: progress.processed.toLocaleString(),
                        total: progress.total.toLocaleString(),
                      })
                    : t('parsing')
                  : formatBytes(file.size)}
              </p>
              {parsing && progress && (
                <div className="bg-muted mt-1.5 h-1 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-1 rounded-full transition-[width] duration-150"
                    style={{
                      width: `${Math.round(
                        (progress.processed / Math.max(1, progress.total)) * 100
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={parsing}
              className="text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label={t('clear')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <Upload className="text-muted-foreground mx-auto mb-2 h-7 w-7" />
            <label
              htmlFor="audience-file-input"
              className="text-primary cursor-pointer text-sm font-medium hover:underline"
            >
              {t('choose')}
            </label>
            <p className="text-muted-foreground mt-1 text-xs">{t('orDrag')}</p>
            <p className="text-muted-foreground mt-2 text-xs">
              {t('accepted', { max: formatBytes(MAX_SPREADSHEET_BYTES) })}
            </p>
          </>
        )}
      </div>

      {/* Seletor de aba: só aparece quando a pasta tem mais de uma.
          A aba é escolhida automaticamente pela presença de coluna de
          telefone, então na maioria dos casos isto fica intocado. */}
      {sheetNames && sheetNames.length > 1 && onSheetChange && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted-foreground text-xs font-medium">
            {t('sheet')}
          </label>
          <select
            value={activeSheet ?? sheetNames[0]}
            onChange={(e) => onSheetChange(e.target.value)}
            disabled={parsing}
            className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-8 rounded-lg border px-2 text-xs outline-none focus:ring-1 disabled:opacity-50"
          >
            {sheetNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="text-muted-foreground text-xs">{t('columnsHint')}</p>
    </div>
  );
}
