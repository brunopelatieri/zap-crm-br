/**
 * Catálogo de campos exportáveis (SPEC 051 §2).
 *
 * A ORDEM DESTE ARRAY É A ORDEM CANÔNICA DAS COLUNAS no arquivo exportado
 * — nunca a ordem em que o usuário marcou os checkboxes no modal. É por
 * isso que `buildContactExportMatrix` (`export-serialize.ts`) itera sobre
 * `CONTACT_EXPORT_FIELDS`, filtrando pelo que foi pedido, em vez de
 * iterar sobre a lista de ids recebida da rota.
 */

export type ContactExportFieldId =
  | 'name'
  | 'phone'
  | 'email'
  | 'tags'
  | 'company'
  | 'created_at'
  | 'channels'
  | 'custom_fields'
  | 'notes'
  | 'phone_e164'
  | 'whatsapp_status'
  | 'consent'
  | 'last_interaction';

export interface ContactExportField {
  id: ContactExportFieldId;
  group: 'basic' | 'extra' | 'advanced';
  /** Marcado ao abrir o modal. */
  defaultOn: boolean;
  /** Não pode ser desmarcado (identidade do contato). */
  locked?: boolean;
  /** Gera N colunas conforme os dados (etiquetas, canais, campos personalizados). */
  dynamic?: boolean;
}

export const CONTACT_EXPORT_FIELDS: ContactExportField[] = [
  { id: 'name', group: 'basic', defaultOn: true },
  { id: 'phone', group: 'basic', defaultOn: true, locked: true },
  { id: 'email', group: 'basic', defaultOn: true },
  { id: 'tags', group: 'basic', defaultOn: true, dynamic: true },
  { id: 'company', group: 'extra', defaultOn: false },
  { id: 'created_at', group: 'extra', defaultOn: false },
  { id: 'channels', group: 'extra', defaultOn: false, dynamic: true },
  { id: 'custom_fields', group: 'extra', defaultOn: false, dynamic: true },
  { id: 'notes', group: 'extra', defaultOn: false },
  { id: 'phone_e164', group: 'advanced', defaultOn: false },
  { id: 'whatsapp_status', group: 'advanced', defaultOn: false },
  { id: 'consent', group: 'advanced', defaultOn: false },
  { id: 'last_interaction', group: 'advanced', defaultOn: false },
];

export const CONTACT_EXPORT_FIELD_IDS: ReadonlySet<ContactExportFieldId> =
  new Set(CONTACT_EXPORT_FIELDS.map((field) => field.id));

export const DEFAULT_CONTACT_EXPORT_FIELDS: ContactExportFieldId[] =
  CONTACT_EXPORT_FIELDS.filter((field) => field.defaultOn).map(
    (field) => field.id
  );

/** O campo travado — identidade do contato, sempre presente na exportação. */
export const LOCKED_CONTACT_EXPORT_FIELD: ContactExportFieldId =
  CONTACT_EXPORT_FIELDS.find((field) => field.locked)!.id;

export function isContactExportFieldId(
  value: string
): value is ContactExportFieldId {
  return CONTACT_EXPORT_FIELD_IDS.has(value as ContactExportFieldId);
}

/**
 * Ordena ids de campo pela ordem canônica do catálogo, descartando
 * desconhecidos e duplicados. Garante que `phone` (identidade do
 * contato) esteja sempre presente, mesmo que o chamador não o inclua.
 */
export function sortContactExportFields(
  fieldIds: ContactExportFieldId[]
): ContactExportFieldId[] {
  const requested = new Set(fieldIds);
  requested.add(LOCKED_CONTACT_EXPORT_FIELD);
  return CONTACT_EXPORT_FIELDS.filter((field) => requested.has(field.id)).map(
    (field) => field.id
  );
}
