/**
 * Célula de erro da tabela de recipients — traduz códigos conhecidos
 * da Cloud API (SPEC: catálogo em `src/lib/meta-errors.ts`) e expõe
 * Código + Descrição/Causa + Ação recomendada num tooltip, em vez de
 * só truncar o texto cru que a Meta devolveu.
 *
 * Mensagem sem match no catálogo cai para o texto cru — mantém o dado
 * visível mesmo para um erro que o catálogo ainda não cobre.
 */

import { useMemo } from 'react';
import type { useTranslations } from 'next-intl';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { matchMetaError } from '@/lib/meta-errors';

/**
 * `truncate` (overflow-hidden + text-overflow-ellipsis) e `max-w-xs`
 * só têm efeito em elementos block-level — num `<span>` (inline por
 * padrão) `max-width` simplesmente não se aplica (CSS §10.4) e o texto
 * nunca é cortado. `block` resolve isso sem trocar a tag.
 */
const CLIPPED_TEXT_CLASS = 'block max-w-xs truncate text-xs text-red-400';

export function RecipientErrorCell({
  errorMessage,
  t,
}: {
  errorMessage: string | null | undefined;
  /** Recebido do pai (`Broadcasts.detail`) em vez de chamar
   * `useTranslations` aqui — esta célula é renderizada uma vez por
   * linha, e cada linha instanciar seu próprio tradutor é trabalho
   * repetido sem necessidade quando o pai já tem um. */
  t: ReturnType<typeof useTranslations>;
}) {
  // `errorMessage` é uma string primitiva: mesmo que o polling do pai
  // substitua o array `recipients` inteiro a cada 5s, `useMemo` só
  // recalcula o casamento contra o catálogo quando o TEXTO do erro
  // desta linha realmente mudou.
  const entry = useMemo(() => matchMetaError(errorMessage), [errorMessage]);

  if (!errorMessage) {
    return <span className="text-muted-foreground text-xs">-</span>;
  }

  if (!entry) {
    return <span className={CLIPPED_TEXT_CLASS}>{errorMessage}</span>;
  }

  const title = t(`metaErrors.${entry.code}.title`);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`${CLIPPED_TEXT_CLASS} cursor-default underline decoration-dotted underline-offset-2`}
          />
        }
      >
        {title}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm flex-col items-start gap-1 !py-2 text-left whitespace-normal">
        <p className="font-medium">
          {t('metaErrorCode')} #{entry.code} — {title}
        </p>
        <p className="opacity-90">
          {t(`metaErrors.${entry.code}.description`)}
        </p>
        <p className="opacity-90">
          <span className="font-medium">{t('metaErrorAction')}:</span>{' '}
          {t(`metaErrors.${entry.code}.action`)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
