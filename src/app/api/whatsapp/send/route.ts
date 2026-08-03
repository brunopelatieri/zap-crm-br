import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { claimConversation } from '@/lib/inbox/assignment';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      // Caminho do objeto no bucket, mandado pelo composer junto da URL
      // (migração 040). É por ele que o envio assina a URL para a Meta e
      // que a bolha exibe a mídia depois — a URL pública deixou de ser
      // buscável quando o bucket virou privado.
      media_path,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body;

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      );
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null;
    // Dono atual da thread, se houver. Decide se este envio REIVINDICA a
    // conversa (está na fila) ou apenas escreve nela (já é minha, ou sou
    // admin respondendo na de outro agente).
    let currentAssignee: string | null = null;

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id, assigned_agent_id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single();

      // Sob a RLS da 039, a conversa de outro agente é invisível — este
      // 404 é a resposta fail-closed correta, e genérica de propósito.
      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      conversationId = data.id;
      currentAssignee = data.assigned_agent_id ?? null;
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        user.id,
        contact_id
      );
      if (!resolved.ok) {
        return NextResponse.json(
          { error: resolved.error },
          { status: resolved.status }
        );
      }
      conversationId = resolved.id;
      currentAssignee = resolved.assignedAgentId;
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // "Quem responde, assume."
    //
    // A ORDEM AQUI É IRREVERSÍVEL: reivindicar ANTES de falar com a Meta.
    // Invertida, o agente que perde a corrida já entregou a mensagem ao
    // cliente numa conversa que pertence a outro — e o WhatsApp não
    // desfaz entrega. Por isso o 409 aborta sem nunca chamar a Meta.
    //
    // Só reivindica quando a thread está na fila. Se já é minha, o claim
    // seria um no-op; se é de outro agente — situação visível apenas para
    // admin/owner — responder NÃO deve roubar a thread de quem atende.
    if (currentAssignee === null) {
      const claim = await claimConversation(supabase, conversationId);
      if (!claim.ok) {
        return NextResponse.json(
          { error: claim.error, code: claim.code },
          { status: claim.status }
        );
      }
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        mediaPath: media_path,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
        // Autoria: este é o caminho com usuário logado. A API pública
        // (/api/v1/messages) omite e grava null — lá não há humano.
        senderId: user.id,
      });

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>;

type FindOrCreateResult =
  | { ok: true; id: string; assignedAgentId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Return the contact's conversation in this account, creating one if it
 * doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string
): Promise<FindOrCreateResult> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, assigned_agent_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      id: existing.id,
      assignedAgentId: existing.assigned_agent_id ?? null,
    };
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      // Nasce já atribuída a quem iniciou: enviar a partir do Contato é,
      // por definição, alguém assumindo o atendimento. Poupa o
      // round-trip do claim logo em seguida — e a política
      // `conversations_insert` (039) aceita `= auth.uid()`.
      assigned_agent_id: userId,
    })
    .select('id, assigned_agent_id')
    .single();

  if (error) {
    // Duas causas, e distinguir importa:
    //   a) perdemos uma corrida — outro envio criou a thread agora;
    //   b) a conversa JÁ EXISTE mas pertence a outro agente, e a RLS da
    //      039 a escondeu do SELECT acima.
    // Nos dois casos o índice único de (account_id, contact_id) da
    // migração 036 rejeita o INSERT. Antes disto, (b) virava um 500
    // opaco ("Failed to open a conversation") — um erro de servidor
    // para o que na verdade é "este contato já está sendo atendido".
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        error: 'This contact is already being handled by another agent',
      };
    }
    console.error(
      'Error creating conversation for contact send:',
      error.message
    );
    return {
      ok: false,
      status: 500,
      error: 'Failed to open a conversation for this contact',
    };
  }

  return {
    ok: true,
    id: created.id,
    assignedAgentId: created.assigned_agent_id ?? null,
  };
}
