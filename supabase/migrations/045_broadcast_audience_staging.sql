-- ============================================================
-- 045_broadcast_audience_staging.sql — audiência importada, antes
-- de virar disparo (SPEC 044 §3.3 e §8.2)
--
-- Por que isto existe
--
--   O wizard hoje carrega a audiência importada em `useState`. Um F5
--   apaga o trabalho, e uma "área de triagem" ROTEADA
--   (/broadcasts/new/[draftId]/triage) não tem como existir sem um
--   identificador persistido. Esta tabela é esse identificador: o
--   rascunho passa a carregar a audiência de verdade, o que de quebra
--   fecha a lacuna de rascunho da §1.5 (hoje `handleSaveDraft` grava só
--   `{type, tagIds}` e descarta o resto).
--
--   Uma linha aqui é uma linha da PLANILHA depois de normalizada — não
--   um contato. `existing_contact_id` diz se aquele número já existe na
--   base; a materialização em `contacts` só acontece no envio.
--
-- Ciclo de vida
--
--   ON DELETE CASCADE a partir de `broadcasts`: enviar ou descartar o
--   rascunho leva as linhas junto, sem código de limpeza. Para o
--   rascunho que o usuário abandona sem apagar, existe
--   `purge_stale_audience_staging` no fim deste arquivo.
--
-- Desvios do esboço da §8.2, ambos deliberados
--
--   1. `phone_normalized` é coluna GERADA, não escrita pela aplicação.
--      Espelha exatamente o que a 022 fez em `contacts` — mesma
--      expressão, mesmo resultado — e torna impossível a coluna
--      divergir de `phone` por um caminho de escrita que esqueceu de
--      normalizar. O casamento com `contacts.phone_normalized` depende
--      de as duas colunas serem produzidas pela MESMA regra.
--   2. O índice único é PARCIAL. A §3.5 exige que linhas inválidas
--      sobrevivam (com `sourceRow` e motivo) em vez de sumirem em
--      silêncio — mas "abc" e "xyz" normalizam ambos para '' e
--      colidiriam num índice único total, fazendo o segundo insert
--      falhar. O índice cobre só as linhas válidas, que é onde a
--      garantia importa: um número válido não entra duas vezes no mesmo
--      rascunho.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) TABELA
-- ============================================================
CREATE TABLE IF NOT EXISTS broadcast_audience_staging (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  broadcast_id        UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,

  -- Desnormalizado de `broadcasts` de propósito: deixa a RLS decidir
  -- por associação de conta sem um JOIN por linha, e mantém a limpeza
  -- por conta barata. A política de escrita abaixo garante que ele
  -- nunca discorde da conta do broadcast.
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  phone               TEXT NOT NULL,

  -- Mesma expressão da 022 em `contacts.phone_normalized`. É o que
  -- permite casar "+55 (11) 98888-7777" da planilha com o que já está
  -- no banco, independentemente de como foi digitado nos dois lados.
  phone_normalized    TEXT GENERATED ALWAYS AS
                        (regexp_replace(phone, '\D', '', 'g')) STORED,

  name                TEXT,
  email               TEXT,
  company             TEXT,

  -- Etiquetas vindas da planilha, por NOME. Ainda não são
  -- `contact_tags`: o contato pode nem existir. Viram vínculo real no
  -- envio.
  tag_names           TEXT[] NOT NULL DEFAULT '{}',

  -- NULL = número novo, ainda não é contato. O badge "Novo" da triagem
  -- sai daqui. ON DELETE SET NULL espelha a 004: apagar o contato não
  -- pode derrubar a linha do rascunho.
  existing_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  selected            BOOLEAN NOT NULL DEFAULT TRUE,

  -- NULL = linha válida. Preenchido com 'missing_phone',
  -- 'invalid_phone' ou 'duplicate_in_file' — as mesmas chaves que a UI
  -- traduz em `audience.invalidReason.*`.
  invalid_reason      TEXT,

  -- Índice 1-based na planilha original. Existe para a mensagem de erro
  -- poder dizer "linha 47" em vez de "uma das linhas".
  source_row          INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE broadcast_audience_staging IS
  'Linhas de planilha normalizadas de um rascunho de disparo, antes da triagem. Efêmeras: cascateiam do broadcast (SPEC 044 §3.3).';
COMMENT ON COLUMN broadcast_audience_staging.phone_normalized IS
  'Gerada — mesma expressão de contacts.phone_normalized (022). Nunca escrever à mão.';
COMMENT ON COLUMN broadcast_audience_staging.existing_contact_id IS
  'NULL = número ainda não cadastrado. Preenchido pelo cruzamento por phone_normalized no momento do stage.';
COMMENT ON COLUMN broadcast_audience_staging.invalid_reason IS
  'NULL = válida. Chaves: missing_phone | invalid_phone | duplicate_in_file.';

-- ============================================================
-- 2) ÍNDICES
-- ============================================================

-- Toda leitura de triagem é "as linhas deste rascunho".
CREATE INDEX IF NOT EXISTS idx_bas_broadcast
  ON broadcast_audience_staging(broadcast_id);

