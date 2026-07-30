'use client';

// ============================================================
// TagEditDialog — edição de nome e cor de uma etiqueta existente.
//
// Recebe `tag` por prop em vez de ler um context: ao contrário do
// TagPickerDialog do Inbox (vários pontos de acionamento), aqui existe
// um único gatilho, na mesma árvore. Provider seria cerimônia sem ganho.
//
// A escrita é CONFIRMADA, não otimista — inversão consciente do padrão
// do Inbox. Lá o toggle otimista existe porque a latência aparece no
// meio de uma conversa; aqui o usuário já está num modal com botão de
// salvar, e desfazer visualmente um nome/cor no meio de uma grade de
// chips confunde mais do que um spinner de 200ms.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Tag as TagIcon, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { hasLowChipContrast, type ChipTheme } from '@/lib/colors';
import {
  PGRST_NO_SINGLE_ROW,
  PG_INSUFFICIENT_PRIVILEGE,
  TagNameConflictError,
  normalizeTagName,
  updateTag,
} from '@/lib/tags';
import type { Tag } from '@/types';
import { TagBadgePreview } from './tag-badge';
import { TagColorPicker } from './tag-color-picker';

const NAME_MAX_LENGTH = 40;

interface TagEditDialogProps {
  /** `null` = fechado. O pai monta com `key={tag.id}` (ver §5.2). */
  tag: Tag | null;
  /** Catálogo, para a checagem local de nome duplicado. */
  allTags: Tag[];
  onClose: () => void;
  /** Chamado após o UPDATE confirmado, com a linha devolvida pelo banco. */
  onSaved: (updated: Tag) => void;
  /**
   * A etiqueta não existe mais (ou a RLS a filtrou): o catálogo em
   * memória está velho e o pai precisa recarregar. Não estava no
   * contrato da §4.4 do SPEC, mas a §5.6 exige esse tratamento para o
   * `PGRST116` — sem o callback, o modal ficaria pedindo para salvar
   * uma linha inexistente.
   */
  onStale: () => void;
}

export function TagEditDialog({
  tag,
  allTags,
  onClose,
  onSaved,
  onStale,
}: TagEditDialogProps) {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();

  // Semeado no mount. O pai remonta via `key`, então não há
  // `useEffect` de sincronização — a fonte clássica de "abri a
  // etiqueta B e vi o rascunho da A".
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? '');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const trimmed = name.trim();
  const dirty = tag ? trimmed !== tag.name || color !== tag.color : false;
  const localConflict = tag
    ? allTags.some(
        (other) =>
          other.id !== tag.id &&
          normalizeTagName(other.name) === normalizeTagName(trimmed)
      )
    : false;
  const canSave = trimmed.length > 0 && dirty && !localConflict && !saving;

  const lowContrast = hasLowChipContrast(color);
  const lowContrastMessage = lowContrast.light
    ? lowContrast.dark
      ? t('lowContrastBoth')
      : t('lowContrastLight')
    : lowContrast.dark
      ? t('lowContrastDark')
      : null;

  async function handleSave() {
    if (!tag || !canSave) return;

    setSaving(true);
    setNameError(null);
    try {
      // Patch parcial: só o que mudou vai para o banco, para não
      // sobrescrever o campo que outro admin alterou em paralelo.
      const updated = await updateTag(supabase, {
        id: tag.id,
        ...(trimmed !== tag.name ? { name: trimmed } : {}),
        ...(color !== tag.color ? { color } : {}),
      });
      onSaved(updated);
    } catch (err) {
      // Conflito de nome é o único erro que NÃO vira toast: a mensagem
      // pertence ao campo que a causou, e o rascunho segue editável.
      if (err instanceof TagNameConflictError) {
        setNameError(t('nameInUse'));
        return;
      }

      const code = (err as { code?: string } | null)?.code;
      if (code === PGRST_NO_SINGLE_ROW) {
        toast.error(t('tagNotFound'));
        onStale();
        return;
      }
      if (code === PG_INSUFFICIENT_PRIVILEGE) {
        toast.error(t('onlyAdminsCanEdit'));
        return;
      }

      console.error('Update tag error:', err);
      toast.error(t('failedToUpdateTag'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={tag !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="text-primary size-4 shrink-0" />
            {t('editTag')}
          </DialogTitle>
          <DialogDescription>{t('editTagDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="tag-edit-name">{t('nameLabel')}</Label>
            <span className="text-muted-foreground text-xs tabular-nums">
              {trimmed.length}/{NAME_MAX_LENGTH}
            </span>
          </div>
          <Input
            id="tag-edit-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder={t('placeholder')}
            maxLength={NAME_MAX_LENGTH}
            disabled={saving}
            autoFocus
            aria-invalid={localConflict || nameError !== null}
            aria-describedby={
              localConflict || nameError ? 'tag-edit-name-error' : undefined
            }
          />
          {(localConflict || nameError) && (
            <p id="tag-edit-name-error" className="text-destructive text-xs">
              {nameError ?? t('nameInUse')}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t('colorLabel')}</Label>
          <TagColorPicker
            value={color}
            onChange={setColor}
            disabled={saving}
            size="md"
          />
        </div>

        <div className="space-y-2">
          <Label>{t('preview')}</Label>
          <div className="flex gap-2">
            {(['light', 'dark'] as ChipTheme[]).map((theme) => (
              <div key={theme} className="min-w-0 flex-1 space-y-1">
                <p className="text-muted-foreground text-xs">
                  {theme === 'light' ? t('previewLight') : t('previewDark')}
                </p>
                <TagBadgePreview
                  name={trimmed || t('placeholder')}
                  color={color}
                  theme={theme}
                />
              </div>
            ))}
          </div>
          {/* Região viva sempre montada: se ela só existisse quando há
              aviso, o leitor de tela não anunciaria a mudança que a
              criou. Vazia quando as duas prévias estão legíveis. */}
          <p
            role="status"
            aria-live="polite"
            className="text-muted-foreground flex items-start gap-1.5 text-xs empty:hidden"
          >
            {lowContrastMessage && (
              <>
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                {lowContrastMessage}
              </>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
