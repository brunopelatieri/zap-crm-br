'use client';

/**
 * Importação por link do Google Sheets (SPEC 044 §3.2.2).
 *
 * Fonte padrão do passo 2: é a que não exige o usuário exportar nada.
 * Ele cola o link da planilha que já mantém e segue.
 *
 * A validação de formato acontece aqui só para dar feedback imediato;
 * a validação que importa é a do servidor, que reconstrói a URL a
 * partir do id extraído em vez de confiar na string colada.
 */

import { useState } from 'react';
import { ExternalLink, Loader2, Sheet } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { extractSheetRef } from '@/lib/audience/google-sheets';

interface GoogleSheetsSourceProps {
  /** Busca o CSV pela rota e devolve o texto, ou lança com `code`. */
  onImport: (url: string) => Promise<void>;
  loading: boolean;
  /** Código de erro da rota, já traduzível. */
  errorCode: string | null;
}

export function GoogleSheetsSource({
  onImport,
  loading,
  errorCode,
}: GoogleSheetsSourceProps) {
  const t = useTranslations('Broadcasts.audience.sheets');
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);

  const looksValid = extractSheetRef(url) !== null;
  const showFormatError = touched && url.trim().length > 0 && !looksValid;

  return (
    <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <Sheet className="text-primary h-4 w-4" />
        <p className="text-foreground text-sm font-medium">{t('title')}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={t('placeholder')}
          disabled={loading}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground flex-1"
        />
        <Button
          onClick={() => onImport(url)}
          disabled={!looksValid || loading}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          {t('import')}
        </Button>
      </div>

      {showFormatError && (
        <p className="text-xs text-amber-300">{t('invalidUrl')}</p>
      )}
      {errorCode && !showFormatError && (
        <p className="text-xs text-red-300">{t(`error.${errorCode}`)}</p>
      )}

      {/* A restrição de compartilhamento é a dúvida nº 1 deste fluxo —
          explicá-la antes do erro poupa uma ida e volta. */}
      <p className="text-muted-foreground text-xs">{t('shareHint')}</p>
    </div>
  );
}
