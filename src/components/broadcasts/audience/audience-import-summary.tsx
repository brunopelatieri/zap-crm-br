'use client';

/**
 * Envoltório fino sobre `ImportRejectSummary` (SPEC 052 F4, §5.1).
 *
 * Existe só para o passo 2 do disparo continuar chamando
 * `<AudienceImportSummary audience={imported} sheetName={...} />` sem
 * mudar uma linha — quem decompõe `NormalizedAudience` nos pedaços
 * genéricos (`stats`, `invalid`) é este arquivo, não o componente
 * compartilhado, que não conhece esse tipo de domínio.
 */

import { ImportRejectSummary } from '@/components/import/import-reject-summary';
import type { NormalizedAudience } from '@/lib/audience/types';

export function AudienceImportSummary({
  audience,
  sheetName,
}: {
  audience: NormalizedAudience;
  sheetName?: string;
}) {
  return (
    <ImportRejectSummary
      namespace="Broadcasts.audience.summary"
      stats={audience.stats}
      invalid={audience.invalid}
      sheetName={sheetName}
    />
  );
}
