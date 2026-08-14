// ============================================================
// Proxy de mídia RECEBIDA do cliente.
//
// O webhook não baixa o arquivo: ele valida o `mediaId` junto à Meta e
// grava em `messages.media_url` uma URL desta rota
// (`/api/whatsapp/media/<mediaId>`). O byte só é buscado quando alguém
// abre a conversa — é aqui.
//
// ⚠️ AUTENTICAR NÃO É AUTORIZAR (F-40-A da SPEC 040).
//
//   Até a 040 esta rota exigia sessão e resolvia a conta do chamador,
//   mas nunca conferia A QUE CONVERSA o `mediaId` pertencia. Como o
//   token usado para falar com a Meta é o da CONTA, qualquer membro
//   autenticado baixava o anexo de QUALQUER conversa da conta — um
//   bypass direto do isolamento por linha que a 039 acabara de
//   estabelecer. O `mediaId` circula em log, em histórico anterior à
//   039 e em exportação, então não era um id difícil de obter.
//
//   A checagem abaixo fecha isso: a mensagem que carrega esta mídia
//   tem de ser visível PARA ESTE USUÁRIO. Quem decide é a RLS da 039
//   (`messages_select` → `can_access_conversation`), não este código —
//   por isso a consulta usa o cliente de SESSÃO, nunca o service role.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // AUTORIZAÇÃO. Precisa vir ANTES de qualquer coisa que custe rede ou
    // toque no token da conta: sem isso, um id sondado ainda consumiria
    // uma chamada à Meta e revelaria, pelo tempo de resposta, se existe.
    //
    // `media_id` é populado pelo webhook e retroativamente pela migração
    // 040; a busca por ele usa `idx_messages_media_id`. Casar pela
    // `media_url` funcionaria igual, mas amarraria a autorização ao
    // formato de uma string de rota — mude o prefixo e a checagem para
    // de casar.
    const { data: owningMessage, error: ownershipError } = await supabase
      .from('messages')
      .select('id')
      .eq('media_id', mediaId)
      .limit(1)
      .maybeSingle();

    if (ownershipError) {
      console.error('[media] ownership lookup failed:', ownershipError.message);
      return NextResponse.json(
        { error: 'Failed to fetch media' },
        { status: 500 }
      );
    }

    // 404 genérico de propósito. Para quem sonda ids, "não existe" e
    // "existe mas não é sua" têm de ser indistinguíveis — mesma regra
    // que `lib/inbox/assignment.ts` aplica em CONVERSATION_NOT_FOUND.
    // Um 403 aqui confirmaria a existência do anexo.
    if (!owningMessage) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 });
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
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

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      );
    }

    const accessToken = decrypt(config.access_token);

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          contentType || mediaInfo.mimeType || 'application/octet-stream',
        // `private`, NÃO `public`: a resposta depende da sessão e de uma
        // checagem de autorização. Com `public`, um cache compartilhado
        // (CDN, proxy corporativo) guardaria o anexo por 24 h e o
        // serviria ao próximo usuário que pedisse a mesma URL —
        // entrega cruzada de anexo entre agentes.
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error);
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    );
  }
}
