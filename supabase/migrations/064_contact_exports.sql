-- ============================================================
-- 064_contact_exports — trilha de auditoria da exportação de contatos
-- (SPEC 051 §6.1)
--
-- Por que esta tabela existe
--
--   A RLS de `contacts` deixa qualquer membro (inclusive `viewer`) ler
--   todos os contatos da conta; baixar a base inteira em um clique num
--   arquivo é outra coisa, e a LGPD pede rastro de quem fez. A rota
--   POST /api/contacts/export grava uma linha aqui a cada exportação
--   concluída, ANTES de responder ao cliente.
--
-- Sem policy de INSERT/UPDATE/DELETE
--
--   A trilha só é escrita pela rota, com `supabaseAdmin()` (service
--   role, que ignora RLS) depois de já ter validado o papel do usuário
--   (`requireRole('admin')`). Ninguém edita um registro depois de
--   criado — é isso que o torna trilha, e não apenas um log qualquer.
--
-- `user_id` é ON DELETE SET NULL, não CASCADE
--
--   Remover um membro da conta não pode apagar o registro de que ele
--   exportou a base — a pergunta "quem baixou os contatos" continua
--   precisando de resposta mesmo depois que a pessoa saiu.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_exports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  format      TEXT NOT NULL CHECK (format IN ('csv','xlsx')),
  scope       TEXT NOT NULL CHECK (scope IN ('filter','selection')),
  row_count   INT  NOT NULL,
  fields      TEXT[] NOT NULL,
  filter      JSONB,            -- {search, tag_ids, channel_ids} ou {selected: N}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_exports_account
  ON contact_exports(account_id, created_at DESC);

ALTER TABLE contact_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_exports_select ON contact_exports;
CREATE POLICY contact_exports_select ON contact_exports
  FOR SELECT USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE contact_exports IS
  'Trilha de auditoria de exportacoes de contatos (SPEC 051). So escrita pela rota POST /api/contacts/export via service role, depois de checar requireRole(admin). Sem policy de INSERT/UPDATE/DELETE de proposito.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'contact_exports'
  ) THEN
    RAISE EXCEPTION '064: tabela contact_exports nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'contact_exports' AND policyname = 'contact_exports_select'
  ) THEN
    RAISE EXCEPTION '064: policy contact_exports_select ausente.';
  END IF;
END $$;
