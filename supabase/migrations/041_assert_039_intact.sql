-- ============================================================
-- 041_assert_039_intact.sql — trava de integridade do isolamento
--
-- Por que isso existe (SPEC 041, F-41-B)
--
--   A 017 declara ser dona exclusiva das políticas de um conjunto de
--   tabelas e, para ser reexecutável, dropa TODAS as políticas delas
--   antes de recriar as suas (017:361-382). A 039 quebrou essa
--   premissa: ela reescreveu `conversations`, `messages`,
--   `message_reactions`, `contact_notes`, `flow_runs` e
--   `flow_run_events` para isolamento POR LINHA, mantendo os MESMOS
--   NOMES de política.
--
--   Consequência: aplicar a 017 depois da 039 devolve a conta ao
--   modelo plano por conta — qualquer `viewer` volta a ler todas as
--   conversas e todas as mensagens — e não gera erro nenhum. As duas
--   migrações são idempotentes isoladamente e destrutivas em conjunto.
--
--   A 017 ganhou uma guarda que aborta antes de causar o estrago. Esta
--   migração cobre o caso complementar: um banco onde o estrago JÁ
--   aconteceu (a 017 foi reaplicada antes da guarda existir, ou alguém
--   aplicou migrações fora de ordem). Ela não conserta — ela IMPEDE O
--   DEPLOY DE SEGUIR sobre um banco cujo isolamento está desfeito.
--
-- ⚠️ ESTA MIGRAÇÃO FALHA ALTO DE PROPÓSITO.
--
--   Uma falha aqui NÃO é defeito da migração: é a detecção de que o
--   isolamento por linha do Inbox não está em vigor. A correção é
--   reaplicar `039_conversation_assignment.sql` e rodar esta de novo.
--   Registrado no runbook para que ninguém a "conserte" removendo a
--   asserção.
--
-- Num banco onde a 039 nunca foi aplicada, ela é um no-op silencioso:
-- todas as checagens são condicionadas à existência dos objetos da
-- 039, então a cadeia 001→041 roda limpa do zero.
--
-- Idempotente e read-only — seguro reexecutar quantas vezes quiser.
-- ============================================================

DO $$
DECLARE
  v_has_039     BOOLEAN;
  v_broken      TEXT[] := ARRAY[]::TEXT[];
  v_policy_qual TEXT;
BEGIN
  -- Marco da 039: o predicado central. Se ele não existe, a 039 nunca
  -- rodou neste banco e não há nada a assertar.
  v_has_039 := EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'can_access_conversation'
       AND pronamespace = 'public'::regnamespace
  );

  IF NOT v_has_039 THEN
    RAISE NOTICE '041: migracao 039 nao aplicada neste banco — nada a verificar.';
    RETURN;
  END IF;

  -- ---- 1. `conversations_select` precisa CONSULTAR o predicado ----
  --
  -- Este é o teste que pega a reaplicação da 017: ela recria
  -- `conversations_select` com `is_account_member(account_id)` puro,
  -- que não menciona `can_access_conversation`. A função sobrevive
  -- (a 017 não dropa funções), mas fica órfã — visibilidade por linha
  -- desligada, sem nenhum sinal.
  SELECT qual INTO v_policy_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'conversations'
     AND policyname = 'conversations_select';

  IF v_policy_qual IS NULL THEN
    v_broken := v_broken || 'conversations_select nao existe';
  ELSIF v_policy_qual NOT ILIKE '%can_access_conversation%'
        AND v_policy_qual NOT ILIKE '%assigned_agent_id%' THEN
    v_broken := v_broken || 'conversations_select nao aplica visibilidade por linha';
  END IF;

  -- ---- 2. `messages_select` idem ----
  SELECT qual INTO v_policy_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'messages'
     AND policyname = 'messages_select';

  IF v_policy_qual IS NULL THEN
    v_broken := v_broken || 'messages_select nao existe';
  ELSIF v_policy_qual NOT ILIKE '%can_access_conversation%' THEN
    v_broken := v_broken || 'messages_select nao aplica visibilidade por linha';
  END IF;

  -- ---- 3. Os `FOR ALL` da 017 não podem ter voltado ----
  --
  -- Armadilha 1 do cabeçalho da 039: o Postgres combina políticas
  -- permissivas com OR, então um `messages_modify ... FOR ALL`
  -- ressuscitado concede SELECT a qualquer membro da conta e ANULA o
  -- `messages_select` restritivo — sem que nada no `_select` pareça
  -- errado. É o modo de falha mais silencioso dos três.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'messages'
       AND policyname = 'messages_modify'
       AND cmd = 'ALL'
  ) THEN
    v_broken := v_broken || 'messages_modify FOR ALL ressuscitado (anula messages_select)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'message_reactions'
       AND policyname = 'message_reactions_modify'
       AND cmd = 'ALL'
  ) THEN
    v_broken := v_broken || 'message_reactions_modify FOR ALL ressuscitado';
  END IF;

  -- ---- 4. Os RPCs de atribuição continuam existindo ----
  --
  -- Sem eles o app perde o claim atômico e a reatribuição validada, e
  -- volta ao `UPDATE` direto que a 039 eliminou.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'claim_conversation'
       AND pronamespace = 'public'::regnamespace
  ) THEN
    v_broken := v_broken || 'claim_conversation() ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'reassign_conversation'
       AND pronamespace = 'public'::regnamespace
  ) THEN
    v_broken := v_broken || 'reassign_conversation() ausente';
  END IF;

  -- ---- Veredito ----
  IF array_length(v_broken, 1) > 0 THEN
    RAISE EXCEPTION
      'A migracao 039 foi sobrescrita — o isolamento por linha do Inbox NAO esta em vigor. Problemas: %. Causa quase certa: a 017 foi reaplicada depois da 039 (ver F-41-B da SPEC 041). Correcao: reaplique supabase/migrations/039_conversation_assignment.sql e rode esta migracao novamente. NAO remova esta assercao para "destravar" o deploy.',
      array_to_string(v_broken, '; ')
      USING ERRCODE = '55006';
  END IF;

  RAISE NOTICE '041: isolamento por linha da 039 integro.';
END $$;
