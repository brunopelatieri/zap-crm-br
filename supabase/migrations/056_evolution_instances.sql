-- ============================================================
-- 056_evolution_instances — instâncias Evolution Go (PRD 047 / SPEC 048 F3)
--
-- Por que isto existe
--
--   A 055 criou o REGISTRO de canais (`channels`). Esta migração cria a
--   configuração específica do canal QRCode: uma linha 1:1 em
--   `evolution_instances` por canal `whatsapp_qr`, os segredos numa
--   tabela à parte sem nenhuma policy de leitura (só `service_role`), e
--   o override de limite por conta (D-1, PRD §4).
--
--   `contact_identities` entra AQUI, não numa fase futura — a sondagem
--   contra o servidor real (SPEC 048 §1.2 R3) confirmou que
--   `POST /user/info` NÃO traduz LID em telefone. Sem esta tabela não
--   há como casar um inbound que chegue só com LID, e adiar a criação
--   dela obrigaria uma segunda migração só para isso.
--
-- O que esta migração NÃO faz
--
--   Não registra nenhum adaptador de mensageria (F4) e não cria nenhuma
--   linha — a criação de instância é uma AÇÃO do operador na aba
--   "WhatsApp QRCode", não um backfill. Não toca `conversations` (57).
--
-- Idempotente e sem perda de dados.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Configuração da instância Evolution (1:1 com channels)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_instances (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  channel_id           UUID NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Id devolvido pela Evolution no `create`. NULL só durante a janela
  -- (muito curta) entre a chamada e a gravação da resposta.
  remote_instance_id   TEXT,

  -- Nome namespaced (SPEC 048 §7.1) — global na VPS, por isso UNIQUE
  -- aqui também: colisão local significa colisão remota.
  remote_instance_name TEXT NOT NULL UNIQUE,

  connected_phone      TEXT,
  connected_jid        TEXT,

  proxy_host           TEXT,
  proxy_port           INTEGER,

  subscribed_events    TEXT[] NOT NULL DEFAULT ARRAY['MESSAGE','SEND_MESSAGE','READ_RECEIPT','CONNECTION','QRCODE'],

  -- Espelha `AdvancedSettings` da Evolution (GET/PUT
  -- /instance/{id}/advanced-settings) para a UI mostrar sem ir à VPS a
  -- cada render. Fonte de verdade continua sendo a VPS; isto é cache.
  advanced_settings    JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Só timestamp: o QR em si NUNCA é persistido (PRD §11).
  last_qr_at           TIMESTAMPTZ,
  last_error           TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evolution_instances_account
  ON evolution_instances(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON evolution_instances;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON evolution_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE evolution_instances IS
  'Configuração de uma instância WhatsApp via QRCode (Evolution Go), 1:1 com channels.type=whatsapp_qr. Segredos ficam em evolution_instance_secrets.';

ALTER TABLE evolution_instances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evolution_instances_select ON evolution_instances;
DROP POLICY IF EXISTS evolution_instances_insert ON evolution_instances;
DROP POLICY IF EXISTS evolution_instances_update ON evolution_instances;
DROP POLICY IF EXISTS evolution_instances_delete ON evolution_instances;

-- Mesmo par de regras de `channels` (055): membro vê, admin+ escreve.
CREATE POLICY evolution_instances_select ON evolution_instances FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY evolution_instances_insert ON evolution_instances FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY evolution_instances_update ON evolution_instances FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY evolution_instances_delete ON evolution_instances FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 2) Segredos — tabela à parte, SEM nenhuma policy de SELECT
--
--   Um `SELECT *` acidental na UI (ou um bug de RLS futuro) nunca pode
--   devolver um token: a tabela tem RLS ligada e ZERO policy, então só
--   o `service_role` (que ignora RLS) consegue ler. Todo acesso passa
--   por rota server-side com `supabaseAdmin()`.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_instance_secrets (
  instance_id              UUID PRIMARY KEY REFERENCES evolution_instances(id) ON DELETE CASCADE,
  -- AES-256-GCM via ENCRYPTION_KEY (mesmo formato de whatsapp_config.access_token).
  instance_token_encrypted TEXT NOT NULL,
  -- 32 bytes hex — path do webhook desta instância (SPEC 048 §6.3).
  webhook_secret            TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_secrets_webhook
  ON evolution_instance_secrets (webhook_secret);

ALTER TABLE evolution_instance_secrets ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy criada de propósito: RLS ligada + zero policy = nega
-- tudo para quem não é service_role.

COMMENT ON TABLE evolution_instance_secrets IS
  'Token da instância (cifrado) e secret do webhook. RLS ligada, sem NENHUMA policy — só service_role le. Nunca chega ao browser.';

-- ------------------------------------------------------------
-- 3) Identidade alternativa (LID) — SPEC 048 §1.2 R3
--
--   `/user/info` não traduz LID em telefone. O vínculo só se constrói
--   telefone → LID (via /user/check) e é gravado aqui quando o contato
--   é criado ou atualizado no canal QR. Um inbound que chegue só como
--   LID casa por esta tabela; sem vínculo, o adaptador (F4) descarta
--   com log alto em vez de criar contato sintético.
--
--   `account_id` entra na PK (revisão pré-aplicação): um LID identifica
--   o WHATSAPP DE ORIGEM da mensagem, não o destinatário — o mesmo
--   contato externo pode falar com duas contas diferentes na mesma VPS
--   compartilhada. Com PK global (channel_type, external_id), a segunda
--   conta a gravar o vínculo colidiria com a primeira (ou sobrescreveria
--   o contact_id de outro tenant). Escopar por conta evita a colisão
--   cross-tenant sem mudar a estratégia de resolução (ainda é só
--   telefone → LID, gravado por account_id).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_identities (
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  -- Ex.: '226559659127039@lid'.
  external_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, channel_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_contact
  ON contact_identities(contact_id);

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_identities_select ON contact_identities;
DROP POLICY IF EXISTS contact_identities_all ON contact_identities;

-- Tenancy passa pelo contato (que já é escopado por account_id); ler
-- exige poder ler o contato correspondente. Escrita fica com
-- service_role (F4 grava no ingest), então não há policy de INSERT
-- para usuários autenticados — mesma postura de `evolution_instance_secrets`
-- quanto a escrita de aplicação, mas aqui a leitura é liberada porque o
-- dado não é um segredo.
CREATE POLICY contact_identities_select ON contact_identities FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_identities.contact_id
        AND is_account_member(c.account_id)
    )
  );

