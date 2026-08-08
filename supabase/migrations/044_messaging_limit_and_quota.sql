-- ============================================================
-- 044_messaging_limit_and_quota.sql — tier de mensageria da Meta
-- e consumo de cota nas últimas 24 h
--
-- Por que isto existe
--
--   Nada no CRM sabe hoje qual é o limite de mensageria da conta na
--   Meta. O wizard de disparo deixa montar uma audiência de qualquer
--   tamanho e só descobre o teto quando a Graph API começa a rejeitar
--   — no meio do envio, com parte da campanha entregue e parte não.
--
--   Duas peças aqui:
--
--     1. Cache do tier em `whatsapp_config`. A rota
--        /api/whatsapp/messaging-limit consulta a Meta no máximo a
--        cada 15 min e guarda o resultado. Persistir em coluna (e não
--        só em memória) é o que faz o medidor sobreviver a um restart
--        do processo — cenário normal no self-host single-instance —
--        e o que dá um valor de fallback quando a Graph API está fora.
--
--     2. RPC `broadcast_quota_usage`. O tier NÃO é um teto por
--        disparo: é uma janela deslizante de 24 h sobre clientes
--        únicos iniciados pelo negócio. Três disparos de 400 contatos
--        no mesmo dia estouram um TIER_1K mesmo cada um estando
--        "dentro do limite". Só o banco sabe responder quantos
--        contatos distintos já foram alcançados na janela.
--
-- Aproximação assumida
--
--   Contamos destinatários com `sent_at` nas últimas 24 h. A Meta
--   conta pela contabilidade de conversas dela, que não é
--   exatamente a nossa (uma conversa aberta pelo cliente não
--   consome cota de marketing, por exemplo). Por isso a aplicação
--   trabalha com margem de segurança sobre este número, em vez de
--   tratá-lo como exato — ver `computeQuota` em
--   src/lib/whatsapp/messaging-limit.ts.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) CACHE DO TIER
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS messaging_limit_tier       TEXT,
  ADD COLUMN IF NOT EXISTS messaging_limit_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_config.messaging_limit_tier IS
  'Último tier lido da Meta (TIER_250, TIER_1K, …). NULL = nunca consultado; nesse caso a aplicação assume o tier mais restritivo.';
COMMENT ON COLUMN whatsapp_config.messaging_limit_checked_at IS
  'Quando o tier foi lido. TTL de 15 min na rota /api/whatsapp/messaging-limit.';

-- ============================================================
-- 2) ÍNDICES PARA A AGREGAÇÃO DE COTA
--
-- `broadcast_recipients` só tinha índice por broadcast_id (001:334).
-- A consulta de cota filtra por sent_at e agrupa por contact_id;
-- sem estes dois índices ela vira seq scan na tabela inteira — a
-- maior do módulo — a cada abertura da tela de disparo.
-- ============================================================

-- Parcial: linhas ainda não enviadas nunca entram na janela, e
-- excluí-las mantém o índice pequeno em contas com muito rascunho.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sent_at
  ON broadcast_recipients(sent_at)
  WHERE sent_at IS NOT NULL;

-- Também serve ao histórico por contato da tela de triagem (fase 4).
-- contact_id é nullable desde a 004 (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact
  ON broadcast_recipients(contact_id)
  WHERE contact_id IS NOT NULL;

-- ============================================================
-- 3) RPC DE CONSUMO DE COTA
--
-- SECURITY DEFINER, não INVOKER. A RLS de broadcast_recipients
-- (017:566-572) escoparia corretamente por conta, mas força o
-- planejador a avaliar o EXISTS de política linha a linha sobre uma
-- agregação DISTINCT da tabela inteira. Como DEFINER a função roda
-- com RLS desligada — por isso a PRIMEIRA instrução do corpo é a
-- guarda de associação. Sem ela, qualquer autenticado leria a cota
-- de qualquer conta.
--
-- Mesmo padrão das funções dashboard_* da 039, e sujeita à ACL
-- explícita exigida pela 042.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_quota_usage(
  p_account_id UUID,
  p_window_hours INT DEFAULT 24
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  -- Guarda obrigatória: a função roda como `postgres` (RLS off).
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  -- Janela sanitizada: um valor absurdo transformaria a consulta
  -- num full scan sem que o índice parcial ajudasse.
  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 168 THEN
    p_window_hours := 24;
  END IF;

  SELECT COUNT(DISTINCT br.contact_id)
    INTO v_count
    FROM broadcast_recipients br
    JOIN broadcasts b ON b.id = br.broadcast_id
   WHERE b.account_id = p_account_id
     AND br.contact_id IS NOT NULL
     AND br.sent_at >= NOW() - make_interval(hours => p_window_hours)
     -- 'pending' e 'failed' não consumiram conversa na Meta.
     AND br.status IN ('sent', 'delivered', 'read', 'replied');

  RETURN COALESCE(v_count, 0);
END;
$$;

ALTER FUNCTION public.broadcast_quota_usage(UUID, INT) OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon**, nesta ordem e separadamente.
--
-- `REVOKE ... FROM PUBLIC` sozinho NÃO basta neste banco: o Supabase
-- mantém ALTER DEFAULT PRIVILEGES concedendo EXECUTE a `anon` e
-- `authenticated` em toda função nova de `public`. Essa concessão é
-- nominal, não herdada de PUBLIC, então o revoke de PUBLIC passa ao
-- largo dela. Foi exatamente assim que as seis funções da migração 042
-- ficaram abertas a `anon` — e foi assim que esta ficou, na primeira
-- aplicação em `vn`, até a verificação de ACL pegar.
--
-- `authenticated` PRECISA do EXECUTE (a rota chama como o usuário); é
-- a guarda `is_account_member` no corpo que faz o escopo por conta.
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_quota_usage(UUID, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_quota_usage(UUID, INT) IS
  'Contatos distintos alcançados por disparo na janela (padrão 24 h). Guarda is_account_member no corpo — DEFINER roda com RLS desligada.';

-- ============================================================
-- 4) ASSERÇÃO — mesma postura da 042
--
-- Um REVOKE que não pegou (assinatura diferente da esperada, default
-- privilege reintroduzido) falharia em silêncio e deixaria a função
-- aberta. Melhor abortar a migração do que seguir achando que fechou.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'broadcast_quota_usage'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      '044: broadcast_quota_usage continua executavel por anon. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.';
  END IF;
END;
$$;
