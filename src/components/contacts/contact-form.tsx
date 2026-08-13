'use client';

import { useState, useEffect } from 'react';
import PhoneInput, { isValidPhoneNumber } from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import { isBrDeployment } from '@/lib/i18n/deployment-locale';
import { normalizeContactPhone, type PhoneRejectReason } from '@/lib/phone/br';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Motivos de recusa "de sabor BR" (SPEC 050 D-3): quando a rejeição vem
 * de uma destas razões, a validação desta função é AUTORITATIVA sobre a
 * do `react-phone-number-input` — o número "parece brasileiro" e é a
 * regra local (DDD/9º dígito) que decide, não a lib genérica.
 */
const DOMESTIC_REASONS = new Set<PhoneRejectReason>([
  'invalid_ddd',
  'mobile_invalid_ninth_digit',
  'invalid_local_prefix',
  'missing_country_code',
]);

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const t = useTranslations('Contacts.form');
  const supabase = createClient();
  const { accountId } = useAuth();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  // E.164-with-`+`, the shape `PhoneInput` manages — never what gets
  // saved. The saved value always comes from `normalizeContactPhone`
  // (SPEC 050): digits-only, with DDI, no `+`.
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);

  // Inline validation (SPEC 050 F2). `phoneLegacy` is the D-6
  // non-blocking notice for an 8-digit BR celular (pre-nono-dígito) —
  // it never prevents saving, only asks the user to confirm.
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneLegacy, setPhoneLegacy] = useState(false);

  // Duplicate-phone detection for NEW contacts. `exact` (same digits)
  // hard-blocks the save; a fuzzy trunk-variant match only warns. The
  // DB unique index (migration 022) is the real backstop — this is the
  // friendly heads-up before we get there.
  const [dupMatch, setDupMatch] = useState<{
    contact: ExistingContact;
    exact: boolean;
  } | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      // Stored `phone` is digits-only without `+` (canonical format);
      // `PhoneInput` needs the `+` back to recognize it as E.164.
      setPhone(contact?.phone ? `+${contact.phone}` : '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      setDupMatch(null);
      setPhoneError(null);
      setPhoneLegacy(false);
      fetchTags();
    }
  }, [open, contact]);

  function reasonMessage(reason: PhoneRejectReason): string {
    switch (reason) {
      case 'empty':
        return t('phoneRequired');
      case 'invalid_ddd':
        return t('phoneInvalidDdd');
      case 'mobile_invalid_ninth_digit':
        return t('phoneInvalidNinthDigit');
      case 'invalid_local_prefix':
        return t('phoneInvalidLocalPrefix');
      case 'missing_country_code':
        return t('phoneMissingCountryCode');
      case 'invalid_length':
        return t('phoneInvalidLength');
    }
  }

  /**
   * Valida + normaliza o telefone digitado (SPEC 050 D-3): a regra BR
   * desta SPEC é autoritativa para qualquer número "de cara brasileira"
   * (doméstico, ou rejeitado por um motivo específico do Brasil); para
   * o resto (estrangeiro, ou problema de comprimento genérico), quem
   * decide é o validador da lib de máscara.
   */
  function validatePhoneValue(
    raw: string
  ): { phone: string; legacy: boolean } | { error: string } {
    if (!raw.trim()) return { error: t('phoneRequired') };

    const result = normalizeContactPhone(raw);

    if (result.ok) {
      if (result.kind !== 'foreign') {
        return { phone: result.phone, legacy: result.legacy };
      }
      // Estrangeiro: cruza com a lib antes de aceitar (D-3).
      if (!isValidPhoneNumber(raw)) return { error: t('phoneInvalidLength') };
      return { phone: result.phone, legacy: false };
    }

    if (DOMESTIC_REASONS.has(result.reason)) {
      return { error: reasonMessage(result.reason) };
    }

    // invalid_length fora da faixa doméstica — a lib decide (D-3).
    if (isValidPhoneNumber(raw)) {
      return { phone: sanitizePhoneForMeta(raw), legacy: false };
    }
    return { error: reasonMessage(result.reason) };
  }

  function handlePhoneBlur() {
    const validation = validatePhoneValue(phone);
    if ('error' in validation) {
      setPhoneError(validation.error);
      setPhoneLegacy(false);
    } else {
      setPhoneError(null);
      setPhoneLegacy(validation.legacy);
    }
    checkDuplicate();
  }

  // Look up an existing contact with this number (new contacts only).
  // Runs on blur so we don't query on every keystroke.
  async function checkDuplicate() {
    if (isEdit || !accountId) return;
    const value = phone.trim();
    if (!value) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(supabase, accountId, value);
      setDupMatch(
        existing
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase.from('tags').select('*').order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validation = validatePhoneValue(phone);
    if ('error' in validation) {
      setPhoneError(validation.error);
      toast.error(validation.error);
      return;
    }
    setPhoneError(null);
    setPhoneLegacy(validation.legacy);
    const normalizedPhone = validation.phone;

    // Hard-block an exact duplicate on create (the DB unique index is
    // the real backstop; this avoids a round-trip + a raw error toast).
    if (!isEdit && dupMatch?.exact) {
      toast.error(t('toastConflict'));
      return;
    }

    setSaving(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId)
        throw new Error('Your profile is not linked to an account.');

      let contactId = contact?.id;

      if (isEdit && contactId) {
        const { error } = await supabase
          .from('contacts')
          .update({
            name: name.trim() || null,
            phone: normalizedPhone,
            email: email.trim() || null,
            company: company.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: name.trim() || null,
            phone: normalizedPhone,
            email: email.trim() || null,
            company: company.trim() || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        contactId = data.id;
      }

      // Sync tags
      if (contactId) {
        await supabase
          .from('contact_tags')
          .delete()
          .eq('contact_id', contactId);

        if (selectedTagIds.length > 0) {
          const tagRows = selectedTagIds.map((tag_id) => ({
            contact_id: contactId!,
            tag_id,
          }));
          const { error: tagError } = await supabase
            .from('contact_tags')
            .insert(tagRows);
          if (tagError) throw tagError;
        }
      }

      toast.success(isEdit ? t('toastSuccessEdit') : t('toastSuccessAdd'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The unique index (migration 022) rejects a duplicate phone that
      // slipped past the on-blur check (race, or a format that
      // normalizes equal). Surface it as the friendly duplicate notice
      // and, for new contacts, point the user at the existing record.
      if (isUniqueViolation(err)) {
        toast.error(t('toastConflict'));
        if (!isEdit && accountId) {
          const existing = await findExistingContact(
            supabase,
            accountId,
            phone.trim()
          );
          if (existing) setDupMatch({ contact: existing, exact: true });
        }
        return;
      }
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('addTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit ? t('editDesc') : t('addDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-name" className="text-muted-foreground">
              {t('nameLabel')}
            </Label>
            <Input
              id="cf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-phone" className="text-muted-foreground">
              {t('phoneLabel')} <span className="text-red-400">*</span>
            </Label>
            <PhoneInput
              id="cf-phone"
              international
              defaultCountry={isBrDeployment() ? 'BR' : undefined}
              value={phone}
              onChange={(value) => {
                setPhone(value ?? '');
                if (dupMatch) setDupMatch(null);
                if (phoneError) setPhoneError(null);
                if (phoneLegacy) setPhoneLegacy(false);
              }}
              onBlur={handlePhoneBlur}
              placeholder={t('phonePlaceholder')}
              inputComponent={Input}
              className="[&_.PhoneInputInput]:bg-muted [&_.PhoneInputInput]:border-border [&_.PhoneInputInput]:text-foreground [&_.PhoneInputInput]:placeholder:text-muted-foreground"
            />
            {phoneError ? (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <p>{phoneError}</p>
              </div>
            ) : dupMatch ? (
              <div
                className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                  dupMatch.exact
                    ? 'border-red-500/40 bg-red-500/10 text-red-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                }`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p>{dupMatch.exact ? t('dupExact') : t('dupSimilar')}</p>
                  {onViewExisting && (
                    <button
                      type="button"
                      onClick={() => onViewExisting(dupMatch.contact.id)}
                      className="font-medium underline underline-offset-2 hover:no-underline"
                    >
                      {t('viewExisting', {
                        name: dupMatch.contact.name || dupMatch.contact.phone,
                      })}
                    </button>
                  )}
                </div>
              </div>
            ) : phoneLegacy ? (
              // D-6: aviso não-bloqueante — número aceito, só pede confirmação.
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <p>{t('phoneLegacyWarning')}</p>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {isBrDeployment() ? t('phoneHintBr') : t('phoneHint')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-email" className="text-muted-foreground">
              {t('emailLabel')}
            </Label>
            <Input
              id="cf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-company" className="text-muted-foreground">
              {t('companyLabel')}
            </Label>
            <Input
              id="cf-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t('companyPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('tagsLabel')}</Label>
            {loadingTags ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-3 animate-spin" />
                {t('loadingTags')}
              </div>
            ) : tags.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {t('noTagsAvailable')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex cursor-pointer items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        selected
                          ? 'ring-primary ring-offset-border ring-2 ring-offset-1'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving || checkingDup || (!isEdit && !!dupMatch?.exact)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('update') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
