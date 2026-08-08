-- ============================================================
-- 047_engagement_dashboard_rpcs.sql — dashboard histórico de
-- engajamento da conta (SPEC 044 §5.2a, fase 5)
--
-- O que falta e por que precisa de banco
--
--   A 046 já responde "COMO ESTÁ ESTA LISTA" (§5.2b):
--   `audience_engagement_summary` recorta a audiência staged do
--   rascunho aberto. O que a fase 5 acrescenta é a outra metade da
--   tela — "COMO VAI A CONTA" (§5.2a): os cards macro (campanhas
--   enviadas, mensagens entregues, taxa de leitura, taxa de resposta,
--   contatos alcançados) e a série de 30 dias do gráfico.
--
--   Nada disso é resolvível no cliente. São agregações sobre
--   `broadcast_recipients` — a maior tabela do módulo — e o caminho
--   ingênuo (baixar as linhas e somar no TS) esbarra no mesmo teto de
--   ~1000 linhas do PostgREST documentado no cabeçalho da 025.
--
-- UMA definição de funil, não três
--
--   `messages_delivered` aqui significa exatamente o que
--   `broadcasts.delivered_count` significa desde a 005: destinatário
--   NO ESTÁGIO 'delivered' OU ALÉM. É uma escada cumulativa —
--   quem respondeu também leu, também entregou, também enviou —, não
--   um contador por estado atual.
--
--   A escada está escrita inline nos dois `FILTER` abaixo em vez de
--   numa função auxiliar, de propósito: uma função chamada por linha
--   sobre milhões de destinatários é o custo que esta migração existe
--   para evitar, e a exceção de `search_path` que tornaria a função
--   inlinável é privativa de `triage_row_matches` (046). O preço da
--   repetição é o risco de divergir da 005 — por isso o bloco 4
--   ASSERTA, na hora de aplicar, que as duas definições concordam.
--
-- O dia de um evento
--
--   `COALESCE(sent_at, created_at)`, não `sent_at` puro. Um
--   destinatário que FALHOU nunca recebe `sent_at`
--   (broadcast-core.ts:359 grava só o status), então uma série
--   agrupada por `sent_at` mostraria zero falhas — justamente a
--   métrica que denuncia problema de qualidade de número. Para a
--   linha que falhou, `created_at` é o instante da tentativa.
--
--   Consequência assumida: os eventos são atribuídos ao dia do ENVIO,
--   não ao dia em que a Meta confirmou a leitura. Uma leitura de hoje
--   sobre uma mensagem de anteontem soma no bucket de anteontem. É a
--   leitura de coorte — "do que saiu naquele dia, quanto foi lido" —
--   que é a pergunta que o gráfico de disparo responde.
--
-- Segurança
--
--   SECURITY DEFINER com guarda `is_account_member` na PRIMEIRA
--   instrução, exatamente como `broadcast_quota_usage` (044) e as
--   `dashboard_*` (039). A RLS de `broadcast_recipients`
--   (017:566-572) escoparia certo, mas força o EXISTS da política
--   linha a linha sobre uma agregação da tabela inteira. Sem a guarda,
--   um DEFINER que recebe `account_id` por parâmetro é um vazamento
--   entre inquilinos: bastaria passar o id de outra conta.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) ÍNDICE DO DIA DO EVENTO
--
-- A 044 criou `idx_broadcast_recipients_sent_at` (parcial, WHERE
-- sent_at IS NOT NULL), que serve à janela de cota — mas não serve a
-- estas duas funções: elas filtram por COALESCE(sent_at, created_at),
-- expressão que o índice parcial não cobre, e cujo ramo NULL é
-- exatamente o que aquele índice exclui.
--
-- Índice por expressão, portanto. Sem ele a série de 30 dias vira seq
-- scan em `broadcast_recipients` a cada abertura da triagem.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_event_at
  ON broadcast_recipients ((COALESCE(sent_at, created_at)));

COMMENT ON INDEX idx_broadcast_recipients_event_at IS
  'Dia do evento do destinatário (envio, ou tentativa quando falhou). Sustenta broadcast_account_stats e broadcast_engagement_series (SPEC 044 §5.2a).';

