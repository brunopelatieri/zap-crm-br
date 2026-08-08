-- ============================================================
-- 050_broadcast_cooldown.sql — cooldown / anti-fadiga (SPEC 044 §6.2)
--
-- O que isto resolve
--
--   "Não enviar marketing ao mesmo contato mais de uma vez a cada N
--   dias." O filtro 'cooldown' já existia desde a 046 (fase 4) — mas
--   como preset OPCIONAL, com "7 dias" cravado em SQL e nenhuma
--   aplicação automática. Este arquivo fecha as duas lacunas que a §6.2
--   ainda deixava abertas:
--
--     1. **Configuração por conta.** `whatsapp_config.broadcast_cooldown_days`
--        substitui o `INTERVAL '7 days'` fixo. Ao contrário da janela de
--        horário (§6.3, deliberadamente constante — ver a decisão
--        daquela seção), a §6.2 pede explicitamente "configuração por
--        conta", e diferentes operadores rodam bases com tolerância a
--        fadiga bem diferente.
--     2. **Aplicado como filtro automático.** As linhas que casam com o
--        cooldown da conta chegam à triagem JÁ desmarcadas — não é mais
--        preciso que o agente lembre de aplicar o preset manualmente. A
--        seleção continua sendo `selected` comum, então nada no envio
--        precisa mudar: `planDashboardBroadcast` já respeita
--        `selected`. A "aplicação automática" é UM UPDATE a mais logo
--        após o INSERT do staging (`stageAudience`, TypeScript), usando
--        a MESMA `triage_set_selection` que a §5.3 já expõe — sem
--        duplicar o predicado em uma segunda linguagem.
--
-- Por que isto NÃO é um bloqueio rígido como o opt-out (§6.8)
--
--   Cooldown é uma heurística de qualidade de número, não uma restrição
--   legal. `planDashboardBroadcast` continua sem tocar em cooldown: uma
--   linha que o agente reselecionou deliberadamente (via override de
--   admin ou clicando na linha) SAI no disparo, exatamente como hoje.
--   Só o padrão de seleção muda.
--
-- Superfície de override
--
--   `triage_set_selection(draftId, true, null, 'cooldown')` já existe
--   desde a 046 — reincluir cooldown em massa não pede RPC nova, só um
--   botão a mais no toolbar, restrito a admin+ na UI (`useCan`). Não há
--   guarda equivalente no banco: o mesmo agente já pode reselecionar
--   QUALQUER linha individual pelo checkbox da tabela (comportamento
--   herdado, também vale para opt-out), então uma guarda só na chamada
--   em massa não fecharia superfície nenhuma — é orientação de produto,
--   não controle de segurança.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) CONFIGURAÇÃO POR CONTA
--
-- Default 7 para não mudar o comportamento de nenhuma conta existente
-- no dia da migração — é o mesmo número que já estava cravado em SQL.
-- 0 é um valor válido e significa "cooldown desativado", não "zero
-- dias de folga" (que combinaria com quase todo mundo por acidente).
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS broadcast_cooldown_days INT NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_cooldown_days_check'
      AND conrelid = 'public.whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_cooldown_days_check
      CHECK (broadcast_cooldown_days >= 0 AND broadcast_cooldown_days <= 90);
  END IF;
END;
$$;

COMMENT ON COLUMN whatsapp_config.broadcast_cooldown_days IS
  'Anti-fadiga (SPEC 044 §6.2): dias sem reenviar marketing ao mesmo contato. 0 = cooldown desativado. Default 7. Editável em Configurações > WhatsApp.';

-- ============================================================
-- 2) PREDICADO DE FILTRO — ganha o parâmetro de dias
--
-- A assinatura MUDA (novo p_cooldown_days), então é DROP + CREATE — a
-- mesma armadilha de sobrecarga que a 048 documentou: um CREATE OR
-- REPLACE aqui criaria uma segunda versão, e o planejador escolheria
-- por tipo de argumento em vez de substituir.
--
-- Continua sem `SET search_path`, pela razão da 046 §3 (repetida na
-- 048 §9): função SQL com cláusula SET não é inlinável, e sem inline
-- vira uma chamada por linha sobre até 50 000 linhas.
-- ============================================================
DROP FUNCTION IF EXISTS public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
);

