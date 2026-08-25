-- ============================================================
-- 065_inbound_contact_webhook.sql — SPEC 055
--
-- Webhook de ENTRADA (terceiro faz POST para o CRM): ingestão de
-- contato, funil de disparo agrupado por webhook_id, e log de erros
-- de validação. Contraste com a migração 028 (`webhook_endpoints`),
-- que é o webhook de SAÍDA — o CRM notificando terceiros.
--
-- Três peças:
--   1) `broadcasts` ganha `source` / `webhook_id` / `webhook_name` /
--      `ingested_count`, e o CHECK de `status` ganha 'streaming'
--      (SPEC 055 §6.1, D-4/D-5).
--   2) `webhook_ingest_logs` (nova) — uma linha por falha/aviso de
--      validação, com payload truncado (SPEC 055 §6.2, D-11/D-13).
--   3) `upsert_webhook_funnel` — RPC que encontra-ou-cria a linha do
--      funil e incrementa `ingested_count` na mesma instrução, porque
--      um SELECT→INSERT em TypeScript perde a corrida quando o mesmo
--      webhook_id chega em paralelo (SPEC 055 §6.3).
--
-- Idempotente — seguro re-rodar.
--
-- ⚠️ Três projetos Supabase (vn, rs, jh). Confirmar com o mantenedor
--    antes de aplicar em qualquer um deles (AGENTS.md).
-- ============================================================

-- ============================================================
-- 1) `broadcasts` — três colunas + um contador
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'dashboard',
  ADD COLUMN IF NOT EXISTS webhook_id      TEXT,
  ADD COLUMN IF NOT EXISTS webhook_name    TEXT,
  ADD COLUMN IF NOT EXISTS ingested_count  INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN broadcasts.source IS
  'dashboard (padrão, campanha manual/agendada) | api (POST /api/v1/broadcasts) | webhook (funil acumulativo de POST /api/v1/ingest/contact, SPEC 055 D-4).';
COMMENT ON COLUMN broadcasts.webhook_id IS
  'SPEC 055 D-5. Preenchido apenas quando source = webhook — identifica a ORIGEM (não é credencial). Uma linha de broadcasts por (account_id, webhook_id).';
COMMENT ON COLUMN broadcasts.webhook_name IS
  'SPEC 055 D-5. Rótulo de exibição do funil; o último POST vence (renomear a origem no chamador renomeia o funil).';
COMMENT ON COLUMN broadcasts.ingested_count IS
  'SPEC 055 D-15. Conta POSTs aceitos para este webhook_id, COM ou SEM disparo — distinto de total_recipients, que só conta envios tentados.';

-- ------------------------------------------------------------
-- 1.1) CHECK de coerência — source='webhook' exige webhook_id e
-- webhook_name; qualquer outro source os proíbe. Mesmo padrão de
-- invariante-de-forma da migração 051 (variantes A/B).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_source_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_source_check
      CHECK (source IN ('dashboard', 'api', 'webhook'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_webhook_shape_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_webhook_shape_check
      CHECK (
        (source = 'webhook' AND webhook_id IS NOT NULL AND webhook_name IS NOT NULL)
        OR
        (source <> 'webhook' AND webhook_id IS NULL AND webhook_name IS NULL)
      );
  END IF;
END $$;

-- Índice único parcial — garante o funil ACUMULATIVO (SPEC 055 D-5):
-- um único `broadcasts` por (account_id, webhook_id). É o que a RPC
-- de upsert (§3) usa como alvo do ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_account_webhook
  ON broadcasts(account_id, webhook_id)
  WHERE source = 'webhook';

-- ------------------------------------------------------------
-- 1.2) CHECK de `status` estendido com 'streaming' — um funil de
-- webhook nunca "termina" (§6.1 D-5), e os 5 valores de 001
-- (draft/scheduled/sending/sent/failed) não têm um que sirva. O
-- CHECK original é anônimo por posição; localizado por conteúdo,
-- igual à migração 014 fez para message_templates.status.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.broadcasts'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%draft%scheduled%sending%sent%failed%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%streaming%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.broadcasts DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint c
      WHERE c.conrelid = 'public.broadcasts'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%draft%scheduled%sending%sent%failed%'
        AND pg_get_constraintdef(c.oid) NOT ILIKE '%streaming%'
      LIMIT 1
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_status_streaming_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_status_streaming_check
      CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'streaming'));
  END IF;
END $$;

COMMENT ON COLUMN broadcasts.status IS
  'draft/scheduled/sending/sent/failed são o ciclo de uma campanha. streaming (migração 065) é exclusivo de source=''webhook'' — um funil acumulativo nunca chega a sent/failed.';

