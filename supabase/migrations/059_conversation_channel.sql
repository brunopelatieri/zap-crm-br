-- ============================================================
-- 059_conversation_channel — conversas por canal (PRD 047 §7.1.4 / SPEC 048 §3)
--
-- Renumerada de 057 para 059
--
--   A SPEC 048 e o PRD 047 chamam esta migração de "057" em toda a
--   documentação. Esse número foi consumido por dois commits
--   não-relacionados (057_notification_text_ptbr, 058_message_delivery_error,
--   ambos já aplicados) antes desta rodar. O conteúdo é o mesmo que os
--   dois documentos descrevem — só o número mudou. Os textos de asserção
--   abaixo dizem "059:" (não "057:") para não confundir o operador lendo
--   o log de uma falha.
--
-- O que esta migração faz
--
--   D-2 do PRD 047: uma conversa por (conta, contato, CANAL) em vez de
--   (conta, contato). Sem isso, um contato que fala pelo WhatsApp Oficial
--   e pelo QRCode cairia na mesma thread — "responder" ficaria ambíguo
--   (por qual canal?) e a janela de 24h, que só existe no oficial, seria
--   calculada sobre mensagens que não a abrem.
--
--   1. `conversations.channel_id` — toda conversa existente aponta para
--      o canal Cloud da própria conta (única opção até aqui).
--   2. Troca do índice único da 036 — `(account_id, contact_id)` vira
--      `(account_id, contact_id, channel_id)`.
--   3. `channel_id` imutável após a criação — trigger `BEFORE UPDATE`,
--      porque uma conversa não migra de canal (a âncora da janela de 24h
--      e o histórico de entrega passariam a descrever um canal que já
--      não é o da thread).
--   4. Asserção final: confirma que a coluna e o índice da SPEC 045
--      sobreviveram, e que o novo índice de dedupe existe.
--
-- Idempotente e sem perda de dados.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Coluna + backfill
--
-- Toda conversa hoje só pode ter nascido pelo canal Cloud (é o único
-- tipo que existe em produção até a 056/F3 desta SPEC). O backfill
-- resolve o canal Cloud padrão de cada conta e aponta as conversas
-- dela para ele.
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id);

UPDATE conversations c
SET channel_id = ch.id
FROM channels ch
WHERE ch.account_id = c.account_id
  AND ch.type = 'whatsapp_cloud'
  AND c.channel_id IS NULL;

-- Conta sem canal Cloud em `channels` (não deveria existir depois da
-- 055, mas o backstop evita um NOT NULL cego travar em produção sem
-- explicar por quê).
DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  SELECT count(*) INTO v_orphans FROM conversations WHERE channel_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '059: % conversas sem channel_id apos o backfill (conta sem canal Cloud em channels — rode a 055 primeiro).', v_orphans;
  END IF;
END $$;

ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;

-- ------------------------------------------------------------
-- 2) D-2: relaxa o índice da 036 — a proteção contra conversa
--    duplicada continua, agora por canal.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_conversations_account_contact;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel_id);

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations (channel_id, last_message_at DESC);

-- ------------------------------------------------------------
-- 3) Imutabilidade — uma conversa não migra de canal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION conversations_channel_id_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
    RAISE EXCEPTION '059: conversations.channel_id e imutavel apos a criacao (conversa %).', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_channel_id_immutable ON conversations;
CREATE TRIGGER trg_conversations_channel_id_immutable
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_channel_id_immutable();

-- ------------------------------------------------------------
-- 4) Asserções — falham alto de propósito (padrão 041/052)
--
-- Confirma que esta migração não desfez a SPEC 045 e que o novo índice
-- de dedupe está no lugar do antigo.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='conversations' AND column_name='last_customer_message_at')
  THEN RAISE EXCEPTION '059: coluna da SPEC 045 desapareceu.'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='conversations' AND indexname='idx_conversations_last_customer_msg')
  THEN RAISE EXCEPTION '059: idx_conversations_last_customer_msg da SPEC 045 nao sobreviveu.'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='conversations' AND indexname='idx_conversations_account_contact_channel')
  THEN RAISE EXCEPTION '059: dedupe de conversas ficou sem indice.'; END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes
             WHERE tablename='conversations' AND indexname='idx_conversations_account_contact')
  THEN RAISE EXCEPTION '059: indice antigo idx_conversations_account_contact deveria ter sido removido.'; END IF;
END $$;