CREATE OR REPLACE FUNCTION public.triage_row_matches(
  p_filter          TEXT,
  p_search          TEXT,
  r_name            TEXT,
  r_phone           TEXT,
  r_selected        BOOLEAN,
  r_invalid_reason  TEXT,
  r_is_new          BOOLEAN,
  r_campaigns       BIGINT,
  r_has_read        BOOLEAN,
  r_has_replied     BOOLEAN,
  r_failure_count   BIGINT,
  r_last_replied_at TIMESTAMPTZ,
  r_last_sent_at    TIMESTAMPTZ,
  r_opted_out       BOOLEAN,
  p_cooldown_days   INT DEFAULT 7
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    (
      p_search IS NULL
      OR p_search = ''
      OR r_name  ILIKE '%' || p_search || '%'
      OR r_phone ILIKE '%' || p_search || '%'
    )
    AND
    CASE COALESCE(NULLIF(p_filter, ''), 'all')
      WHEN 'all'             THEN TRUE
      WHEN 'selected'        THEN r_selected
      WHEN 'unselected'      THEN NOT r_selected
      WHEN 'valid'           THEN r_invalid_reason IS NULL
      WHEN 'invalid'         THEN r_invalid_reason IS NOT NULL
      WHEN 'new'             THEN r_is_new
      WHEN 'existing'        THEN NOT r_is_new
      -- 🔥 respondeu alguma campanha nos últimos 30 dias
      WHEN 'engaged'         THEN r_last_replied_at >= NOW() - INTERVAL '30 days'
      -- 👀 abre, mas nunca respondeu
      WHEN 'reads_no_reply'  THEN r_has_read AND NOT r_has_replied
      -- 😴 recebeu bastante e nunca abriu
      WHEN 'dormant'         THEN r_campaigns >= 3 AND NOT r_has_read
      WHEN 'never_contacted' THEN r_campaigns = 0
      -- ⚠️ candidato a número morto (§6.4)
      WHEN 'problematic'     THEN r_failure_count >= 2
      -- 💤 em cooldown: recebeu algo dentro da janela CONFIGURADA pela
      --    conta (§6.2). 0 dias = cooldown desativado, ninguém casa.
      WHEN 'cooldown'        THEN
        p_cooldown_days > 0
        AND r_last_sent_at >= NOW() - make_interval(days => p_cooldown_days)
      -- 🚫 pediu para sair (§6.8)
      WHEN 'opted_out'       THEN r_opted_out
      -- ✅ o complemento: quem pode receber marketing E tem número válido
      WHEN 'optable'         THEN NOT r_opted_out AND r_invalid_reason IS NULL
      ELSE FALSE
    END;
$$;

ALTER FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INT
) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INT
) TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INT
) IS
  'Predicado de filtro+busca da triagem. Fonte unica das tres RPCs; ganhou o cooldown configuravel na 050 (§6.2).';

-- ============================================================
-- 3) AS TRÊS CHAMADORAS — resolvem os dias da CONTA e repassam
--
-- Assinatura externa de nenhuma das três muda: `p_cooldown_days` é
-- resolvido DENTRO da função, uma vez por chamada (não por linha), a
-- partir de `whatsapp_config` via o `account_id` do próprio rascunho.
-- Continua CREATE OR REPLACE — sem DROP, porque `RETURNS TABLE` e a
-- lista de parâmetros externos não mudam.
-- ============================================================
CREATE OR REPLACE FUNCTION public.triage_audience_page(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all',
  p_limit    INT  DEFAULT 50,
  p_offset   INT  DEFAULT 0
)
RETURNS TABLE (
  id                 UUID,
  phone              TEXT,
  name               TEXT,
  email              TEXT,
  company            TEXT,
  selected           BOOLEAN,
  invalid_reason     TEXT,
  source_row         INTEGER,
  is_new             BOOLEAN,
  existing_contact_id UUID,
  campaigns_received BIGINT,
  last_delivered_at  TIMESTAMPTZ,
  last_sent_at       TIMESTAMPTZ,
  has_read           BOOLEAN,
  has_replied        BOOLEAN,
  failure_count      BIGINT,
  tag_names          TEXT[],
  opt_in_status      TEXT,
  is_opted_out       BOOLEAN,
  total_count        BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cooldown_days INT;
BEGIN
  PERFORM triage_assert_filter(p_filter);

  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc ON wc.account_id = b.account_id
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    p_limit := 50;
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    p_offset := 0;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*, count(*) OVER() AS total_count
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  )
  SELECT
    f.id, f.phone, f.name, f.email, f.company,
    f.selected, f.invalid_reason, f.source_row,
    f.is_new, f.existing_contact_id,
    f.campaigns_received, f.last_delivered_at, f.last_sent_at,
    f.has_read, f.has_replied, f.failure_count,
    f.tag_names, f.opt_in_status, f.is_opted_out, f.total_count
  FROM filtered f
  ORDER BY f.source_row NULLS LAST, f.created_at, f.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

ALTER FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) IS
  'Uma pagina da tabela de triagem. SECURITY INVOKER. Cooldown resolvido por conta na 050 (§6.2).';