-- ============================================================
-- 2) `webhook_ingest_logs` — uma linha por rejeição/aviso de
-- validação do POST de ingestão (SPEC 055 §6.2, D-11).
--
-- Deliberadamente SEM policy de INSERT/UPDATE: a única escritora é a
-- rota, com o cliente service_role (ignora RLS) — não existe caso
-- legítimo de um usuário logado inserir linha de log.
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_ingest_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id   uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  webhook_id   text,
  webhook_name text,
  level        text NOT NULL CHECK (level IN ('error', 'warning')),
  code         text NOT NULL,
  message      text NOT NULL,
  phone        text,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE webhook_ingest_logs IS
  'SPEC 055 D-11. Log de FALHAS/avisos de validação do webhook de entrada — nunca de sucesso (o sucesso vive no funil, broadcasts.source=webhook). Distinto de webhook_endpoints.failure_count (028), que é agregado por endpoint de SAÍDA.';
COMMENT ON COLUMN webhook_ingest_logs.webhook_id IS
  'NULL quando a própria validação de webhook_id falhou (SPEC 055 §5.3).';
COMMENT ON COLUMN webhook_ingest_logs.payload IS
  'Corpo JSON recebido, truncado em 8 KB (SPEC 055 D-13). Nunca inclui o header Authorization.';

CREATE INDEX IF NOT EXISTS idx_webhook_ingest_logs_account_created
  ON webhook_ingest_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_ingest_logs_webhook
  ON webhook_ingest_logs(account_id, webhook_id, created_at DESC);

ALTER TABLE webhook_ingest_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_ingest_logs_select ON webhook_ingest_logs;
CREATE POLICY webhook_ingest_logs_select ON webhook_ingest_logs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS webhook_ingest_logs_delete ON webhook_ingest_logs;
CREATE POLICY webhook_ingest_logs_delete ON webhook_ingest_logs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 3) RPC — encontra-ou-cria o funil do webhook_id e incrementa
-- ingested_count NA MESMA instrução (SPEC 055 §6.3).
--
-- SECURITY DEFINER porque o único chamador é o cliente service_role
-- da rota /api/v1/ingest/contact (sem sessão de usuário) — mesma
-- convenção de is_account_member. `webhook_name` é atualizado a cada
-- chamada: o último POST vence.
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_webhook_funnel(
  p_account_id   uuid,
  p_user_id      uuid,
  p_webhook_id   text,
  p_webhook_name text
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name, template_language,
    status, source, webhook_id, webhook_name, ingested_count
  )
  VALUES (
    p_account_id, p_user_id, p_webhook_name, '', 'en_US',
    'streaming', 'webhook', p_webhook_id, p_webhook_name, 1
  )
  ON CONFLICT (account_id, webhook_id) WHERE source = 'webhook'
  DO UPDATE SET
    webhook_name   = EXCLUDED.webhook_name,
    name           = EXCLUDED.webhook_name,
    ingested_count = broadcasts.ingested_count + 1,
    updated_at     = now()
  RETURNING id;
$$;

ALTER FUNCTION public.upsert_webhook_funnel(uuid, uuid, text, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.upsert_webhook_funnel(uuid, uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.upsert_webhook_funnel IS
  'SPEC 055 §6.3. INSERT … ON CONFLICT DO UPDATE resolve a corrida de POSTs paralelos com o mesmo webhook_id na primeira tentativa — um SELECT→INSERT em TypeScript perderia a corrida sob concorrência.';

-- ------------------------------------------------------------
-- 3.1) `total_recipients` — incrementado À PARTE de ingested_count,
-- no momento em que `funnel.ts` cria a linha de `broadcast_recipients`
-- (SPEC 055 §6.3, §7 addFunnelRecipient). NÃO é mantido pelo trigger
-- de 003/005 (aquele trigger só cuida dos cinco contadores de
-- status) — é a mesma distinção que `createBroadcast` já documenta ao
-- semear `total_recipients` no INSERT em vez de deixar o trigger
-- cuidar dele.
--
-- Função dedicada (coluna fixa) em vez de reusar `_bcast_bump`
-- (005) de propósito: aquele helper recebe o NOME da coluna como
-- parâmetro para servir o trigger genérico — superfície maior do que
-- esta SPEC precisa, e não pensado para ser chamado fora de um
-- trigger.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_broadcast_total_recipients(
  p_broadcast_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE broadcasts
  SET total_recipients = total_recipients + 1,
      updated_at = now()
  WHERE id = p_broadcast_id;
$$;

ALTER FUNCTION public.increment_broadcast_total_recipients(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.increment_broadcast_total_recipients(uuid)
  TO service_role;

-- ============================================================
-- 4) Purga do log — FUNÇÃO apenas. NÃO agendada aqui (SPEC 055
-- D-13): o pg_cron não está instalado em todo projeto (ver
-- AGENTS.md / memória do projeto). Agendamento fica em
-- supabase/setup/, explícito, para o mantenedor decidir.
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_webhook_ingest_logs(
  p_older_than_days integer DEFAULT 90
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM webhook_ingest_logs
  WHERE created_at < now() - (p_older_than_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

ALTER FUNCTION public.purge_webhook_ingest_logs(integer) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.purge_webhook_ingest_logs(integer) TO service_role;

COMMENT ON FUNCTION public.purge_webhook_ingest_logs IS
  'SPEC 055 D-13. Retenção padrão de 90 dias. NÃO agendada por esta migração — ver supabase/setup/cron-jobs.sql para o snippet de cron.schedule comentado.';