-- O envio lê só as selecionadas; o parcial mantém o índice do tamanho
-- do que interessa mesmo num rascunho onde quase tudo foi desmarcado.
CREATE INDEX IF NOT EXISTS idx_bas_selected
  ON broadcast_audience_staging(broadcast_id)
  WHERE selected;

-- O enriquecimento da triagem (046) junta cada linha ao histórico do
-- contato por este id. Sem o índice, é seq scan por página.
CREATE INDEX IF NOT EXISTS idx_bas_contact
  ON broadcast_audience_staging(existing_contact_id)
  WHERE existing_contact_id IS NOT NULL;

-- Um número VÁLIDO não entra duas vezes no mesmo rascunho. Ver o
-- desvio 2 no cabeçalho: linhas inválidas ficam de fora do índice
-- porque todas normalizam para '' e colidiriam entre si.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bas_unique_phone
  ON broadcast_audience_staging(broadcast_id, phone_normalized)
  WHERE invalid_reason IS NULL AND phone_normalized <> '';

-- ============================================================
-- 3) RLS — espelha `broadcast_recipients` (017:566-572)
--
-- Leitura para qualquer membro da conta (um `viewer` pode revisar a
-- audiência); escrita a partir de `agent`, que é o mesmo piso de quem
-- pode disparar.
-- ============================================================
ALTER TABLE broadcast_audience_staging ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bas_select ON broadcast_audience_staging;
CREATE POLICY bas_select ON broadcast_audience_staging
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS bas_modify ON broadcast_audience_staging;
CREATE POLICY bas_modify ON broadcast_audience_staging
  FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    -- Sem esta segunda condição, um membro da conta A poderia inserir
    -- linhas com account_id = A apontando para um `broadcast_id` da
    -- conta B — passando na checagem de associação e ainda assim
    -- poluindo o rascunho de outro. O lookup é por PK, então custa
    -- praticamente nada.
    AND EXISTS (
      SELECT 1 FROM broadcasts b
      WHERE b.id = broadcast_audience_staging.broadcast_id
        AND b.account_id = broadcast_audience_staging.account_id
    )
  );

-- ============================================================
-- 4) LIMPEZA DE RASCUNHOS ABANDONADOS
--
-- O CASCADE cobre enviar/descartar. O que ele não cobre é o rascunho
-- que fica parado: 50 000 linhas staged de uma planilha que ninguém
-- vai disparar continuam ocupando espaço para sempre.
--
-- Apaga apenas as LINHAS STAGED, nunca o `broadcasts`. O rascunho em si
-- é trabalho do usuário — ele continua na lista, só perde a lista de
-- audiência anexada, que é reimportável. Apagar o rascunho seria
-- destruir algo que o usuário criou de propósito.
--
-- SECURITY DEFINER com guarda de associação, padrão da 039/044: a
-- varredura por `created_at` sob RLS por linha seria cara, e a função
-- não precisa de mais permissão do que "esta conta, este rascunho".
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_stale_audience_staging(
  p_account_id UUID,
  p_older_than_days INT DEFAULT 7
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_older_than_days IS NULL OR p_older_than_days < 1 OR p_older_than_days > 365 THEN
    p_older_than_days := 7;
  END IF;

  WITH doomed AS (
    DELETE FROM broadcast_audience_staging s
    USING broadcasts b
    WHERE b.id = s.broadcast_id
      AND s.account_id = p_account_id
      -- Só rascunho. Um broadcast já enviado tem histórico próprio em
      -- broadcast_recipients e não deveria ter linhas staged, mas se
      -- tiver, não é este o lugar de decidir apagá-las.
      AND b.status = 'draft'
      AND s.created_at < NOW() - make_interval(days => p_older_than_days)
    RETURNING s.id
  )
  SELECT count(*) INTO v_deleted FROM doomed;

  RETURN COALESCE(v_deleted, 0);
END;
$$;

ALTER FUNCTION public.purge_stale_audience_staging(UUID, INT) OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon**, separadamente — ver a lição
-- registrada na 044 §4: o Supabase mantém ALTER DEFAULT PRIVILEGES
-- concedendo EXECUTE a `anon` e `authenticated` em toda função nova de
-- `public`, e essa concessão é nominal, não herdada de PUBLIC. O revoke
-- de PUBLIC sozinho passa ao largo dela e deixa a função aberta.
REVOKE ALL ON FUNCTION public.purge_stale_audience_staging(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_stale_audience_staging(UUID, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.purge_stale_audience_staging(UUID, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.purge_stale_audience_staging(UUID, INT) IS
  'Apaga linhas staged de rascunhos parados há mais de N dias (padrão 7). Não apaga o broadcast. Guarda is_account_member(agent) — DEFINER roda com RLS desligada.';

-- ============================================================
-- 5) ASSERÇÕES — mesma postura da 042/044
--
-- Um REVOKE que não pegou, ou uma RLS que não ficou ligada, falharia em
-- silêncio e a migração reportaria sucesso sobre um banco exposto.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'purge_stale_audience_staging'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      '045: purge_stale_audience_staging continua executavel por anon. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.broadcast_audience_staging'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION
      '045: RLS nao esta ativa em broadcast_audience_staging.';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'broadcast_audience_staging') < 2 THEN
    RAISE EXCEPTION
      '045: broadcast_audience_staging deveria ter 2 politicas (select + modify).';
  END IF;
END;
$$;
