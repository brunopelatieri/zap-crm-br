/**
 * Ponte de `sessionStorage` entre o passo 2 (que recebe a projeção de
 * `POST /api/broadcasts/audience/stage`) e a triagem roteada (SPEC 057
 * F6), que é uma navegação de página cheia — sem gerenciador de estado
 * global (ver o cabeçalho de `triage/page.tsx`).
 *
 * Best-effort por natureza: a chave existe só entre um `handleAnalyze` e
 * a primeira renderização da triagem NA MESMA ABA. Um reload direto na
 * URL da triagem, ou um link compartilhado, simplesmente não encontra a
 * chave — a página degrada escondendo o aviso, nunca quebra.
 */

import type { StageAudienceSummary } from './stage';

const KEY_PREFIX = 'zapcrm:stage-summary:';

export function saveStageSummary(
  draftId: string,
  summary: StageAudienceSummary
): void {
  try {
    sessionStorage.setItem(KEY_PREFIX + draftId, JSON.stringify(summary));
  } catch {
    // sessionStorage pode estar indisponível (modo privado, quota) — o
    // aviso da triagem só deixa de aparecer, nada quebra.
  }
}

/** Lê e CONSOME — a projeção só vale para a primeira renderização. */
export function takeStageSummary(draftId: string): StageAudienceSummary | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + draftId);
    if (!raw) return null;
    sessionStorage.removeItem(KEY_PREFIX + draftId);
    return JSON.parse(raw) as StageAudienceSummary;
  } catch {
    return null;
  }
}
