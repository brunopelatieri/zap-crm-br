'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Tag as TagIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DEFAULT_TAG_COLOR,
  createTag,
  fetchTags as fetchTagCatalog,
} from '@/lib/tags';
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';
import { TagBadge } from './tag-badge';
import { TagColorPicker } from './tag-color-picker';
import { TagEditDialog } from './tag-edit-dialog';

/**
 * Tags card — colour-coded contact labels. Creation is an inline row
 * (name + colour picker + Add); editing name/colour goes through
 * `TagEditDialog`; deletion goes through a confirmation dialog since it
 * detaches the tag from every contact.
 *
 * As três ações mutantes são gatadas por `edit-settings`: as políticas
 * `tags_insert` / `tags_update` / `tags_delete` (migração 017) exigem
 * `admin`, então mostrá-las a um agent produziria um 42501 garantido
 * com uma mensagem que não explica nada.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState<string>(DEFAULT_TAG_COLOR);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    loadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  /**
   * Catálogo pela lib, que confia na RLS (`tags_select`) para o escopo.
   * O filtro `.eq('user_id', ...)` que estava aqui antes escondia de um
   * admin as etiquetas criadas por outro admin da mesma conta — e este
   * card é justamente onde o catálogo da conta é editado.
   */
  async function loadTags() {
    try {
      setLoading(true);
      setTags(await fetchTagCatalog(supabase));
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error(t('failedToLoadTags'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newTagName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    try {
      setSaving(true);
      if (!user || !accountId) {
        toast.error(t('notAuthenticated'));
        return;
      }

      // `createTag` faz get-or-create: se o nome já existir na conta
      // (case-insensitive, via o índice único da migração 038), ele
      // devolve a etiqueta existente em vez de criar uma duplicata.
      // account_id é obrigatório em todo insert com escopo de conta
      // (NOT NULL + RLS, sem default no banco).
      await createTag(supabase, {
        userId: user.id,
        accountId,
        name: newTagName.trim(),
        color: selectedColor,
      });

      toast.success(t('tagCreated'));
      setNewTagName('');
      setSelectedColor(DEFAULT_TAG_COLOR);
      await loadTags();
    } catch (err) {
      console.error('Create error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(tag: Tag) {
    setTagToDelete(tag);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!tagToDelete) return;

    try {
      setDeleting(true);
      const { error } = await supabase
        .from('tags')
        .delete()
        .eq('id', tagToDelete.id);

      if (error) throw error;

      toast.success(t('tagDeleted'));
      setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));
      setDeleteDialogOpen(false);
      setTagToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(t('failedToDeleteTag'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <TagIcon className="text-primary size-4" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        ) : (
          <>
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <TagBadge
                    key={tag.id}
                    tag={tag}
                    canEdit={canEdit}
                    onEdit={setEditingTag}
                    onDelete={confirmDelete}
                  />
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {canEdit ? t('noTags') : t('noTagsReadOnly')}
              </p>
            )}

            {/* Inline create row */}
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-2.5">
                <Input
                  placeholder={t('placeholder')}
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                  }}
                  disabled={saving}
                  maxLength={40}
                  className="min-w-[180px] flex-1"
                />
                <TagColorPicker
                  value={selectedColor}
                  onChange={setSelectedColor}
                  disabled={saving}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCreate}
                  disabled={saving || !newTagName.trim()}
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {t('addTag')}
                </Button>
              </div>
            ) : (
              // Explica em vez de apenas omitir os controles — mesma
              // escolha do `onlyAdminsCanCreate` no picker do Inbox.
              <p className="text-muted-foreground border-border border-t pt-3 text-xs">
                {t('onlyAdminsCanEdit')}
              </p>
            )}
          </>
        )}
      </CardContent>

      {/* Edição — `key` remonta o modal a cada etiqueta, o que
          reinicializa o rascunho sem useEffect de sincronização. */}
      <TagEditDialog
        key={editingTag?.id ?? 'none'}
        tag={editingTag}
        allTags={tags}
        onClose={() => setEditingTag(null)}
        onSaved={(updated) => {
          setTags((prev) =>
            prev.map((tag) => (tag.id === updated.id ? updated : tag))
          );
          setEditingTag(null);
          toast.success(t('tagUpdated'));
        }}
        onStale={() => {
          setEditingTag(null);
          loadTags();
        }}
      />

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTag')}</DialogTitle>
            <DialogDescription>
              {tagToDelete
                ? t('deleteConfirm', { name: tagToDelete.name })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTag')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