-- ------------------------------------------------------------
-- audience_engagement_summary — mesma resolução de dias, e o
-- `in_cooldown` do card passa a contar na MESMA janela usada pelo
-- filtro (antes o filtro e o contador podiam, em teoria, divergir se
-- alguém trocasse só um dos dois hardcodes).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audience_engagement_summary(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS TABLE (
  total_rows          BIGINT,
  selected_rows       BIGINT,
  valid_rows          BIGINT,
  invalid_rows        BIGINT,
  new_contacts        BIGINT,
  existing_contacts   BIGINT,
  ever_contacted      BIGINT,
  ever_read           BIGINT,
  ever_replied        BIGINT,
  never_delivered     BIGINT,
  problematic         BIGINT,
  in_cooldown         BIGINT,
  opted_out_rows      BIGINT,
  selected_valid_rows BIGINT,
  sendable_rows       BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cooldown_days INT;
BEGIN
  PERFORM triage_assert_filter(p_filter);

  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc ON wc.account_id = b.account_id
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  )
  SELECT
    count(*)                                                          AS total_rows,
    count(*) FILTER (WHERE f.selected)                                AS selected_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NULL)                  AS valid_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NOT NULL)              AS invalid_rows,
    count(*) FILTER (WHERE f.is_new AND f.invalid_reason IS NULL)      AS new_contacts,
    count(*) FILTER (WHERE NOT f.is_new AND f.invalid_reason IS NULL)  AS existing_contacts,
    count(*) FILTER (WHERE f.campaigns_received > 0)                  AS ever_contacted,
    count(*) FILTER (WHERE f.has_read)                                AS ever_read,
    count(*) FILTER (WHERE f.has_replied)                             AS ever_replied,
    count(*) FILTER (
      WHERE NOT f.is_new AND f.last_delivered_at IS NULL
    )                                                                 AS never_delivered,
    count(*) FILTER (WHERE f.failure_count >= 2)                      AS problematic,
    count(*) FILTER (
      WHERE v_cooldown_days > 0
        AND f.last_sent_at >= NOW() - make_interval(days => v_cooldown_days)
    )                                                                 AS in_cooldown,
    count(*) FILTER (WHERE f.is_opted_out)                            AS opted_out_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL
    )                                                                 AS selected_valid_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL AND NOT f.is_opted_out
    )                                                                 AS sendable_rows
  FROM filtered f;
END;
$$;

ALTER FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) IS
  'Agregados da audiencia staged. Cooldown (in_cooldown, e o filtro homonimo) resolvido por conta na 050 (§6.2).';

-- ------------------------------------------------------------
-- triage_set_selection — mesma resolução; é esta função que a §5.4
-- ("remover quem já recebeu nos últimos N dias") e o override de admin
-- da §6.2 usam, chamando com `p_filter = 'cooldown'`.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_set_selection(
  p_draft_id UUID,
  p_selected BOOLEAN,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_changed       BIGINT;
  v_cooldown_days INT;
BEGIN
  IF p_selected IS NULL THEN
    RAISE EXCEPTION 'p_selected is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM triage_assert_filter(p_filter);

  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc ON wc.account_id = b.account_id
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  WITH target AS (
    SELECT v.id
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  ),
  updated AS (
    UPDATE broadcast_audience_staging s
       SET selected = p_selected
      FROM target
     WHERE s.id = target.id
       AND s.selected IS DISTINCT FROM p_selected
    RETURNING s.id
  )
  SELECT count(*) INTO v_changed FROM updated;

  RETURN COALESCE(v_changed, 0);
END;
$$;

ALTER FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) IS
  'Marca/desmarca em massa (§5.3). Com p_filter=cooldown é a acao "remover/incluir quem esta em cooldown" da §6.2/§5.4.';

-- ============================================================
-- 4) ASSERÇÕES — padrão 042/044/045/046/048/049
-- ============================================================
DO $$
DECLARE
  v_abertas TEXT[];
BEGIN
  -- ── Coluna + CHECK de configuração ───────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'broadcast_cooldown_days'
  ) THEN
    RAISE EXCEPTION '050: whatsapp_config.broadcast_cooldown_days nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_cooldown_days_check'
      AND conrelid = 'public.whatsapp_config'::regclass
  ) THEN
    RAISE EXCEPTION '050: CHECK whatsapp_config_cooldown_days_check ausente.';
  END IF;

  -- ── ACL das funções ──────────────────────────────────────────
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   ORDER BY p.proname)
    INTO v_abertas
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('triage_audience_page', 'audience_engagement_summary',
                       'triage_set_selection', 'triage_row_matches')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '050: estas funcoes continuam executaveis por anon: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;

  -- ── Sobrecarga do predicado ──────────────────────────────────
  -- Duas versões de triage_row_matches conviverem é pior do que
  -- nenhuma: o planejador escolheria por tipo de argumento e o filtro
  -- 'cooldown' cairia silenciosamente na versão sem `p_cooldown_days`.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'triage_row_matches') <> 1 THEN
    RAISE EXCEPTION
      '050: existe mais de uma versao de triage_row_matches. O DROP da assinatura de 14 argumentos nao pegou.';
  END IF;
END;
$$;
