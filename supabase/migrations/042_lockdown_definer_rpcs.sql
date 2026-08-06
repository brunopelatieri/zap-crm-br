-- ============================================================
-- 042_lockdown_definer_rpcs.sql — fecha RPCs SECURITY DEFINER
-- que o PostgREST expõe a `anon` e `authenticated`
--
-- Por que isso existe
--
--   Toda função em `public` com EXECUTE para `anon` é chamável por
--   qualquer pessoa que tenha a anon key — e a anon key está no bundle
--   JS servido publicamente. Uma função `SECURITY DEFINER` roda com os
--   privilégios do owner (`postgres`), o que significa **RLS
--   desligada**. As duas coisas juntas transformam a função num buraco
--   que ignora todo o isolamento por conta construído na 017 e o
--   isolamento por linha construído na 039.
--
--   O padrão correto já existe neste banco: `increment_flow_execution_count`
--   e `increment_automation_execution_count` (DEFINER) têm ACL apenas
--   para `postgres` e `service_role`. As seis funções abaixo escaparam
--   dele e ficaram com o GRANT default (PUBLIC), herdado por `anon`.
--
-- O que foi confirmado contra o banco real antes de escrever isto
--
--   Chamando como `anon` (sem JWT), dentro de uma transação abortada:
--
--     record_webhook_failure      → EXECUTOU
--     _bcast_bump                 → EXECUTOU
--     recompute_broadcast_counts  → EXECUTOU
--     claim_ai_reply_slot         → EXECUTOU
--
--   Para contraste, as DEFINER que validam `auth.uid()` internamente
--   recusaram corretamente (`remove_account_member`, `set_member_role`,
--   `transfer_account_ownership`, `dashboard_counts` → "Unauthorized"),
--   e o SELECT direto por `anon` em `conversations`/`messages`/`contacts`
--   devolveu 0 linhas. O problema é restrito às funções abaixo.
--
-- Impacto de cada uma, se explorada
--
--   merge_duplicate_contacts()      Sem argumentos e SEM filtro de conta:
--   merge_duplicate_conversations() varrem TODAS as contas e fazem merge
--                                   destrutivo (re-point de filhos +
--                                   DELETE dos perdedores). Um anônimo
--                                   dispara uma consolidação global de
--                                   todos os inquilinos. É a pior das seis.
--
--   record_webhook_failure()        Incrementa failure_count e, no teto,
--                                   grava is_active = false. Um anônimo
--                                   desliga a integração de webhook de
--                                   qualquer conta chamando N vezes.
--
--   claim_ai_reply_slot()           Incrementa conversations.ai_reply_count.
--                                   Um anônimo esgota a cota de auto-reply
--                                   de qualquer conversa e cala a IA nela.
--
--   _bcast_bump()                   UPDATE em coluna de `broadcasts` via
--   recompute_broadcast_counts()    format(%I). Corrompe os contadores de
--                                   qualquer disparo em massa.
--
-- Por que revogar é seguro (quem chama de verdade)
--
--   claim_ai_reply_slot     src/lib/ai/auto-reply.ts:187 — via supabaseAdmin() (service_role)
--   record_webhook_failure  src/lib/webhooks/deliver.ts:154 — dispatchWebhookEvent é sempre
--                           chamado com supabaseAdmin() (webhook/route.ts:455,629,869)
--   _bcast_bump             só de dentro de broadcast_recipient_aggregate_trigger,
--                           que é DEFINER com owner postgres — a checagem de EXECUTE
--                           usa o owner, não o chamador
--   recompute_broadcast_counts  rede de segurança manual (005:28); nenhum call site no app
--   merge_duplicate_*       manutenção pontual das migrações 022 e 036; nenhum call site no app
--
--   `grep -rn` em src/, scripts/ e mcp-server/ não encontra nenhuma
--   chamada dessas funções pelo cliente do browser.
--
-- ⚠️ Esta migração NÃO altera nenhuma policy de RLS. O isolamento da
--    039 foi verificado contra o banco real (19/19 asserções estruturais,
--    10/10 da matriz por papel, 7/7 de claim/reassign) e está intacto —
--    mexer nele aqui só adicionaria risco.
--
-- Idempotente: REVOKE/GRANT são declarativos, seguro reexecutar.
-- ============================================================

DO $$
DECLARE
  v_fn      TEXT;
  v_fns     TEXT[] := ARRAY[
    'public.merge_duplicate_contacts()',
    'public.merge_duplicate_conversations()',
    'public.record_webhook_failure(uuid, integer)',
    'public.claim_ai_reply_slot(uuid, integer)',
    'public._bcast_bump(uuid, text, integer)',
    'public.recompute_broadcast_counts(uuid)'
  ];
  v_faltando TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    -- Uma função ausente não pode abortar o deploy: nem todo banco
    -- passou por todas as migrações que as criam (003/005/022/028/029/036).
    IF to_regprocedure(v_fn) IS NULL THEN
      v_faltando := v_faltando || v_fn;
      CONTINUE;
    END IF;

    -- PUBLIC primeiro: `anon` e `authenticated` herdam dele, e revogar
    -- só dos dois papéis deixaria o buraco aberto para qualquer papel
    -- novo criado depois.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);

    -- O backend (rotas de API Next.js) fala com o banco por service_role.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);

    RAISE NOTICE '042: lockdown aplicado em %', v_fn;
  END LOOP;

  IF array_length(v_faltando, 1) > 0 THEN
    RAISE NOTICE '042: funcoes ausentes neste banco (ignoradas): %',
      array_to_string(v_faltando, ', ');
  END IF;
END $$;


-- ============================================================
-- Asserção de fechamento — falha alto se alguma sobrou aberta.
--
-- Sem isto, um REVOKE que não pegou (assinatura diferente da esperada,
-- por exemplo) passaria silencioso e a migração daria "sucesso" sobre
-- um banco ainda exposto.
-- ============================================================

DO $$
DECLARE
  v_abertas TEXT[];
BEGIN
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   ORDER BY p.proname)
    INTO v_abertas
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('merge_duplicate_contacts', 'merge_duplicate_conversations',
                       'record_webhook_failure', 'claim_ai_reply_slot',
                       '_bcast_bump', 'recompute_broadcast_counts')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '042: estas RPCs SECURITY DEFINER continuam executaveis por anon/authenticated: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;

  RAISE NOTICE '042: nenhuma RPC DEFINER de escrita exposta a anon/authenticated.';
END $$;
