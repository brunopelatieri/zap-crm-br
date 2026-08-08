-- ============================================================
-- 046_triage_rpcs.sql — leitura, resumo e seleção em massa da
-- triagem de audiência (SPEC 044 §5.1, §5.3, §5.4, §8.3)
--
-- O problema que estas funções resolvem
--
--   A abordagem ingênua — para cada contato staged, buscar seus
--   `broadcast_recipients` — são 1 198 round-trips para uma audiência
--   de 1 198 linhas; ou um `.in()` que estoura o teto de ~1000 valores
--   do PostgREST, exatamente o problema documentado no cabeçalho da
--   025. E "selecionar todos" não pode virar 50 000 mutações de estado:
--   tem que ser UM comando.
--
-- Como está montado
--
--   Uma VIEW com o enriquecimento (`broadcast_audience_triage`) e três
--   funções que a consomem. A view existe para que "o que é uma linha
--   de triagem" tenha UMA definição: se cada função fizesse o próprio
--   join, "campanhas recebidas" poderia significar coisas diferentes na
--   tabela, no resumo e no filtro de seleção em massa — e a divergência
--   apareceria como "marquei 'nunca contatados' e vieram pessoas que já
--   receberam".
--
--   O PREDICADO de filtro segue a mesma regra: mora em
--   `triage_row_matches`, chamado pelas três. A lista de nomes de
--   filtro válidos mora em `triage_assert_filter`, chamada uma vez por
--   função — um filtro digitado errado ABORTA em vez de virar
--   silenciosamente "todos", que em `triage_set_selection` significaria
--   marcar a audiência inteira por causa de um typo.
--
-- Segurança
--
--   SECURITY INVOKER nas três, como a 025 e como a §5.3 determina: a
--   RLS de `broadcast_audience_staging` (045), `broadcasts` e
--   `broadcast_recipients` (017) já escopa tudo por conta. Sem bypass
--   de privilégio.
--
--   Consequência de desempenho aceita conscientemente: o histórico é
--   lido por LATERAL, um índice-scan por linha staged sobre
--   `idx_broadcast_recipients_contact` (044), em vez de uma agregação
--   única da tabela toda. Sob RLS por linha, a agregação total sairia
--   mais cara — é o mesmo raciocínio que levou a 044 a usar DEFINER
--   para a cota, aplicado na direção oposta porque aqui o conjunto já
--   está limitado aos contatos DAQUELE rascunho.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) VIEW DE ENRIQUECIMENTO
--
-- `security_invoker = true` (PG15+): a view é lida com os privilégios
-- e a RLS de QUEM CHAMA, não do dono. Sem isso ela seria um buraco por
-- onde qualquer autenticado leria o staging de qualquer conta.
-- ============================================================
DROP VIEW IF EXISTS public.broadcast_audience_triage;

CREATE VIEW public.broadcast_audience_triage
WITH (security_invoker = true) AS
SELECT
  s.id,
  s.broadcast_id,
  s.account_id,
  s.phone,
  s.phone_normalized,
  -- O nome da planilha ganha do cadastrado: se o usuário corrigiu na
  -- planilha, é a correção que ele espera ver na triagem.
  COALESCE(NULLIF(s.name, ''), c.name) AS name,
  s.email,
  s.company,
  s.existing_contact_id,
  s.selected,
  s.invalid_reason,
  s.source_row,
  s.created_at,

  (s.existing_contact_id IS NULL) AS is_new,

  -- ── Histórico por contato (§5.1) ────────────────────────────
  COALESCE(h.campaigns_received, 0) AS campaigns_received,
  h.last_delivered_at,
  h.last_sent_at,
  h.last_replied_at,
  COALESCE(h.has_read,    FALSE)    AS has_read,
  COALESCE(h.has_replied, FALSE)    AS has_replied,
  COALESCE(h.failure_count, 0)      AS failure_count,

  COALESCE(t.tag_names, '{}'::TEXT[]) AS tag_names

FROM broadcast_audience_staging s

LEFT JOIN contacts c
  ON c.id = s.existing_contact_id

