'use client';

/**
 * Aviso "estes contatos serão salvos" — SPEC 057 F6.
 *
 * Mostra a PROJEÇÃO calculada no stage (D-7): nada aqui foi escrito
 * ainda, e o texto está sempre no futuro por isso — a materialização de
 * verdade só acontece no envio (`upsertImportedContacts`, D-2/D-1).
 *
 * `summary` vem de `sessionStorage` (ver `stage-summary-storage.ts`) e
 * pode ser `null` — reload direto na URL da triagem, por exemplo. Sem
 * projeção, o aviso simplesmente não aparece; não há nada a reconstruir
 * aqui sem voltar ao passo 2.
 */

import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';

import type { StageAudienceSummary } from '@/lib/audience/stage';

export function StageSummaryBanner({
  summary,
}: {
  summary: StageAudienceSummary | null;
}) {
  const t = useTranslations('Broadcasts.audience.triage.dataSaveNotice');

  if (!summary) return null;

  const willCreate = summary.willCreate;
  const willUpdate = summary.willUpdate;
  const tagsToCreate = summary.tagsToCreate;
  const tagsSkipped = summary.tagsSkipped;

  const hasContactNotice = willCreate > 0 || willUpdate > 0;
  const hasTagNotice = tagsToCreate.length > 0 || tagsSkipped.length > 0;

  if (!hasContactNotice && !hasTagNotice) return null;

  return (
    <div className="border-border bg-muted/40 flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
      <div className="flex gap-2">
        <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-col gap-1">
          {hasContactNotice && (
            <p className="text-foreground">
              {t('contactsWillBeSaved', { count: willCreate + willUpdate })}
            </p>
          )}
          {tagsToCreate.length > 0 && (
            <p className="text-muted-foreground">
              {t('tagsWillBeCreated', {
                count: tagsToCreate.length,
                names: tagsToCreate.join(', '),
              })}
            </p>
          )}
          {tagsSkipped.length > 0 && (
            <p className="text-amber-500">
              {t('tagsSkippedNoPermission', { names: tagsSkipped.join(', ') })}
            </p>
          )}
          <p className="text-muted-foreground">
            {t('repliesWillShowCampaign')}
          </p>
        </div>
      </div>
    </div>
  );
}
