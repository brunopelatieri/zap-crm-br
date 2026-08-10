-- ============================================================
-- 052_session_window_reengagement.sql — SPEC 045 fase 1
--
-- Relógio da verdade da janela de sessão de 24h da Meta (§5.1/§5.2).
-- Duas peças, na mesma migração porque a segunda depende da primeira
-- existir antes de qualquer claim ser possível:
--
--   1. `conversations.last_customer_message_at` — coluna dedicada +
--      índice parcial, para a varredura (fase 4, fora desta entrega)
--      não precisar escanear `messages` a cada tick. Backfill incluso
--      para que conversas antigas não fiquem invisíveis para sempre.
--   2. `automation_window_claims` — tabela de claim com UNIQUE
--      (§5.5.2), usada pela varredura da fase 4. Entra aqui, e não na
--      migração da fase 4, porque §9 do plano a agrupa na fase 1: não
--      há razão técnica para adiar uma tabela aditiva, e adiar só
--      criaria uma segunda migração para o mesmo tema.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) conversations.last_customer_message_at
--
-- Índice parcial com account_id como coluna líder (igualdade antes de
-- faixa) e WHERE status = 'open' — a decisão de produto sobre incluir
-- 'pending' (§10, pergunta 6) fica em aberto para a fase 4, que é quem
-- de fato varre por este índice; a coluna e o índice em si são aditivos
-- e não mudam de forma se essa decisão mudar depois.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.last_customer_message_at IS
  'Timestamp da Meta (não do nosso servidor) da última mensagem enviada pelo CLIENTE nesta conversa. Escrita monotônica — ver o UPDATE filtrado em src/app/api/whatsapp/webhook/route.ts (SPEC 045 §5.2.1). É a âncora da janela de 24h calculada por computeSessionWindow (src/lib/whatsapp/session-window.ts).';

CREATE INDEX IF NOT EXISTS idx_conversations_last_customer_msg
  ON conversations(account_id, last_customer_message_at)
  WHERE status = 'open';

-- Backfill: sem isto, toda conversa criada antes desta migração fica
-- com a coluna NULL e invisível a qualquer varredura futura baseada
-- nela, mesmo que o cliente tenha escrito ontem.
UPDATE conversations c
   SET last_customer_message_at = (
     SELECT MAX(m.created_at)
       FROM messages m
      WHERE m.conversation_id = c.id
        AND m.sender_type = 'customer'
   )
 WHERE c.last_customer_message_at IS NULL;

-- ============================================================
-- 2) automation_window_claims — idempotência da varredura (§5.5.2)
--
-- UNIQUE (automation_id, conversation_id, window_anchor) é o lock: o
-- INSERT que ganha o conflito é quem dispara, sem SELECT prévio (que
-- não seria atômico entre dois pings de cron sobrepostos).
--
-- `sent_at` / `failed_at` / `reopened_at` (§5.5.5) separam, dentro da
-- mesma linha, os três desfechos possíveis do claim — sem eles a
-- métrica de reabertura (§7) exigiria cruzar automation_logs com
-- messages por contact_id e janela de tempo, uma consulta cara demais
-- para alguém escrever depois do deploy.
--
-- Sem policy: acesso exclusivamente por service-role, mesmo padrão de
-- automation_pending_executions (006:138-141).
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_window_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id)      ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES automations(id)   ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Âncora da janela: o last_customer_message_at que tornou a conversa
  -- elegível. Dá a idempotência POR JANELA — uma mensagem nova do
  -- cliente muda a âncora, gera uma chave nova e reabre a elegibilidade.
  window_anchor   TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  reopened_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_window_claims_unique_claim
    UNIQUE (automation_id, conversation_id, window_anchor)
);

-- Só para a limpeza periódica (a UNIQUE acima já serve às consultas de
-- claim); ver a rotina de purga de 30 dias descrita em §5.5.2.
CREATE INDEX IF NOT EXISTS idx_automation_window_claims_purge
  ON automation_window_claims(created_at);

ALTER TABLE automation_window_claims ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE automation_window_claims IS
  'Lock de idempotência da varredura de reengajamento (SPEC 045 §5.5.2). Uma linha por (automação x conversa x âncora de janela); a UNIQUE é o que impede envio duplicado entre pings de cron sobrepostos. Sem policy: só service-role.';

-- ============================================================
-- 3) ASSERÇÕES — padrão 042/044/045/046/048/049/050
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'last_customer_message_at'
  ) THEN
    RAISE EXCEPTION '052: conversations.last_customer_message_at nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'conversations'
      AND indexname = 'idx_conversations_last_customer_msg'
  ) THEN
    RAISE EXCEPTION '052: idx_conversations_last_customer_msg nao foi criado.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'automation_window_claims'
  ) THEN
    RAISE EXCEPTION '052: automation_window_claims nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_window_claims_unique_claim'
      AND conrelid = 'public.automation_window_claims'::regclass
  ) THEN
    RAISE EXCEPTION '052: UNIQUE(automation_id, conversation_id, window_anchor) ausente em automation_window_claims.';
  END IF;
END;
$$;
