// ============================================================
// Cliente Supabase de service-role — canônico.
//
// Existe para o trabalho que roda FORA de uma requisição autenticada:
// webhooks, motores de automação/flows e, desde a SPEC 044 §6.1, o
// fan-out de disparo em `after()`.
//
// Por que o fan-out não pode usar o cliente SSR da requisição
//
//   `createServerClient` (lib/supabase/server.ts) nasce com
//   `autoRefreshToken: false` e guarda o access token daquele request.
//   Um disparo de milhares de destinatários roda por minutos depois da
//   resposta; se o token vencer no meio, TODA atualização de
//   `broadcast_recipients` a partir dali falha em silêncio e os
//   destinatários ficam `pending` para sempre — exatamente a falha que
//   mover o envio para o servidor existe para eliminar.
//
// ⚠️ Este cliente ignora RLS. Use-o só depois de o escopo de conta já
//    ter sido decidido por um caminho que passa por RLS (ex.: as linhas
//    foram criadas com o cliente SSR do usuário e são referenciadas por
//    id), nunca para decidir a quem uma linha pertence.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _adminClient: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}
