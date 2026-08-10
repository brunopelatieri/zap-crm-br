-- ============================================================
-- 054_automation_schedule_claims.sql — SPEC 046 fase 4
--
-- Idempotência da varredura do gatilho `time_based` (§6.3). Mesmo
-- desenho de `automation_window_claims` (migração 052, SPEC 045
-- §5.5.2): a UNIQUE é o lock, sem SELECT prévio, porque dois pings de
-- cron sobrepostos leriam "ainda não disparou" antes de qualquer um
-- gravar, e o contato receberia a mensagem duas vezes.
--
-- A chave muda de (automação × conversa × âncora de janela) para
-- (automação × contato × ocorrência): não existe conversa nem janela
-- de 24h aqui — o gatilho é hora de parede, não evento. `occurrence_at`
-- é o instante da ocorrência agendada, truncado ao minuto em UTC — é
-- ele, e não `now()`, que faz dois ticks sobrepostos enxergarem a
-- MESMA ocorrência e disputarem o mesmo claim, em vez de criarem dois
-- (ver `schedule-scan.ts`, que enumera a janela de minutos do tick e
-- casa cada um contra o cron da automação).
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_schedule_claims (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id)      ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id)   ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id)      ON DELETE CASCADE,
  -- Instante da ocorrência agendada (truncado ao minuto, UTC) — o
  -- análogo do window_anchor de 052: a chave que distingue "a
  -- ocorrência das 9h de hoje" de "a das 9h de amanhã".
  occurrence_at TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_schedule_claims_unique_claim
    UNIQUE (automation_id, contact_id, occurrence_at)
);

-- Só para a limpeza periódica (a UNIQUE acima já serve às consultas de
-- claim) — mesma retenção de 30 dias de 052.
CREATE INDEX IF NOT EXISTS idx_automation_schedule_claims_purge
  ON automation_schedule_claims(created_at);

-- Sem policy: acesso exclusivamente por service-role, mesmo padrão de
-- automation_window_claims (052) e automation_pending_executions
-- (006:138-141). `ENABLE ROW LEVEL SECURITY` sem nenhuma policy nega
-- acesso a anon/authenticated por padrão — não é um descuido.
ALTER TABLE automation_schedule_claims ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE automation_schedule_claims IS
  'Lock de idempotência da varredura do gatilho time_based (SPEC 046 §6.3). Uma linha por (automação x contato x ocorrência agendada); a UNIQUE é o que impede envio duplicado entre pings de cron sobrepostos. Sem policy: só service-role.';

-- ============================================================
-- ASSERÇÕES — padrão 042/044/045/046/048/049/050/052
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'automation_schedule_claims'
  ) THEN
    RAISE EXCEPTION '054: automation_schedule_claims nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_schedule_claims_unique_claim'
      AND conrelid = 'public.automation_schedule_claims'::regclass
  ) THEN
    RAISE EXCEPTION '054: UNIQUE(automation_id, contact_id, occurrence_at) ausente em automation_schedule_claims.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'automation_schedule_claims'
      AND indexname = 'idx_automation_schedule_claims_purge'
  ) THEN
    RAISE EXCEPTION '054: idx_automation_schedule_claims_purge nao foi criado.';
  END IF;
END;
$$;
