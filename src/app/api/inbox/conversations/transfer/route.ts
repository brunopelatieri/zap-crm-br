import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { claimConversation } from '@/lib/inbox/assignment';
import { findOrCreateInboxConversation } from '@/lib/inbox/find-or-create-conversation';
import { isOptedOut } from '@/lib/contacts/consent';
import { evaluateTransferChannel } from '@/lib/channels/transfer';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import type { ChannelStatus, ChannelType } from '@/lib/channels/types';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

/**
 * Continuar a conversa por outro canal (SPEC 056 §4.2).
 *
 * O que esta rota faz que `/api/whatsapp/send` não faz
 *
 *   Enviar pelo canal B **é** transferir para o canal B: a resposta do
 *   cliente volta para o número que enviou, e `ingest.ts` a roteia por
 *   `(conta, contato, canal)`. Por isso a mensagem nasce na thread do
 *   canal de DESTINO — não na de origem com um selo — e o operador é
 *   levado junto (§1.1). Escrever na thread de origem partiria a
 *   conversa em silêncio: pergunta numa, resposta noutra.
 *
 *   A consequência prática é que o núcleo de envio não muda em nada:
 *   resolvida a thread de destino, `sendMessageToConversation` já sai
 *   pelo número certo sozinho, porque resolve o canal PELA CONVERSA
 *   (F4.1 da SPEC 048). Esta rota é resolução + guardas; a entrega é a
 *   de sempre.
 *
 * As duas guardas que o envio comum NÃO tem
 *
 *   1. Elegibilidade do destino (§4.3) — conectado, sabe texto, e, se
 *      for um canal com janela de 24h, com a janela ABERTA (D-3). Sem
 *      isso, o sentido QR→Oficial ofereceria um botão que quase sempre
 *      leva a uma cobrança de template não pedida.
 *   2. Opt-out (D-4). Responder alguém que saiu do marketing é
 *      legítimo; **resgatá-lo por um número que ele não reconhece** é
 *      iniciar contato, que é o ato que o opt-out existe para impedir.
 *      É a única exceção — o composer comum segue sem verificar.
 *
 * A ordem das guardas é parte do contrato: as duas rodam ANTES do
 * find-or-create, para que uma recusa não deixe uma thread nascida para
 * uma mensagem que nunca sairia.
 */
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

    // Bucket própria, com o mesmo teto do envio: transferir é um envio,
    // mas não deve consumir a cota de quem está atendendo normalmente.
    const limit = checkRateLimit(`transfer:${user.id}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

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
      conversation_id: sourceConversationId,
      channel_id: targetChannelId,
      text,
    } = body as {
      conversation_id?: string;
      channel_id?: string;
      text?: string;
    };

    if (!sourceConversationId || !targetChannelId || !text?.trim()) {
      return NextResponse.json(
        {
          error:
            'conversation_id, channel_id and a non-empty text are required',
          code: 'bad_request',
        },
        { status: 400 }
      );
    }

    // ---- thread de ORIGEM ----------------------------------------
    // Sob a RLS da 039, a conversa de outro agente é invisível — o 404
    // genérico é a resposta fail-closed correta.
    const { data: source, error: sourceErr } = await supabase
      .from('conversations')
      .select('id, contact_id, channel_id')
      .eq('id', sourceConversationId)
      .eq('account_id', accountId)
      .single();

    if (sourceErr || !source) {
      return NextResponse.json(
        { error: 'Conversation not found', code: 'not_found' },
        { status: 404 }
      );
    }

    // ---- guarda 1: consentimento (D-4) ---------------------------
    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('id, opt_in_status')
      .eq('id', source.contact_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (contactErr || !contact) {
      return NextResponse.json(
        { error: 'Contact not found', code: 'not_found' },
        { status: 404 }
      );
    }

    if (isOptedOut(contact)) {
      return NextResponse.json(
        {
          error:
            'This contact opted out — reaching them from another number is not allowed',
          code: 'contact_opted_out',
        },
        { status: 403 }
      );
    }

    // ---- guarda 2: elegibilidade do destino (§4.3) ---------------
    const { data: channelRow, error: channelErr } = await supabase
      .from('channels')
      .select('id, name, type, status')
      .eq('id', targetChannelId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (channelErr || !channelRow) {
      // 400, nunca 404: um 404 confirmaria que o id existe em OUTRA
      // conta (mesma postura da API pública, SPEC 049 §5.4).
      return NextResponse.json(
        { error: 'Channel not found', code: 'bad_request' },
        { status: 400 }
      );
    }

    const targetType = channelRow.type as ChannelType;

    // A janela do DESTINO, e só quando ele tem regra de janela. A
    // âncora vem da thread do contato NAQUELE canal; sem thread (ou com
    // ela invisível pela RLS de outro agente) fica `null`, que
    // `evaluateTransferChannel` trata como fechada — recusar de menos
    // é o lado seguro aqui, porque o outro lado é uma cobrança de
    // template que o operador não pediu.
    const { data: targetThread, error: targetThreadErr } = await supabase
      .from('conversations')
      .select('last_customer_message_at')
      .eq('account_id', accountId)
      .eq('contact_id', source.contact_id)
      .eq('channel_id', targetChannelId)
      .maybeSingle();

    // Não aborta a requisição — o índice único da 059 garante no máximo
    // uma linha, então "sem thread" (a leitura acima já cobre isso) e
    // "erro de verdade" são igualmente raros e o lado seguro é o mesmo:
    // negar a transferência. Mas um erro de infraestrutura não pode
    // ficar indistinguível de "canal legitimamente sem janela aberta"
    // nos logs — é a diferença entre um operador tentar de novo e um
    // engenheiro descobrir que o Supabase estava fora do ar.
    if (targetThreadErr) {
      console.error(
        '[transfer] failed to read target channel session window:',
        targetThreadErr.message
      );
    }

    const evaluation = evaluateTransferChannel(
      {
        id: channelRow.id,
        name: channelRow.name,
        type: targetType,
        status: channelRow.status as ChannelStatus,
        sessionWindow: resolveSessionWindow(
          targetType,
          targetThread?.last_customer_message_at
            ? new Date(targetThread.last_customer_message_at)
            : null
        ),
      },
      source.channel_id
    );

    if (!evaluation.eligible) {
      return NextResponse.json(
        {
          error: `Channel "${channelRow.name}" cannot receive this conversation`,
          code: evaluation.reason,
        },
        { status: 400 }
      );
    }

    // ---- thread de DESTINO ---------------------------------------
    // Nasce ANTES do envio, e é o que dispensa o parâmetro de canal
    // explícito de `sendAndPersistOutbound` (§1.3). Falhando o envio
    // logo abaixo, esta thread permanece vazia — inerte, porque sem
    // `last_message_at` ela não aparece na lista, e reaproveitada na
    // próxima tentativa pelo índice único da 059 (§4.2).
    const target = await findOrCreateInboxConversation(
      supabase,
      accountId,
      user.id,
      source.contact_id,
      targetChannelId
    );
    if (!target.ok) {
      return NextResponse.json(
        { error: target.error, code: 'conflict' },
        { status: target.status }
      );
    }

    // "Quem responde, assume" — mesma ordem irreversível da rota de
    // envio: reivindicar antes de falar com o provedor. Só reivindica
    // se a thread estava na fila; a de outro agente (visível a
    // admin/owner) não é tomada.
    if (target.assignedAgentId === null) {
      const claim = await claimConversation(supabase, target.id);
      if (!claim.ok) {
        return NextResponse.json(
          { error: claim.error, code: claim.code },
          { status: claim.status }
        );
      }
    }

    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId: target.id,
        messageType: 'text',
        contentText: text.trim(),
        senderId: user.id,
        // SPEC 049 §6.2, D-1: conta na cota, nunca bloqueia. Esta ação é
        // o vetor de envio frio mais provável do sistema — deixá-la fora
        // da contagem faria a cota parar de descrever o número.
        coldSendOrigin: 'human',
      });

      return NextResponse.json({
        success: true,
        // O que a UI usa para navegar até a thread de destino (§4.2).
        conversation_id: target.id,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status, headers: err.headers }
        );
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in channel transfer POST:', error);
    return NextResponse.json(
      { error: 'Failed to transfer the conversation' },
      { status: 500 }
    );
  }
}