-- Agregados sempre devolvem exatamente uma linha, então o LEFT JOIN
-- LATERAL com `ON <cond>` é o que produz NULL para número novo (que
-- não tem histórico algum) em vez de zerar tudo por engano.
LEFT JOIN LATERAL (
  SELECT
    -- Só status terminais contam como "campanha recebida": 'pending'
    -- é uma campanha que ainda não saiu, e 'failed' não chegou.
    count(*) FILTER (
      WHERE br.status IN ('sent', 'delivered', 'read', 'replied')
    )                                            AS campaigns_received,
    max(br.delivered_at)                         AS last_delivered_at,
    max(br.sent_at)                              AS last_sent_at,
    max(br.replied_at)                           AS last_replied_at,
    bool_or(br.read_at    IS NOT NULL)           AS has_read,
    bool_or(br.replied_at IS NOT NULL)           AS has_replied,
    count(*) FILTER (WHERE br.status = 'failed') AS failure_count
  FROM broadcast_recipients br
  WHERE br.contact_id = s.existing_contact_id
) h ON s.existing_contact_id IS NOT NULL

LEFT JOIN LATERAL (
  SELECT array_agg(tg.name ORDER BY tg.name) AS tag_names
  FROM contact_tags ct
  JOIN tags tg ON tg.id = ct.tag_id
  WHERE ct.contact_id = s.existing_contact_id
) t ON s.existing_contact_id IS NOT NULL;

ALTER VIEW public.broadcast_audience_triage OWNER TO postgres;

REVOKE ALL ON public.broadcast_audience_triage FROM PUBLIC;
REVOKE ALL ON public.broadcast_audience_triage FROM anon;
GRANT SELECT ON public.broadcast_audience_triage TO authenticated, service_role;

COMMENT ON VIEW public.broadcast_audience_triage IS
  'Linha de triagem enriquecida com o histórico do contato (SPEC 044 §5.1). security_invoker — a RLS de quem chama é que vale.';

