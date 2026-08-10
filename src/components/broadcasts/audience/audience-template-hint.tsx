'use client';

/**
 * Modelo de planilha + referência das colunas (SPEC 044 §3.1).
 *
 * Aparece nas duas fontes importadas — planilha local e Google
 * Planilhas — porque em ambas quem monta o arquivo é o usuário.
 *
 * Existe para antecipar o erro mais caro do passo: o cabeçalho errado.
 * `missing_phone_column` só chega DEPOIS do upload, quando a planilha
 * já foi montada; mostrar as colunas antes, com um arquivo pronto para
 * preencher, corta a viagem de ida e volta.
 *
 * A lista sai de `AUDIENCE_COLUMNS`, a mesma fonte que o parser usa —
 * o que está escrito aqui é, por construção, o que o parser aceita.
 */

import { Download, FileSpreadsheet } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { AUDIENCE_COLUMNS } from '@/lib/audience/parse-csv';
import {
  AUDIENCE_TEMPLATE_FILENAME,
  buildAudienceTemplateCsv,
} from '@/lib/audience/template-file';

export function AudienceTemplateHint() {
  const t = useTranslations('Broadcasts.audience.template');

  function handleDownload() {
    // U+FEFF (BOM) é o que faz o Excel abrir "João" em vez de "JoÃ£o".
    // O parser não se importa: `readCsvTable` o absorve no `trim`.
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom, buildAudienceTemplateCsv()], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);

    // O anchor precisa estar no documento para o `click()` disparar o
    // download no Firefox — não basta criar o elemento solto.
    const link = document.createElement('a');
    link.href = url;
    link.download = AUDIENCE_TEMPLATE_FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Revogar na próxima tarefa: revogar em seguida ao clique cancela
    // o download que o navegador ainda não começou a ler.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="border-border bg-card/50 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <FileSpreadsheet className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-foreground text-sm font-medium">{t('title')}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('subtitle')}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleDownload}
          className="border-border shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          {t('download')}
        </Button>
      </div>

      <ul className="mt-3 space-y-1.5">
        {AUDIENCE_COLUMNS.map(({ key, required, aliases }) => (
          <li
            key={key}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
          >
            <code className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-mono text-[11px]">
              {aliases[0]}
            </code>
            <span
              className={
                required
                  ? 'font-medium text-amber-300'
                  : 'text-muted-foreground'
              }
            >
              {required ? t('required') : t('optional')}
            </span>
            <span className="text-muted-foreground">{t(`columns.${key}`)}</span>
            {aliases.length > 1 && (
              <span className="text-muted-foreground/70">
                {t('alsoAccepted', { aliases: aliases.slice(1).join(', ') })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
