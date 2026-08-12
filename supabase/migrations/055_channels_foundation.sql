-- ============================================================
-- 055_channels_foundation — a camada de canais (PRD 047 / SPEC 048 F1)
--
-- Por que isto existe
--
--   Até aqui o CRM fala um idioma só: a Cloud API oficial da Meta.
--   `whatsapp_config` é uma linha por conta, e TODA mensagem entra e
--   sai por ela. Adicionar um segundo meio de conversa — a instância
--   WhatsApp via QRCode (Evolution Go), e depois Instagram, Messenger,
--   e-mail — sem uma camada de canais significa reimplementar inbox,
--   automações, flows e IA para cada um.
--
--   Esta migração cria o REGISTRO de canais. A configuração específica
--   de cada provedor continua na tabela dele (`whatsapp_config` para o
--   Cloud, `evolution_instances` para o QRCode na 056). Isso mantém a
--   `whatsapp_config` intacta — zero regressão no canal oficial — e
--   evita um `jsonb` genérico que ninguém consegue validar.
--
-- O que esta migração NÃO faz
--
--   Não toca `conversations` (isso é a 057, junto com a troca do índice
--   único da 036) e não muda comportamento nenhum da aplicação. Depois
--   dela, todo canal Cloud existente está representado em `channels` e
--   nada mais mudou.
--
-- Idempotente e sem perda de dados.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Registro de canais
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. Mesma chave que governa contacts/conversations/messages.
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Auditoria: quem criou. Não é usado para tenancy — segue a mesma
  -- separação account_id/user_id do resto do schema.
  user_id       UUID NOT NULL REFERENCES auth.users(id),

  type          TEXT NOT NULL CHECK (type IN ('whatsapp_cloud', 'whatsapp_qr')),

  -- Rótulo escolhido pelo operador ("Vendas", "Suporte"). É o que
  -- aparece no filtro do inbox e no seletor de canal.
  name          TEXT NOT NULL,

  -- Telefone E.164 conectado, quando conhecido. NULL enquanto uma
  -- instância QRCode não foi pareada.
  identifier    TEXT,

  status        TEXT NOT NULL DEFAULT 'disconnected'
                CHECK (status IN ('disconnected','connecting','connected','error','disabled')),
  -- Detalhe legível do status — o que a aba mostra quando algo falha,
  -- em vez de um badge vermelho mudo.
  status_detail TEXT,

  -- Canal usado quando ninguém especifica um (API pública, primeira
  -- conversa com um contato novo).
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,

  connected_at  TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_account ON channels(account_id, type);

-- Um canal Cloud por conta, enquanto `whatsapp_config` for singleton
-- (UNIQUE(account_id) desde a 017). Quando o produto suportar múltiplos
-- números oficiais, este índice cai junto com aquela restrição.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_one_cloud_per_account
  ON channels (account_id) WHERE type = 'whatsapp_cloud';

-- Exatamente um padrão por conta. Índice parcial em vez de trigger: a
-- garantia é do banco e não depende de nenhum caminho de aplicação.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_one_default_per_account
  ON channels (account_id) WHERE is_default;

DROP TRIGGER IF EXISTS set_updated_at ON channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE channels IS
  'Registro de canais de comunicação da conta (PRD 047). A config de cada provedor fica na tabela dele: whatsapp_config (Cloud) e evolution_instances (QRCode).';

-- ------------------------------------------------------------
-- 2) RLS — leitura para membros, escrita para admin+
--
-- Mesmo par de regras de `whatsapp_config` (017): qualquer membro
-- precisa VER por qual canal a conversa entrou, mas só admin+ conecta
-- ou remove um canal.
-- ------------------------------------------------------------
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channels_select ON channels;
DROP POLICY IF EXISTS channels_insert ON channels;
DROP POLICY IF EXISTS channels_update ON channels;
DROP POLICY IF EXISTS channels_delete ON channels;

CREATE POLICY channels_select ON channels FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY channels_insert ON channels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY channels_update ON channels FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY channels_delete ON channels FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 3) Vínculo com a config do Cloud
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_channel
  ON whatsapp_config(channel_id);

-- ------------------------------------------------------------
-- 4) Backfill: toda config existente vira um canal Cloud padrão
--
-- Reexecutável — o WHERE NOT EXISTS impede duplicar em uma segunda
-- passada, e o índice parcial do item 1 é o backstop.
--
-- `name`: rótulo inicial genérico. O operador renomeia na aba de
-- Configurações; o valor aqui só precisa ser legível.
-- `status`: derivado do que a própria config já registra — uma conta
-- que nunca completou o /register da Meta não deve nascer "connected".
-- ------------------------------------------------------------
INSERT INTO channels (account_id, user_id, type, name, identifier, status, is_default, connected_at)
SELECT
  wc.account_id,
  wc.user_id,
  'whatsapp_cloud',
  'WhatsApp Oficial',
  wc.phone_number_id,
  CASE WHEN wc.registered_at IS NOT NULL THEN 'connected' ELSE 'disconnected' END,
  TRUE,
  wc.registered_at
FROM whatsapp_config wc
WHERE wc.account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channels c
    WHERE c.account_id = wc.account_id AND c.type = 'whatsapp_cloud'
  );

UPDATE whatsapp_config wc
SET channel_id = c.id
FROM channels c
WHERE c.account_id = wc.account_id
  AND c.type = 'whatsapp_cloud'
  AND wc.channel_id IS DISTINCT FROM c.id;

-- ------------------------------------------------------------
-- 5) Asserções — falham alto de propósito
--
-- Mesmo padrão da 041/052: se o backfill não cobriu tudo, a próxima
-- migração (057) tornaria `conversations.channel_id` NOT NULL sobre uma
-- base incompleta e quebraria o inbox. Melhor abortar aqui.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'channels'
  ) THEN
    RAISE EXCEPTION '055: tabela channels nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_channels_one_cloud_per_account'
  ) THEN
    RAISE EXCEPTION '055: idx_channels_one_cloud_per_account ausente.';
  END IF;

  SELECT count(*) INTO v_orphans
  FROM whatsapp_config
  WHERE account_id IS NOT NULL AND channel_id IS NULL;

  IF v_orphans > 0 THEN
    RAISE EXCEPTION '055: % whatsapp_config sem channel_id apos o backfill.', v_orphans;
  END IF;
END $$;