-- ============================================================
-- 2) NOMES DE FILTRO VÁLIDOS — lista única
--
-- Chamada UMA vez por função, antes de varrer linha nenhuma. Um nome
-- desconhecido aborta: em `triage_set_selection`, tratar um typo como
-- "sem filtro" marcaria a audiência inteira.
-- ============================================================
CREATE OR REPLACE FUNCTION public.triage_assert_filter(p_filter TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_filter IS NULL OR p_filter = '' THEN
    RETURN; -- ausente = sem filtro, igual a 'all'
  END IF;

  IF p_filter NOT IN (
    -- Estado da linha
    'all', 'selected', 'unselected',
    'valid', 'invalid',
    'new', 'existing',
    -- Presets de engajamento (§6.5)
    'engaged', 'reads_no_reply', 'dormant', 'never_contacted', 'problematic',
    -- Anti-fadiga (§6.2)
    'cooldown'
  ) THEN
    RAISE EXCEPTION 'Unknown triage filter: %', p_filter
      USING ERRCODE = '22023';
  END IF;
END;
$$;

ALTER FUNCTION public.triage_assert_filter(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_assert_filter(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_assert_filter(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_assert_filter(TEXT) TO authenticated, service_role;

-- ============================================================
-- 3) PREDICADO DE FILTRO — fonte única
--
-- SQL puro e STABLE para o planejador poder INLINAR na consulta que
-- chama (um `CASE` embutido, não uma chamada de função por linha).
-- STABLE e não IMMUTABLE porque 'engaged' e 'cooldown' olham `now()`.
--
-- ⚠️ Sem `SET search_path`, ao contrário de todas as outras funções
--    desta SPEC — e de propósito. Uma função SQL com cláusula SET NÃO É
--    INLINÁVEL pelo planejador; ela viraria uma chamada por linha sobre
--    até 50 000 linhas, que é exatamente o custo que a §5.3 existe para
--    evitar. É seguro aqui porque a função é SECURITY INVOKER e o corpo
--    só usa operadores e funções de `pg_catalog` (ILIKE, NOW,
--    COALESCE), que não são resolvidos pelo search_path do chamador.
--    Nenhuma outra função deste arquivo pode copiar esta exceção.
--
-- `ELSE FALSE` é inalcançável para entrada válida — quem valida o nome
-- é `triage_assert_filter`, chamada antes.
-- ============================================================
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
  r_last_sent_at    TIMESTAMPTZ
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
      -- 😴 recebeu bastante e nunca abriu. Mandar marketing para cá é o
      --    caminho mais curto para denúncia de spam — o preset serve
      --    tanto para mirar quanto para EVITAR.
      WHEN 'dormant'         THEN r_campaigns >= 3 AND NOT r_has_read
      WHEN 'never_contacted' THEN r_campaigns = 0
      -- ⚠️ candidato a número morto (§6.4)
      WHEN 'problematic'     THEN r_failure_count >= 2
      -- Em cooldown: recebeu algo nos últimos 7 dias (§6.2)
      WHEN 'cooldown'        THEN r_last_sent_at >= NOW() - INTERVAL '7 days'
      ELSE FALSE
    END;
$$;

ALTER FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Predicado de filtro+busca da triagem. Fonte única, usada pela paginação, pelo resumo e pela seleção em massa.';

-- ============================================================
-- 4) PÁGINA DA TABELA DE TRIAGEM (§5.1, §5.3)
--
-- `count(*) OVER()` é avaliado ANTES do LIMIT, então `total_count` é o
-- total do filtro, não o da página — mesmo truque da 025.
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
  total_count        BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM triage_assert_filter(p_filter);

  -- Limites sanitizados: um p_limit absurdo transformaria "uma página"
  -- em "a audiência inteira pela rede".
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
            v.failure_count, v.last_replied_at, v.last_sent_at
          )
  )
  SELECT
    f.id, f.phone, f.name, f.email, f.company,
    f.selected, f.invalid_reason, f.source_row,
    f.is_new, f.existing_contact_id,
    f.campaigns_received, f.last_delivered_at, f.last_sent_at,
    f.has_read, f.has_replied, f.failure_count,
    f.tag_names, f.total_count
  FROM filtered f
  -- Ordem estável: a da planilha quando houver, e o id como desempate
  -- para a paginação nunca repetir nem pular linha.
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
  'Uma página da tabela de triagem, com histórico por contato e total do filtro. SECURITY INVOKER — RLS de 017/045 faz o escopo.';

-- ============================================================
-- 5) RESUMO DA AUDIÊNCIA (§5.2b)
--
-- O recorte que decide a triagem: "desta lista de 1 198, 842 já
-- receberam campanhas; 61 % leram; 12 % responderam". Uma linha só.
--
-- Aceita o mesmo par filtro+busca da tabela para o resumo poder
-- acompanhar o que está na tela, em vez de descrever sempre o
-- rascunho inteiro.
-- ============================================================
CREATE OR REPLACE FUNCTION public.audience_engagement_summary(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS TABLE (
  total_rows        BIGINT,
  selected_rows     BIGINT,
  valid_rows        BIGINT,
  invalid_rows      BIGINT,
  new_contacts      BIGINT,
  existing_contacts BIGINT,
  ever_contacted    BIGINT,
  ever_read         BIGINT,
  ever_replied      BIGINT,
  never_delivered   BIGINT,
  problematic       BIGINT,
  in_cooldown       BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM triage_assert_filter(p_filter);

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at
          )
  )
  SELECT
    count(*)                                                          AS total_rows,
    count(*) FILTER (WHERE f.selected)                                AS selected_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NULL)                  AS valid_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NOT NULL)              AS invalid_rows,
    -- "Novos" e "existentes" contam só linhas VÁLIDAS. Uma linha
    -- inválida tem `is_new = true` (de fato não é contato), mas nunca
    -- vai virar um: incluí-la faria o card prometer "2 contatos novos"
    -- quando só 1 será criado. O flag por linha continua sendo o fato
    -- cru; é o agregado que precisa responder à pergunta do usuário.
    count(*) FILTER (WHERE f.is_new AND f.invalid_reason IS NULL)      AS new_contacts,
    count(*) FILTER (WHERE NOT f.is_new AND f.invalid_reason IS NULL)  AS existing_contacts,
    count(*) FILTER (WHERE f.campaigns_received > 0)                  AS ever_contacted,
    count(*) FILTER (WHERE f.has_read)                                AS ever_read,
    count(*) FILTER (WHERE f.has_replied)                             AS ever_replied,
    -- "Nunca entregou" só faz sentido para quem JÁ é contato: um número
    -- novo não é uma falha de entrega, é alguém que nunca foi tentado.
    count(*) FILTER (
      WHERE NOT f.is_new AND f.last_delivered_at IS NULL
    )                                                                 AS never_delivered,
    count(*) FILTER (WHERE f.failure_count >= 2)                      AS problematic,
    count(*) FILTER (
      WHERE f.last_sent_at >= NOW() - INTERVAL '7 days'
    )                                                                 AS in_cooldown
  FROM filtered f;
