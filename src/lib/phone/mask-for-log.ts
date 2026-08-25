/**
 * Mascara os dígitos do meio de um telefone para exibição no log de
 * webhook (SPEC 055 D-13) — mantém os primeiros dígitos (DDI+DDD) e os
 * dois últimos visíveis, preservando pontuação (`+`, `(`, `)`, `-`).
 *
 * Opera sobre a string COMO RECEBIDA, sem normalizar: `webhook_ingest_
 * logs.phone` é gravado sem passar por `normalizeContactPhone` de
 * propósito — é o dado que falhou a validação, então pode não ter
 * formato nenhum. Por isso este módulo não reusa `formatPhoneForDisplay`
 * (`src/lib/phone/br.ts`), que assume um número BR já válido.
 */
export function maskPhoneForLog(raw: string | null | undefined): string {
  if (!raw) return '—';

  const chars = raw.split('');
  const digitPositions = chars.reduce<number[]>((acc, ch, i) => {
    if (/\d/.test(ch)) acc.push(i);
    return acc;
  }, []);

  const total = digitPositions.length;
  if (total <= 6) return raw.replace(/\d/g, '*');

  const maskFrom = 4;
  const maskTo = total - 2;
  digitPositions.forEach((charIdx, digitPos) => {
    if (digitPos >= maskFrom && digitPos < maskTo) {
      chars[charIdx] = '*';
    }
  });
  return chars.join('');
}
