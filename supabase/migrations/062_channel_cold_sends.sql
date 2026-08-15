-- ============================================================
-- 062_channel_cold_sends.sql — contagem de envio frio por instância
-- (SPEC 049 §3.2 e §6.2 · F6.1)
--
-- Por que uma tabela, e não contar direto em `messages`
--
--   "Era frio no momento do envio" não é reconstituível: basta o
--   contato responder cinco minutos depois para a mesma linha de
--   `messages` passar a parecer uma resposta em conversa viva. Esta
--   tabela append-only grava o JULGAMENTO (foi frio, valeu a cota), não
--   os dados que o produziram — a mesma razão de `automation_window_claims`
--   (052) e `automation_schedule_claims` (054) existirem separadas do
--   que elas decidem.
--
-- `origin` — de onde saiu (D-1 da SPEC 049)
--
--   Sem isto a aba WhatsApp QRCode mostraria um número que ninguém sabe
--   explicar ("60 envios frios" — de automação? do agente?). Três
--   valores: `engine` (automação/flow/IA), `human` (inbox, nunca
--   bloqueia — só descreve o consumo) e `api` (API pública v1, único
--   caminho que responde 429).
--
-- Escrita — só service_role
--
--   A linha é PROVA de entrega para o freio antispam. Uma policy de
--   INSERT/DELETE para o cliente permitiria a um usuário zerar o
--   próprio freio. Leitura é aberta a membro da conta — é o que a aba
--   WhatsApp QRCode (F3) precisa para desenhar a barra de consumo.
--
-- Expurgo em 30 dias
--
--   Mesma retenção de `automation_window_claims` (052) e
--   `automation_schedule_claims` (054): a janela mais longa que o
--   cálculo lê é de 24h, 30 dias existem só para diagnóstico ("por que
--   a automação de terça pulou?"). Índice de purga aqui; a rotina em si
--   é configuração de deployment (`supabase/setup/cron-jobs.sql`), não
--   schema — mesma regra do `AGENTS.md` que impediu URL/segredo de
--   entrar em migração.
--
-- Idempotente — seguro reexecutar.
-- ============================================================

CREATE TABLE IF NOT EXISTS channel_cold_sends (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  origin     TEXT NOT NULL DEFAULT 'engine'
             CHECK (origin IN ('engine', 'human', 'api')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serve as três consultas do teto (24h, 1h, último envio): todas
-- filtram por canal e ordenam/limitam por tempo decrescente.
CREATE INDEX IF NOT EXISTS idx_cold_sends_channel_time
  ON channel_cold_sends (channel_id, sent_at DESC);

-- Índice do expurgo — varredura só por idade, sem nenhum canal.
CREATE INDEX IF NOT EXISTS idx_cold_sends_purge
  ON channel_cold_sends (sent_at);

ALTER TABLE channel_cold_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_cold_sends_select ON channel_cold_sends
  FOR SELECT USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- Asserções — falham alto de propósito (padrão 041/052/059/061)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'channels') THEN
    RAISE EXCEPTION '062: tabela channels ausente — rode a 055 primeiro.';
  END IF;

  -- Escrita pelo cliente é a falha que esta tabela não pode ter: uma
  -- policy de INSERT/UPDATE/DELETE deixaria o próprio freio zerável.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'channel_cold_sends'
               AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '062: channel_cold_sends nao pode ter policy de escrita.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class
                 WHERE relname = 'channel_cold_sends' AND relrowsecurity) THEN
    RAISE EXCEPTION '062: RLS desligada em channel_cold_sends.';
  END IF;

  RAISE NOTICE '062: channel_cold_sends criada.';
END $$;