-- ============================================================
-- 2) CARDS AGREGADOS DA CONTA (§5.2a)
--
-- Uma linha só. `p_since NULL` = desde sempre; a tela passa o mesmo
-- limite de 30 dias do gráfico, para o card e a curva descreverem o
-- MESMO período — um card "desde sempre" ao lado de um gráfico de 30
-- dias é a divergência que faz o usuário achar que o gráfico está
-- errado.
--
-- Taxas NÃO são calculadas aqui. Devolvemos numeradores e
-- denominadores crus e o TS divide: uma taxa em NUMERIC arredondada no
-- SQL perde a informação de que o denominador era 3, e "100 % de
-- leitura" com 3 entregas merece tratamento diferente na tela.
-- Denominador recomendado das duas taxas: `messages_delivered`, que é
-- o degrau anterior no funil de [id]/page.tsx.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_account_stats(
  p_account_id UUID,
  p_since      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  campaigns_total    BIGINT,
  campaigns_sent     BIGINT,
  messages_sent      BIGINT,
  messages_delivered BIGINT,
  messages_read      BIGINT,
  messages_replied   BIGINT,
  messages_failed    BIGINT,
  contacts_reached   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Guarda obrigatória: a função roda como `postgres` (RLS off).
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    -- Campanhas com QUALQUER atividade na janela. Um rascunho de
    -- triagem ainda não tem destinatário nenhum, então não entra
    -- aqui — o que é o desejado: uma lista em triagem não é campanha.
    count(DISTINCT br.broadcast_id),
    count(DISTINCT br.broadcast_id) FILTER (
      WHERE br.status IN ('sent', 'delivered', 'read', 'replied')
    ),
    -- ── Escada cumulativa da 005 (ver cabeçalho) ───────────────
    count(*) FILTER (WHERE br.status IN ('sent', 'delivered', 'read', 'replied')),
    count(*) FILTER (WHERE br.status IN ('delivered', 'read', 'replied')),
    count(*) FILTER (WHERE br.status IN ('read', 'replied')),
    count(*) FILTER (WHERE br.status = 'replied'),
    count(*) FILTER (WHERE br.status = 'failed'),
    -- Contatos ÚNICOS alcançados: a métrica que o tier da Meta conta
    -- (§4.2) e a única que os contadores de `broadcasts` não sabem
    -- dar, porque somar campanhas conta a mesma pessoa duas vezes.
    count(DISTINCT br.contact_id) FILTER (
      WHERE br.contact_id IS NOT NULL
        AND br.status IN ('sent', 'delivered', 'read', 'replied')
    )
  FROM broadcast_recipients br
  JOIN broadcasts b ON b.id = br.broadcast_id
  WHERE b.account_id = p_account_id
    AND (
      p_since IS NULL
      OR COALESCE(br.sent_at, br.created_at) >= p_since
    );
END;
$$;

ALTER FUNCTION public.broadcast_account_stats(UUID, TIMESTAMPTZ) OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon**, separadamente. O Supabase mantém
-- ALTER DEFAULT PRIVILEGES concedendo EXECUTE a `anon` em toda função
-- nova de `public`; essa concessão é NOMINAL, não herdada de PUBLIC,
-- então o revoke de PUBLIC passa ao largo dela. Foi assim que as seis
-- funções da 042 ficaram abertas, e assim que a 044 ficou na primeira
-- aplicação em `vn`. O bloco 4 aborta se algo escapar.
REVOKE ALL ON FUNCTION public.broadcast_account_stats(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_account_stats(UUID, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_account_stats(UUID, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_account_stats(UUID, TIMESTAMPTZ) IS
  'Cards macro do dashboard de engajamento (SPEC 044 §5.2a). Escada cumulativa da 005; taxas ficam no cliente. Guarda is_account_member — DEFINER roda com RLS desligada.';

-- ============================================================
-- 3) SÉRIE HISTÓRICA (§5.2, gráfico de 30 dias)
--
-- Dois cuidados que decidem se o gráfico mente ou não:
--
--   1. LACUNA NÃO É ZERO. `generate_series` + LEFT JOIN devolve toda
--      data do intervalo, mesmo as sem disparo nenhum. Sem isso o
--      recharts liga 12/07 a 19/07 com uma reta e desenha uma semana
--      de atividade que não existiu.
--   2. O DIA É O DA CONTA, não o do servidor. O bucket sai de
--      `AT TIME ZONE p_time_zone` — com o padrão UTC, um disparo das
--      21h de Brasília cairia no dia seguinte e a barra de "ontem"
--      apareceria vazia. A tela passa o fuso do navegador.
--
-- A 039 tomou a decisão OPOSTA (devolver linhas cruas e bucketar no
-- TS) e ela continua certa lá: são dezenas de mensagens por dia. Aqui
-- são dezenas de MILHARES de destinatários, e trafegar isso para somar
-- no cliente é o que a §5.3 proíbe. Por isso o fuso vira parâmetro
-- explícito, em vez de assumido.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_engagement_series(
  p_account_id UUID,
  p_days       INT  DEFAULT 30,
  p_time_zone  TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day                DATE,
  campaigns          BIGINT,
  messages_sent      BIGINT,
  messages_delivered BIGINT,
  messages_read      BIGINT,
  messages_replied   BIGINT,
  messages_failed    BIGINT,
  contacts_reached   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz        TEXT;
  v_today     DATE;
  v_first_day DATE;
  v_start     TIMESTAMPTZ;
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  -- Janela sanitizada: 365 dias de buckets ainda é um gráfico; 10 000
  -- é um scan da tabela inteira disfarçado de parâmetro.
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    p_days := 30;
  END IF;

  -- Fuso desconhecido não aborta: cai em UTC. `AT TIME ZONE` com um
  -- nome inválido levanta 22023, e derrubar o dashboard inteiro por
  -- causa de um `Intl.DateTimeFormat` exótico seria trocar um gráfico
  -- deslocado em três horas por nenhum gráfico.
  v_tz := COALESCE(NULLIF(p_time_zone, ''), 'UTC');
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = v_tz) THEN
    v_tz := 'UTC';
  END IF;

  v_today     := (NOW() AT TIME ZONE v_tz)::DATE;
  v_first_day := v_today - (p_days - 1);
  -- Meia-noite do primeiro dia NO FUSO DA CONTA, de volta para
  -- timestamptz — é este o valor que o índice do bloco 1 enxerga.
  v_start     := v_first_day::TIMESTAMP AT TIME ZONE v_tz;

  RETURN QUERY
  WITH days AS (
    SELECT gs::DATE AS day
    FROM generate_series(
           v_first_day::TIMESTAMP,
           v_today::TIMESTAMP,
           INTERVAL '1 day'
         ) gs
  ),
  events AS (
    SELECT
      ((COALESCE(br.sent_at, br.created_at)) AT TIME ZONE v_tz)::DATE AS day,
      br.broadcast_id,
      br.contact_id,
      br.status
    FROM broadcast_recipients br
    JOIN broadcasts b ON b.id = br.broadcast_id
    WHERE b.account_id = p_account_id
      AND COALESCE(br.sent_at, br.created_at) >= v_start
  ),
  agg AS (
    SELECT
      e.day,
      count(DISTINCT e.broadcast_id) AS campaigns,
      -- Mesma escada da 005 usada em broadcast_account_stats.
      count(*) FILTER (WHERE e.status IN ('sent', 'delivered', 'read', 'replied')) AS messages_sent,
      count(*) FILTER (WHERE e.status IN ('delivered', 'read', 'replied'))         AS messages_delivered,
      count(*) FILTER (WHERE e.status IN ('read', 'replied'))                      AS messages_read,
      count(*) FILTER (WHERE e.status = 'replied')                                 AS messages_replied,
      count(*) FILTER (WHERE e.status = 'failed')                                  AS messages_failed,
      count(DISTINCT e.contact_id) FILTER (
        WHERE e.contact_id IS NOT NULL
          AND e.status IN ('sent', 'delivered', 'read', 'replied')
      )                                                                            AS contacts_reached
    FROM events e
    GROUP BY e.day
  )
  SELECT
    d.day,
    COALESCE(a.campaigns,          0),
    COALESCE(a.messages_sent,      0),
    COALESCE(a.messages_delivered, 0),
    COALESCE(a.messages_read,      0),
    COALESCE(a.messages_replied,   0),
    COALESCE(a.messages_failed,    0),
    COALESCE(a.contacts_reached,   0)
  FROM days d
  LEFT JOIN agg a ON a.day = d.day
  ORDER BY d.day;
END;
$$;

ALTER FUNCTION public.broadcast_engagement_series(UUID, INT, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.broadcast_engagement_series(UUID, INT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_engagement_series(UUID, INT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_engagement_series(UUID, INT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_engagement_series(UUID, INT, TEXT) IS
  'Série diária de engajamento da conta, com dias vazios preenchidos e bucket no fuso informado (SPEC 044 §5.2). Guarda is_account_member — DEFINER roda com RLS desligada.';

-- ============================================================
-- 4) ASSERÇÕES DE FECHAMENTO
--
-- (a) ACL — padrão 042/044/045/046. Um REVOKE que não pegou falha em
--     silêncio e deixa a função aberta a `anon`; melhor abortar.
-- (b) COERÊNCIA DA ESCADA com a 005. Os `FILTER` acima repetem, em
--     SQL, o que `_bcast_cols_for_status` decide em plpgsql. Repetição
--     silenciosa é como duas telas passam a mostrar números
--     diferentes para "entregues" — então a repetição é verificada
--     aqui, status por status, na hora de aplicar a migração.
-- ============================================================
DO $$
DECLARE
  v_abertas TEXT[];
  v_status  TEXT;
  v_cols    TEXT[];
  v_esperado BOOLEAN;
  v_daqui    BOOLEAN;
BEGIN
  -- (a)
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   ORDER BY p.proname)
    INTO v_abertas
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('broadcast_account_stats', 'broadcast_engagement_series')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '047: estas funcoes continuam executaveis por anon: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;

  -- (b) Para cada status, o degrau 'delivered_count' da 005 tem que
  --     coincidir com o IN ('delivered','read','replied') usado aqui.
  --     Vale como prova para os outros degraus: a escada é a mesma
  --     lista, truncada em pontos diferentes.
  FOREACH v_status IN ARRAY ARRAY['pending', 'sent', 'delivered', 'read', 'replied', 'failed'] LOOP
    v_cols     := _bcast_cols_for_status(v_status);
    v_esperado := 'delivered_count' = ANY(v_cols);
    v_daqui    := v_status IN ('delivered', 'read', 'replied');

    IF v_esperado IS DISTINCT FROM v_daqui THEN
      RAISE EXCEPTION
        '047: a escada de status divergiu da 005 no status "%" — _bcast_cols_for_status diz % e as RPCs deste arquivo dizem %. Alinhe os dois antes de seguir, ou o card "entregues" e a pagina da campanha vao mostrar numeros diferentes.',
        v_status, v_esperado, v_daqui
        USING ERRCODE = '55006';
    END IF;
  END LOOP;
END;
$$;
