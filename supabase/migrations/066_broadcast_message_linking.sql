-- ============================================================
-- 066_broadcast_message_linking.sql — SPEC 057
--
-- messages.broadcast_id: desnormalização de LEITURA (SPEC 057 D-3).
-- A fonte de verdade do vínculo continua sendo broadcast_recipients
-- (migração 003, UNIQUE em whatsapp_message_id). Esta coluna existe
-- para o inbox resolver a origem da bolha em um join direto, e é
-- reconciliável por messages.message_id = recipients.whatsapp_message_id.
--
-- ON DELETE SET NULL: apagar uma campanha nunca pode apagar o histórico
-- de conversa do cliente.
--
-- Idempotente.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS broadcast_id UUID
    REFERENCES broadcasts(id) ON DELETE SET NULL;

-- Parcial: a esmagadora maioria das mensagens não vem de broadcast, e
-- um índice cheio de NULLs paga escrita em todo inbound sem servir
-- nenhuma leitura.
CREATE INDEX IF NOT EXISTS idx_messages_broadcast
  ON messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

-- Guarda de coerência: só mensagem de saída pode ter origem em
-- campanha. Sem isto, um bug de hidratação carimbaria a resposta do
-- cliente como se ela fosse a campanha.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_broadcast_outbound_only;
ALTER TABLE messages
  ADD CONSTRAINT messages_broadcast_outbound_only
  CHECK (broadcast_id IS NULL OR sender_type <> 'customer')
  NOT VALID;   -- NOT VALID: não varre linhas antigas (todas têm NULL);
               -- vale para toda escrita nova. Validar depois, se desejado.

COMMENT ON COLUMN messages.broadcast_id IS
  'Campanha que originou esta mensagem de saída (SPEC 057 D-3). Desnormalização de leitura; o vínculo canônico é broadcast_recipients.';
