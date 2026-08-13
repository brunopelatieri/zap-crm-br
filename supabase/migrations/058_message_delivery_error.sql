-- ============================================================
-- 058_message_delivery_error.sql — motivo da falha de entrega em
-- mensagens do inbox
--
-- O webhook de status da Meta já recebe `errors[0].code/title/message`
-- no evento `status: 'failed'` e já formata isso em `errorMessage`
-- para gravar em `broadcast_recipients.error_message`. Só faltava a
-- mesma informação chegar em `messages`, que é o que alimenta o
-- balão de conversa no inbox — hoje o ícone de falha ali não carrega
-- motivo nenhum.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN error_message TEXT;

COMMENT ON COLUMN messages.error_message IS
  'Motivo da falha de entrega reportado pela Meta (status.errors[0]), formatado como "(#code) title: message". Só preenchido quando status = failed.';
