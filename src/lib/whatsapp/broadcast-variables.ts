/**
 * Resolução das variáveis de template por destinatário.
 *
 * Veio de `useBroadcastSending` quando o envio migrou para o servidor
 * (SPEC 044 §6.1). Continua sendo lógica pura + uma leitura em lote:
 * nada aqui depende de rodar no navegador, e é justamente por isso que
 * dava para mover sem reescrever.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Contact } from '@/types';

/**
 * Mapeamento de variáveis — cada placeholder do template (pela chave,
 * normalmente "1", "2", …) é resolvido no momento do envio. `field`
 * aponta para um campo nativo do contato (name/phone/email/company);
 * `custom_field` aponta para uma linha de `contact_custom_values`
 * chaveada pelo `custom_fields.id` guardado em `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

/** contactId → (customFieldId → valor). */
export type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Resolve os placeholders para UM contato. Estáticos e campos nativos
 * resolvem de forma síncrona; campos personalizados leem do índice
 * pré-montado, para o laço de envio não fazer N+1.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>
): string[] {
  // As chaves são tipicamente "1","2",… — a ordenação numérica mantém
  // {{1}} antes de {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Lê `contact_custom_values` em lote para um conjunto de contatos.
 *
 * Pagina o `.in(...)`: o PostgREST corta a cláusula IN por volta de
 * 1000 valores, então uma audiência de planilha com 5 000 linhas
 * casaria só o primeiro pedaço e o resto viria com variável vazia.
 */
export async function fetchCustomValueIndex(
  db: SupabaseClient,
  contactIds: string[]
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await db
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

/**
 * True quando o mapeamento usa pelo menos um campo personalizado — o
 * único caso em que vale pagar a leitura em lote acima.
 */
export function usesCustomFields(
  variables: Record<string, VariableMapping>
): boolean {
  return Object.values(variables).some((v) => v.type === 'custom_field');
}
