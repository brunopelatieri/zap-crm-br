-- ============================================================
-- 053_session_window_metrics.sql — SPEC 045 fase 5 (§7)
--
-- O problema que isto resolve
--
--   A §7 descreve quatro métricas de reengajamento, e as duas
--   primeiras, como redigidas, exigem cruzar `automation_logs` com
--   `messages` por `contact_id` e faixa de tempo — sem índice que
--   sirva. É caro e chato o bastante para a métrica virar folclore
--   ("acho que está funcionando"). A 052 já criou as colunas que
--   tornam isso barato (`sent_at` / `failed_at` / `reopened_at` em
--   `automation_window_claims`); faltavam duas coisas:
--
--     1. Alguém PREENCHER `reopened_at` — feito no webhook, ver
--        §5.5.5 e o UPDATE em src/app/api/whatsapp/webhook/route.ts.
--        Esta migração cria o índice PARCIAL que torna aquele UPDATE
--        barato o suficiente para rodar a cada mensagem recebida.
--     2. Alguém LER os números com o recorte da conta — a RPC abaixo.
--
-- Por que uma RPC e não uma policy de SELECT
--
--   `automation_window_claims` é service-role-only de propósito
--   (§5.5.2): ela é um LOCK, e abrir escrita seria abrir o mecanismo
--   de concorrência. Uma policy de SELECT resolveria a leitura, mas a
--   métrica mais importante da §7 — descadastro após reengajamento —
--   é um JOIN com `contact_consent_events`, ou seja, precisa de SQL de
--   qualquer forma. Uma RPC entrega as cinco de uma vez, com uma
--   viagem só, e mantém a tabela fechada.
--
-- Recorte temporal
--
--   Não há parâmetro de janela: a varredura purga claims com mais de
--   30 dias (§5.5.2), então "tudo" JÁ É "os últimos 30 dias". Um
--   `p_since` daria a impressão falsa de que existe histórico antes
--   disso.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) ÍNDICE PARCIAL PARA A MARCAÇÃO DE `reopened_at`
--
-- O webhook roda, a cada mensagem recebida, um UPDATE filtrado por
-- `conversation_id` sobre esta tabela. A UNIQUE da 052 é
-- (automation_id, conversation_id, window_anchor) — `conversation_id`
-- NÃO é a coluna líder, então sem este índice aquele UPDATE seria um
-- seq scan por inbound.
--
-- Parcial pelas MESMAS condições do UPDATE: só claims que já enviaram
-- e ainda não reabriram. É o subconjunto que interessa e ele encolhe
-- sozinho — toda linha marcada sai do índice.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_automation_window_claims_awaiting_reopen
  ON automation_window_claims(conversation_id)
  WHERE sent_at IS NOT NULL AND reopened_at IS NULL;

COMMENT ON INDEX idx_automation_window_claims_awaiting_reopen IS
  'Serve o UPDATE de reopened_at no webhook (SPEC 045 §5.5.5). Parcial pelas mesmas condicoes do UPDATE: encolhe sozinho conforme as linhas sao marcadas.';

-- ============================================================
-- 2) RPC DE MÉTRICAS
--
-- SECURITY DEFINER com guarda `is_account_member` na PRIMEIRA
-- instrução, exatamente como `broadcast_account_stats` (047) e as
-- `dashboard_*` (039). A conta NÃO vem por parâmetro — vem da
-- automação, resolvida aqui dentro. Um DEFINER que aceita
-- `account_id` do cliente é um vazamento entre inquilinos esperando
-- acontecer; aceitando `automation_id`, o pior que o chamador pode
-- fazer é apontar para uma automação que não é dele, e aí a guarda
-- recusa.
--
-- Automação inexistente e automação de outra conta devolvem o MESMO
-- erro, de propósito: um erro distinto diria ao chamador se um dado
-- UUID existe.
-- ============================================================
CREATE OR REPLACE FUNCTION public.automation_window_stats(
  p_automation_id UUID
)
RETURNS TABLE (
  claims_total    BIGINT,
  sent            BIGINT,
  failed          BIGINT,
  reopened        BIGINT,
  opted_out_after BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT a.account_id INTO v_account_id
    FROM automations a
   WHERE a.id = p_automation_id;

  IF v_account_id IS NULL OR NOT is_account_member(v_account_id) THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    count(*),
    -- Reengajamentos que de fato saíram para a Meta.
    count(*) FILTER (WHERE c.sent_at IS NOT NULL),
    -- Despachos que lançaram. Separa "a Meta recusou" de "o autor
    -- nunca configurou" — sem isto, a linha "falhas evitadas" da §7
    -- mede adoção e corretude ao mesmo tempo, e não diz qual.
    count(*) FILTER (WHERE c.failed_at IS NOT NULL),
    -- A métrica que a feature inteira existe para mover: o cliente
    -- voltou a escrever dentro de 24h do reengajamento.
    count(*) FILTER (WHERE c.reopened_at IS NOT NULL),
    -- A métrica mais importante das cinco, e a única que mede o RISCO
    -- de §8.1 (mensagem de sessão não passa por revisão da Meta) antes
    -- dele virar queda de quality rating — que é quando já não há o
    -- que fazer. O dado já existia desde a 048; faltava olhar.
    count(*) FILTER (
      WHERE c.sent_at IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM conversations cv
            JOIN contact_consent_events e ON e.contact_id = cv.contact_id
           WHERE cv.id = c.conversation_id
             AND e.status = 'opted_out'
             AND e.source = 'inbound_keyword'
             AND e.created_at >= c.sent_at
             AND e.created_at < c.sent_at + INTERVAL '24 hours'
        )
    )
  FROM automation_window_claims c
  WHERE c.automation_id = p_automation_id;
END;
$$;

ALTER FUNCTION public.automation_window_stats(UUID) OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon**, separadamente. O Supabase mantém
-- ALTER DEFAULT PRIVILEGES concedendo EXECUTE a `anon` em toda função
-- nova de `public`; essa concessão é NOMINAL, não herdada de PUBLIC,
-- então o revoke de PUBLIC passa ao largo dela (foi assim que as seis
-- funções da 042 ficaram abertas). O bloco 3 aborta se escapar.
REVOKE ALL ON FUNCTION public.automation_window_stats(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_window_stats(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.automation_window_stats(UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.automation_window_stats(UUID) IS
  'Metricas de reengajamento de uma automacao session_window_expiring (SPEC 045 §7). Guarda is_account_member — DEFINER roda com RLS desligada. Cobre os ultimos 30 dias por construcao: a varredura purga claims mais antigos.';

-- ============================================================
-- 3) ASSERÇÕES — padrão 042/044/046/047/048/049/050/052
-- ============================================================
DO $$
DECLARE
  v_abertas TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'automation_window_claims'
      AND indexname = 'idx_automation_window_claims_awaiting_reopen'
  ) THEN
    RAISE EXCEPTION '053: idx_automation_window_claims_awaiting_reopen nao foi criado.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'automation_window_stats'
  ) THEN
    RAISE EXCEPTION '053: automation_window_stats nao foi criada.';
  END IF;

  -- A função roda como `postgres` com a RLS desligada: se `anon`
  -- puder executá-la, qualquer visitante lê métricas de qualquer
  -- conta cujo UUID de automação ele adivinhe.
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   ORDER BY p.proname)
    INTO v_abertas
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'automation_window_stats'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '053: automation_window_stats continua executavel por anon: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;
END;
$$;