END;
$$;

ALTER FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) IS
  'Agregados da audiência staged, respeitando o mesmo filtro+busca da tabela (SPEC 044 §5.2b).';

-- ============================================================
-- 6) SELEÇÃO EM MASSA (§5.3, §5.4)
--
-- A §5.3 é explícita: "selecionar todos" NÃO carrega todas as páginas —
-- vira um UPDATE server-side sobre o rascunho com o mesmo predicado de
-- filtro. Selecionar 50 000 linhas é um comando, não 50 000 mutações
-- de estado no cliente.
--
-- Não estava no esboço da §8.3, que nomeia só as duas funções de
-- leitura. Entra aqui porque sem ela a §5.3 não é implementável sem uma
-- migração extra — mesma lógica com que a 044 absorveu a RPC de cota
-- que estava listada na 046.
--
-- Idempotente por natureza (marcar o já marcado não muda nada) e
-- SECURITY INVOKER: é a política `bas_modify` da 045 que exige `agent`.
-- ============================================================
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
  v_changed BIGINT;
BEGIN
  IF p_selected IS NULL THEN
    RAISE EXCEPTION 'p_selected is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM triage_assert_filter(p_filter);

  WITH target AS (
    SELECT v.id
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at
          )
  ),
  updated AS (
    UPDATE broadcast_audience_staging s
       SET selected = p_selected
      FROM target
     WHERE s.id = target.id
       -- Só toca no que realmente muda: mantém o UPDATE barato e não
       -- gera escrita à toa num rascunho de 50 000 linhas.
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
  'Marca/desmarca em massa as linhas que casam com filtro+busca. Um comando em vez de N mutações (SPEC 044 §5.3).';

-- ============================================================
-- 7) ASSERÇÃO DE FECHAMENTO — padrão 042/044/045
--
-- Nenhuma destas é SECURITY DEFINER, mas o default privilege do
-- Supabase concede EXECUTE a `anon` do mesmo jeito, e a view herdaria
-- SELECT para `anon` pela mesma via. Sob security_invoker a RLS ainda
-- barraria a leitura — mas depender de uma segunda camada quando a
-- primeira deveria estar fechada é como as seis funções da 042 ficaram
-- abertas. Falha alto se algo passou.
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
     AND p.proname IN ('triage_audience_page', 'audience_engagement_summary',
                       'triage_set_selection', 'triage_row_matches',
                       'triage_assert_filter')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '046: estas funcoes continuam executaveis por anon: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;

  IF has_table_privilege('anon', 'public.broadcast_audience_triage', 'SELECT') THEN
    RAISE EXCEPTION
      '046: a view broadcast_audience_triage continua legivel por anon.';
  END IF;

  IF NOT (
    SELECT c.reloptions::TEXT LIKE '%security_invoker=%true%'
    FROM pg_class c
    WHERE c.oid = 'public.broadcast_audience_triage'::regclass
  ) THEN
    RAISE EXCEPTION
      '046: a view broadcast_audience_triage NAO esta com security_invoker — ela leria o staging de qualquer conta.';
  END IF;
END;
$$;
