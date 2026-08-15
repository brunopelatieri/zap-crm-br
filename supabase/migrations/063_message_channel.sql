-- ============================================================
-- 063_message_channel — selo do canal de desvio na bolha (SPEC 049 §6.1
-- ponto 2, teste manual 12)
--
-- O problema
--
--   O desvio por canal (F6.3, `sendViaFallbackChannel`) entrega a
--   mensagem por um canal QRCode mas grava a bolha na conversa ORIGINAL
--   — a do WhatsApp Oficial onde a janela de 24h fechou (§6.1 ponto 2:
--   é a thread que disparou a automação, e abrir uma thread nova sem o
--   cliente ter escrito poluiria a lista). Sem marca nenhuma, o agente
--   vê uma bolha de saída comum numa conversa "do oficial" — e não tem
--   como saber que aquela mensagem específica saiu por outro número.
--
-- O que esta coluna representa
--
--   NULA (o caso comum): a mensagem saiu pelo canal da própria
--   conversa — `conversations.channel_id`. Nenhuma UI nova a lê.
--
--   PREENCHIDA: a mensagem saiu por um canal DIFERENTE do da conversa
--   — hoje, só o caminho do desvio (`sendAndPersistOutbound` com o
--   parâmetro `channel` explícito) grava isto. A UI usa a presença do
--   valor, sozinha, como gatilho do selo — não precisa comparar contra
--   `conversations.channel_id` porque só é gravado quando os dois já
--   divergem.
--
-- Por que não backfill
--
--   Toda mensagem já enviada saiu pelo canal da própria conversa — é a
--   única rota que existia antes desta migração. NULL já é o valor
--   correto para 100% do histórico.
--
-- ON DELETE SET NULL, não CASCADE
--
--   Apagar a instância QRCode que serviu de desvio não pode apagar o
--   HISTÓRICO da conversa oficial — só o selo desaparece (mesma leitura
--   degradada de sempre: sem canal resolvido, a UI trata como "não é
--   desvio", que é o estado mais conservador).
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

COMMENT ON COLUMN messages.channel_id IS
  'NULL = enviada pelo canal da própria conversa (o caso comum). Preenchida só quando a mensagem saiu por um canal DIFERENTE do da conversa — hoje, só o desvio por canal (SPEC 049 F6.3) grava isto. A UI usa a presença do valor como selo, sem comparar contra conversations.channel_id.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'channel_id'
  ) THEN
    RAISE EXCEPTION '063: messages.channel_id nao foi criada.';
  END IF;
END $$;