COMMENT ON TABLE contact_identities IS
  'Vínculo contato -> identificador alternativo do provedor (ex.: LID do WhatsApp), escopado por account_id para evitar colisão cross-tenant na VPS compartilhada. Só o sentido telefone->LID é resolvível (SPEC 048 SS1.2 R3); escrita via service_role.';

-- ------------------------------------------------------------
-- 4) Limite de instâncias por conta (D-1, PRD §4)
--
--   NULL = usa EVOLUTION_MAX_INSTANCES_PER_ACCOUNT do .env. Uma coluna,
--   um COALESCE — libera exceção comercial sem redeploy.
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS evolution_instance_limit INTEGER
  CHECK (evolution_instance_limit IS NULL OR evolution_instance_limit BETWEEN 0 AND 50);

-- ------------------------------------------------------------
-- 5) Asserções — falham alto de propósito
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evolution_instances'
  ) THEN
    RAISE EXCEPTION '056: tabela evolution_instances nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'evolution_instance_secrets'
  ) THEN
    RAISE EXCEPTION '056: tabela evolution_instance_secrets nao foi criada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'evolution_instance_secrets'
  ) THEN
    RAISE EXCEPTION '056: evolution_instance_secrets tem policy — deveria ter ZERO, so service_role pode ler.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'contact_identities'
  ) THEN
    RAISE EXCEPTION '056: tabela contact_identities nao foi criada.';
  END IF;

  -- A 055 continua intacta (mesmo padrão de asserção da 041/052).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'channels'
  ) THEN
    RAISE EXCEPTION '056: tabela channels (055) desapareceu.';
  END IF;
END $$;
