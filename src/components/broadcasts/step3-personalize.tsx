'use client';

/**
 * Passo 3 do wizard — mapeamento de variáveis, mídia de header e
 * pré-visualização.
 *
 * Por que o miolo virou um componente por variante (SPEC 044 §6.6)
 *
 *   Um teste A/B são dois templates, e dois templates têm placeholders
 *   diferentes: `{{1}}` do primeiro pode ser o nome e o do segundo, a
 *   cidade. Reaproveitar um mapeamento só entre os dois mandaria a
 *   cidade no lugar do nome para metade da audiência — e a tela não
 *   teria como mostrar isso. Cada braço mapeia o próprio template, em
 *   abas; sem teste A/B a aba não aparece e o passo é o de sempre.
 *
 *   As leituras de apoio (campos personalizados e um contato real para o
 *   preview) continuam acontecendo UMA vez, no componente de fora: elas
 *   não dependem do template.
 */

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, ArrowRight, Eye, ImageIcon, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMediaSrc } from '@/lib/storage/use-media-src';
import { TestSendDialog } from '@/components/broadcasts/test-send-dialog';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

type VariableMap = Record<string, VariableMapping>;

interface Step3Props {
  template: MessageTemplate;
  variables: VariableMap;
  onUpdate: (variables: VariableMap) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  /** Variante B do teste A/B (§6.6). `null` = disparo comum. */
  variantTemplate?: MessageTemplate | null;
  variantVariables?: VariableMap;
  onVariantUpdate?: (variables: VariableMap) => void;
  variantHeaderMediaUrl?: string;
  onVariantHeaderMediaUrlChange?: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Os `{{N}}` do corpo, sem repetição e em ordem. */
function placeholdersOf(template: MessageTemplate): string[] {
  const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches)].sort();
}

/**
 * Um placeholder está "sem mapa" quando o usuário não escolheu nem um
 * valor fixo nem uma origem. Bloqueia o "Próximo" — sem isso o disparo
 * sairia com string vazia e confundiria quem recebe.
 */
function unmappedPlaceholders(
  template: MessageTemplate,
  variables: VariableMap
): string[] {
  return placeholdersOf(template).filter((placeholder) => {
    const key = placeholder.replace(/^\{\{|\}\}$/g, '');
    const mapping = variables[key];
    return !mapping || !mapping.value?.trim();
  });
}

type HeaderMediaError = 'missing' | 'invalid' | null;

/**
 * Templates com header IMAGE/VIDEO/DOCUMENT precisam de uma URL de mídia
 * no envio — a Meta exige o componente em toda entrega e recusa o
 * disparo sem ele.
 */
function headerMediaErrorOf(
  template: MessageTemplate,
  headerMediaUrl: string
): HeaderMediaError {
  if (!isMediaHeaderType(template.header_type)) return null;
  const value = headerMediaUrl.trim();
  if (!value) return 'missing';
  if (!isValidHttpUrl(value)) return 'invalid';
  return null;
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/**
 * Miniatura do header. Precisa passar por `useMediaSrc` porque o campo
 * aceita tanto um link externo colado pelo usuário quanto uma URL do
 * nosso bucket `chat-media`, privado desde a migração 040 — esta última
 * só renderiza assinada.
 */
function HeaderImagePreview({ url }: { url: string }) {
  const { src } = useMediaSrc(url);
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Header preview"
      className="border-border mt-3 max-h-40 rounded-lg border object-contain"
    />
  );
}

interface VariantFormProps {
  template: MessageTemplate;
  variables: VariableMap;
  onUpdate: (variables: VariableMap) => void;
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  customFields: CustomField[];
  loadingFields: boolean;
  firstContact: Contact | null;
  firstContactCustomValues: Map<string, string>;
  loadingPreview: boolean;
}

