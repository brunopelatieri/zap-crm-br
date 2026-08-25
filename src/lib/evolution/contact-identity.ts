/**
 * Vínculo telefone → LID do canal WhatsApp QRCode (SPEC 048 §6.4).
 *
 * `POST /user/info` NÃO traduz LID em telefone (medido — devolve
 * `LID: null`). O vínculo só nasce no sentido telefone → LID, via
 * `POST /user/check`, e é gravado em `contact_identities` — é por essa
 * tabela que um inbound que chegue SÓ com LID casa com o contato certo.
 *
 * Por que isto existe como módulo à parte (e não só dentro do webhook)
 *
 *   O único gatilho original era reativo: um inbound chegar identificado
 *   por TELEFONE (não por LID) disparava o backfill. Isso pressupõe que,
 *   cedo ou tarde, uma mensagem inbound phone-identified vai aparecer —
 *   mas o rollout de privacidade do WhatsApp faz muitos contatos
 *   chegarem SEMPRE por LID em mensagens recebidas, nunca por telefone.
 *   Pra esses contatos o gatilho reativo nunca dispara, e toda mensagem
 *   futura deles é descartada silenciosamente pra sempre (visto em
 *   produção: "remetente só identificável por LID sem vínculo
 *   conhecido" repetido pro mesmo contato, mesmo com conversa já aberta
 *   e funcionando no sentido CRM → contato).
 *
 *   `ensureContactIdentity` fecha essa lacuna sendo chamada nos DOIS
 *   sentidos — pelo webhook (inbound phone-identified, sobra do
 *   comportamento original) e pelo adaptador de envio (outbound,
 *   sempre que sabemos o telefone). No sentido outbound o vínculo nasce
 *   ANTES de o contato precisar responder, então o gatilho reativo nunca
 *   chega a fazer falta.
 *
 * Idempotente: se `contact_identities` já tem uma linha pra este
 * contato neste canal, não bate `/user/check` de novo.
 *
 * ⚠️ Isso pressupõe que o LID de um contato, uma vez aprendido, nunca
 * muda — o SPEC 048 §6.4 não afirma isso explicitamente, e o schema
 * (PK em `account_id, channel_type, external_id`, migração 056) não
 * impede múltiplas linhas por `contact_id`. Se o WhatsApp algum dia
 * reatribuir o LID de um contato (troca de aparelho, reinstalação), a
 * linha antiga não é substituída — este `if` continua pulando pra
 * sempre, e o inbound com o LID novo volta a ser descartado como "sem
 * vínculo conhecido". Não há evidência de que isso aconteça na prática
 * (por isso o trade-off: bater `/user/check` a cada envio custaria uma
 * chamada de rede à Evolution por mensagem), mas se voltar a acontecer
 * em produção, a correção é trocar este `if` por uma reverificação
 * periódica (ex.: um `verified_at` com TTL), não removê-lo.
 *
 * Best-effort e fora do caminho crítico em ambos os chamadores: uma
 * falha aqui custa a resolução de uma futura mensagem só-LID, nunca a
 * mensagem/envio atual.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import { evolutionRequest, unwrap } from './client';
import { readEvolutionConfig } from './config';
import { asRecord, pickString } from './payload';

export async function ensureContactIdentity(params: {
  accountId: string;
  instanceToken: string;
  phone: string;
}): Promise<void> {
  const { accountId, instanceToken, phone } = params;
  try {
    // Antes de qualquer round-trip ao banco: sem Evolution configurada,
    // não há o que fazer — checagem síncrona e de graça.
    const config = readEvolutionConfig();
    if (!config) return;

    const db = supabaseAdmin();

    // `phone_normalized` (migração 022), não a coluna `phone` crua: nem
    // todo caminho de criação de contato sanitiza dígitos antes de
    // gravar (a importação por CSV, por exemplo, grava a célula da
    // planilha como veio — "+55 (19) 99249-6598"). `phone` já chega
    // aqui só-dígitos (o chamador sanitiza), então casar pela coluna
    // gerada é o que funciona independente de como o contato nasceu.
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone_normalized', phone)
      .maybeSingle();
    if (!contact) return;

    const { data: existing } = await db
      .from('contact_identities')
      .select('id')
      .eq('account_id', accountId)
      .eq('channel_type', 'whatsapp_qr')
      .eq('contact_id', contact.id)
      .maybeSingle();
    if (existing) return;

    const raw = await evolutionRequest(config, '/user/check', {
      method: 'POST',
      key: instanceToken,
      body: { number: [phone] },
    });

    const lid = extractLidFromUserCheck(raw);
    if (!lid) return;

    const { error } = await db.from('contact_identities').upsert(
      {
        account_id: accountId,
        contact_id: contact.id,
        channel_type: 'whatsapp_qr',
        external_id: lid,
      },
      { onConflict: 'account_id,channel_type,external_id' }
    );
    if (error) {
      console.error(
        '[evolution] contact_identities upsert failed:',
        error.message
      );
    }
  } catch (err) {
    console.error('[evolution] LID backfill failed:', err);
  }
}

/**
 * `/user/check` não fez parte da sondagem de mensageria da F0 — o
 * exemplo em SPEC 048 §1.2 mostra um objeto plano (`{Query,JID,LID,…}`)
 * para uma consulta; um array por número (mesma forma de `/user/info`)
 * é a alternativa mais provável quando o body pede `number: [...]`.
 * Aceita as duas sem lançar.
 *
 * O envelope `{data:...}` eventual usa `unwrap()` de `client.ts` — o
 * mesmo desembrulho usado no resto do domínio Evolution — em vez de
 * reimplementar a checagem aqui. `unwrap()` devolve `{}` pra array cru,
 * por isso o caso array é tratado à parte, antes.
 */
function extractLidFromUserCheck(raw: unknown): string | null {
  const tryOne = (v: unknown): string | null => {
    const rec = asRecord(v);
    if (!rec) return null;
    return pickString(rec, 'LID', 'lid');
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const lid = tryOne(item);
      if (lid) return lid;
    }
    return null;
  }

  const data = unwrap(raw);
  const direct = tryOne(data);
  if (direct) return direct;

  // Mapa chaveado por JID/telefone (forma de /user/info — R3).
  for (const value of Object.values(data)) {
    const lid = tryOne(value);
    if (lid) return lid;
  }
  return null;
}