/** O miolo do passo 3, para UM template. */
function VariantForm({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  customFields,
  loadingFields,
  firstContact,
  firstContactCustomValues,
  loadingPreview,
}: VariantFormProps) {
  const t = useTranslations('Broadcasts.wizard');

  const placeholders = useMemo(() => placeholdersOf(template), [template]);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo(
    () => headerMediaErrorOf(template, headerMediaUrl),
    [template, headerMediaUrl]
  );

  const unmappedKeys = useMemo(
    () => unmappedPlaceholders(template, variables),
    [template, variables]
  );

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  return (
    <div className="space-y-6">
      {mediaHeaderType && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="text-primary h-4 w-4" />
            <p className="text-foreground text-sm font-medium">
              {t('personalize.headerImage')}
            </p>
            <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium uppercase">
              {mediaHeaderType}
            </span>
          </div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {t('personalize.imageUrl')}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            {t('personalize.headerImageDesc')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              <HeaderImagePreview url={headerMediaUrl.trim()} />
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-300">
              {headerMediaError === 'missing'
                ? t('personalize.headerMediaMissing')
                : t('personalize.headerMediaInvalid')}
            </p>
          )}
        </div>
      )}

      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="border-border bg-card/50 rounded-xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="border-border bg-card/50 rounded-xl border p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="border-border bg-muted text-foreground w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">
                          {t('personalize.typeStatic')}
                        </SelectItem>
                        <SelectItem value="field">
                          {t('personalize.typeContact')}
                        </SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      {mapping.type === 'static'
                        ? t('personalize.staticValue')
                        : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue
                            placeholder={t('personalize.selectContactField')}
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Eye className="text-primary h-4 w-4" />
            <p className="text-foreground text-sm font-medium">
              {t('personalize.preview')}
            </p>
            <span className="text-muted-foreground text-xs">
              ({previewLabel})
            </span>
            {loadingPreview && (
              <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
            )}
          </div>
          {/* Simulação a seco (SPEC 044 §6.7) — este texto acima é a
              estimativa estática do wizard; o teste manda a mensagem de
              verdade, com a mesma resolução de variáveis do disparo
              real, para contatos reais escolhidos a dedo. */}
          <TestSendDialog
            template={template}
            variables={variables}
            headerMediaUrl={headerMediaUrl}
          />
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] rounded-lg px-3 py-2 shadow-sm">
            <p className="text-primary text-sm whitespace-pre-wrap">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('personalize.unmappedWarning', { keys: unmappedKeys.join(', ') })}
        </div>
      )}
    </div>
  );
}

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  variantTemplate = null,
  variantVariables = {},
  onVariantUpdate,
  variantHeaderMediaUrl = '',
  onVariantHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tAb = useTranslations('Broadcasts.wizard.abTest');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [activeVariant, setActiveVariant] = useState<'A' | 'B'>('A');

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shared = {
    customFields,
    loadingFields,
    firstContact,
    firstContactCustomValues,
    loadingPreview,
  };

  // O "Próximo" olha os DOIS braços. Liberar o passo com a variante B
  // pela metade mandaria `{{1}}` cru para metade da audiência — e a aba
  // com o problema pode nem estar aberta na hora do clique.
  const blockedA =
    unmappedPlaceholders(template, variables).length > 0 ||
    headerMediaErrorOf(template, headerMediaUrl) !== null;
  const blockedB = variantTemplate
    ? unmappedPlaceholders(variantTemplate, variantVariables).length > 0 ||
      headerMediaErrorOf(variantTemplate, variantHeaderMediaUrl) !== null
    : false;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('personalize.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('personalize.subtitle')}
        </p>
      </div>

      {variantTemplate ? (
        <Tabs
          value={activeVariant}
          onValueChange={(v) => setActiveVariant(v as 'A' | 'B')}
        >
          <TabsList>
            <TabsTrigger value="A">
              {tAb('tab', { variant: 'A', template: template.name })}
              {blockedA && <span className="ml-1 text-amber-400">•</span>}
            </TabsTrigger>
            <TabsTrigger value="B">
              {tAb('tab', { variant: 'B', template: variantTemplate.name })}
              {blockedB && <span className="ml-1 text-amber-400">•</span>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="A" className="mt-4">
            <VariantForm
              template={template}
              variables={variables}
              onUpdate={onUpdate}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={onHeaderMediaUrlChange}
              {...shared}
            />
          </TabsContent>

          <TabsContent value="B" className="mt-4">
            <VariantForm
              template={variantTemplate}
              variables={variantVariables}
              onUpdate={onVariantUpdate ?? (() => {})}
              headerMediaUrl={variantHeaderMediaUrl}
              onHeaderMediaUrlChange={
                onVariantHeaderMediaUrlChange ?? (() => {})
              }
              {...shared}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <VariantForm
          template={template}
          variables={variables}
          onUpdate={onUpdate}
          headerMediaUrl={headerMediaUrl}
          onHeaderMediaUrlChange={onHeaderMediaUrlChange}
          {...shared}
        />
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={blockedA || blockedB}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
