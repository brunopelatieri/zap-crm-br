-- ============================================================
-- 048_lgpd_consent_and_scheduling.sql — consentimento (LGPD) e
-- agendamento de disparo (SPEC 044 §6.8 e §6.3)
--
-- Por que isto existe
--
--   Duas lacunas que a fase 7 fecha, e que compartilham as MESMAS
--   tabelas de trilha:
--
--     §6.8 (LGPD). Não existe hoje nenhum registro de consentimento no
--     banco. Um contato que pede "SAIR" no WhatsApp continua entrando em
--     toda audiência de marketing seguinte, e não há como provar depois
--     quando ele pediu para sair nem por qual via. No mercado brasileiro
--     isso não é polimento: é o que separa uma conta que dura de uma
--     que é banida (e, do lado jurídico, o que a LGPD art. 8º §5 exige
--     poder demonstrar).
--
--     §6.3 (agendamento). `broadcasts.scheduled_at` existe desde a
--     001:302 e o CHECK de status já aceita 'scheduled' (001:303) —
--     nunca foram usados. Faltavam três coisas para o cron poder
--     retomar um disparo sem o navegador: o fuso em que o horário foi
--     escolhido, a URL de mídia do header (que a §12 item 8 registra
--     como "sem coluna em broadcasts", e é o que impedia QUALQUER
--     retomada server-side) e um índice para a varredura.
--
-- Três decisões que valem ser lidas antes de mexer
--
--   1. **O opt-out é um FATO com origem e hora, não um booleano.**
--      `contacts.opt_in_status` é o estado atual (barato de filtrar) e
--      `contact_consent_events` é a trilha imutável que responde "quem,
--      quando, por qual via". Só o estado seria impossível de auditar;
--      só a trilha tornaria cada audiência uma agregação.
--   2. **A trilha não tem política de UPDATE nem de DELETE.** Não é
--      esquecimento: uma trilha de auditoria editável não é trilha. Só
--      o `service_role` (o operador do self-host) alcança essas linhas.
--   3. **Quem escreve consentimento é a RPC, não a tabela.**
--      `set_contact_opt_in` faz o UPDATE e o INSERT do evento na mesma
--      transação. Deixar a UI escrever direto em `contacts` permitiria
--      um caminho que muda o estado e "esquece" o evento — exatamente o
--      furo que a trilha existe para não ter.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) ESTADO DE CONSENTIMENTO EM `contacts`
--
-- Default 'unknown', não 'opted_in': a base existente foi importada de
-- planilha e ninguém sabe o que cada pessoa consentiu. Presumir consentimento
-- retroativo seria escrever uma afirmação falsa no banco. 'unknown' NÃO
-- bloqueia envio (bloquear invalidaria toda a base no dia da migração);
-- quem bloqueia é 'opted_out'.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opt_in_status     TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS opt_in_source     TEXT,
  ADD COLUMN IF NOT EXISTS opt_in_updated_at TIMESTAMPTZ;

-- CHECK adicionado à parte (ADD COLUMN IF NOT EXISTS não aceita
-- re-declarar constraint em re-execução).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_opt_in_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_opt_in_status_check
      CHECK (opt_in_status IN ('opted_in', 'opted_out', 'unknown'));
  END IF;
END;
$$;

COMMENT ON COLUMN contacts.opt_in_status IS
  'Consentimento de marketing: opted_in | opted_out | unknown (SPEC 044 §6.8). opted_out nunca entra em audiencia de marketing. Escrever pela RPC set_contact_opt_in, nunca direto.';
COMMENT ON COLUMN contacts.opt_in_source IS
  'Como o estado atual foi definido: inbound_keyword | manual | import | api | automation.';
COMMENT ON COLUMN contacts.opt_in_updated_at IS
  'Quando o estado atual passou a valer. NULL = nunca declarado (opt_in_status = unknown de nascimento).';

-- Parcial: a pergunta que o código faz é sempre "quem desta conta está
-- em opt-out", e os opted_out são a minoria. O índice fica do tamanho
-- da exceção, não da base.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts(account_id)
  WHERE opt_in_status = 'opted_out';

-- ============================================================
-- 2) TRILHA DE CONSENTIMENTO — imutável
--
-- Uma linha por declaração, não por mudança de estado: um segundo
-- "SAIR" É uma segunda declaração, e apagá-la do histórico porque o
-- estado já era 'opted_out' esconderia justamente a insistência que
-- interessa numa disputa.
--
-- `message_text` NÃO é armazenado de propósito. O que a auditoria
-- precisa é a palavra-chave que casou; guardar o texto inteiro do
-- inbound seria coletar dado pessoal a mais para provar o oposto.
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_consent_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- ON DELETE SET NULL espelha a 004: apagar o contato não pode
  -- destruir a prova de que ele pediu para sair.
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Telefone desnormalizado — é o que sobra quando o contato é apagado
  -- e o que torna a trilha legível sem JOIN.
  phone               TEXT,

  status              TEXT NOT NULL
                        CHECK (status IN ('opted_in', 'opted_out', 'unknown')),

  source              TEXT NOT NULL
                        CHECK (source IN ('inbound_keyword', 'manual',
                                          'import', 'api', 'automation')),

  -- Preenchido só quando source = 'inbound_keyword'.
  keyword             TEXT,
  whatsapp_message_id TEXT,

  -- NULL = sistema (webhook / cron). Um humano deixa o id aqui.
  actor_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE contact_consent_events IS
  'Trilha imutavel de declaracoes de consentimento (SPEC 044 §6.8). Sem politica de UPDATE/DELETE — de proposito.';

CREATE INDEX IF NOT EXISTS idx_consent_events_contact
  ON contact_consent_events(contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_events_account
  ON contact_consent_events(account_id, created_at DESC);

ALTER TABLE contact_consent_events ENABLE ROW LEVEL SECURITY;

-- Leitura para qualquer membro: um `viewer` precisa poder conferir se
-- aquele contato pediu para sair antes de escrever para ele.
DROP POLICY IF EXISTS cce_select ON contact_consent_events;
CREATE POLICY cce_select ON contact_consent_events
  FOR SELECT USING (is_account_member(account_id));

-- Escrita a partir de `agent` — o mesmo piso de quem conversa com o
-- cliente e portanto de quem registra o que ele declarou. A RPC roda
-- como INVOKER e é esta política que a autoriza.
DROP POLICY IF EXISTS cce_insert ON contact_consent_events;
CREATE POLICY cce_insert ON contact_consent_events
  FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    -- Sem esta segunda condição, um membro da conta A poderia gravar um
    -- evento com account_id = A apontando para um contato da conta B.
    AND (
      contact_id IS NULL
      OR EXISTS (
        SELECT 1 FROM contacts c
        WHERE c.id = contact_consent_events.contact_id
          AND c.account_id = contact_consent_events.account_id
      )
    )
  );

-- Sem policy de UPDATE e sem policy de DELETE: ver a decisão 2 do
-- cabeçalho. RLS ligada + nenhuma política = ninguém além do
-- service_role altera a trilha.

-- `anon` fica sem privilégio de tabela, e não só sem política. A RLS já
-- barraria (auth.uid() é NULL, logo `is_account_member` é falso), mas
-- estas linhas carregam telefone e nome — depender de uma única camada
-- para PII é como as seis funções da 042 ficaram abertas. Mesmo
-- raciocínio do REVOKE de funções, aplicado à tabela.
REVOKE ALL ON TABLE contact_consent_events FROM anon;

-- ============================================================
-- 3) TRILHA DE DISPARO — quem disparou, para quantos, com qual template
--
-- O terceiro item da §6.8. A linha de `broadcasts` já diz quem criou e
-- qual template, mas ela é MUTÁVEL (o contador muda a cada webhook, o
-- rascunho staged é reaproveitado no envio) e não registra o que NÃO
-- aconteceu: um agendamento adiado por estar fora da janela, um disparo
-- recusado pela cota. É por isso que a trilha é uma tabela à parte, e
-- não uma leitura de `broadcasts`.
--
-- Serve às duas seções: a §6.8 pede a trilha, e é aqui que a §6.3
-- explica por que um disparo agendado para 23h não saiu às 23h.
-- ============================================================
CREATE TABLE IF NOT EXISTS broadcast_audit_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- SET NULL, não CASCADE: apagar a campanha não apaga o registro de
  -- que ela foi disparada para 3 000 pessoas.
  broadcast_id     UUID REFERENCES broadcasts(id) ON DELETE SET NULL,

  -- Nome guardado junto porque `broadcast_id` pode virar NULL.
  broadcast_name   TEXT,

  event            TEXT NOT NULL
                     CHECK (event IN ('dispatched', 'scheduled', 'rescheduled',
                                      'postponed_window', 'blocked_window',
                                      'blocked_quota', 'canceled', 'failed')),

  -- NULL = sistema (o cron). Um humano deixa o id aqui.
  actor_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  template_name    TEXT,
  total_recipients INTEGER,

  -- Quantos contatos foram removidos da audiência por estarem em
  -- opt-out. É o número que prova a §6.8 em cada disparo.
  excluded_opted_out INTEGER NOT NULL DEFAULT 0,

  scheduled_at     TIMESTAMPTZ,

  -- Espaço para o motivo/contexto do evento (janela aplicada, novo
  -- horário, código de erro). JSONB para não precisar de migração a
  -- cada campo novo de contexto.
  details          JSONB NOT NULL DEFAULT '{}'::JSONB,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE broadcast_audit_log IS
  'Trilha de disparo: quem, para quantos, com qual template, e o que foi bloqueado/adiado (SPEC 044 §6.8, §6.3). Sem UPDATE/DELETE.';

CREATE INDEX IF NOT EXISTS idx_broadcast_audit_account
  ON broadcast_audit_log(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_broadcast_audit_broadcast
  ON broadcast_audit_log(broadcast_id)
  WHERE broadcast_id IS NOT NULL;

ALTER TABLE broadcast_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bal_select ON broadcast_audit_log;
CREATE POLICY bal_select ON broadcast_audit_log
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS bal_insert ON broadcast_audit_log;
CREATE POLICY bal_insert ON broadcast_audit_log
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

-- Sem UPDATE/DELETE, mesmo motivo da trilha de consentimento.
REVOKE ALL ON TABLE broadcast_audit_log FROM anon;

-- ============================================================
-- 4) AGENDAMENTO EM `broadcasts` (§6.3)
--
-- `scheduled_at` e o status 'scheduled' já existiam. O que faltava:
--
--   • `scheduled_timezone` — "20h" só significa algo com um fuso. Sem
--     esta coluna a janela de horário teria que ser avaliada em UTC, e
--     um agendamento das 19h em São Paulo pareceria 22h para o cron.
--   • `window_override` — o "override consciente" da §6.3, por disparo
--     e não por conta: quem aceita mandar às 23h aceita naquele
--     disparo, não para sempre.
--   • `header_media_url` — a §12 item 8 registra a ausência desta
--     coluna como o que amarrava qualquer retomada server-side. Sem
--     ela, um disparo agendado com header de imagem perderia a mídia
--     escolhida no passo 3 entre o agendamento e o envio.
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS scheduled_timezone TEXT,
  ADD COLUMN IF NOT EXISTS window_override    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS header_media_url   TEXT;

COMMENT ON COLUMN broadcasts.scheduled_timezone IS
  'Fuso IANA em que scheduled_at foi escolhido. O cron avalia a janela de horario neste fuso (SPEC 044 §6.3).';
COMMENT ON COLUMN broadcasts.window_override IS
  'TRUE = o usuario aceitou disparar fora da janela permitida. Por disparo, nunca por conta.';
COMMENT ON COLUMN broadcasts.header_media_url IS
  'URL de midia do header escolhida no passo 3. Persistida para o disparo agendado poder ser retomado sem o navegador.';

-- A varredura do cron é "scheduled e vencido". Parcial: campanhas em
-- outros status nunca entram nela.
CREATE INDEX IF NOT EXISTS idx_broadcasts_due
  ON broadcasts(scheduled_at)
  WHERE status = 'scheduled';

-- ============================================================
-- 5) RPC DE CONSENTIMENTO — estado + trilha na mesma transação
--
-- SECURITY INVOKER: são a RLS de `contacts` (017) e a política
-- `cce_insert` acima que decidem quem pode. A função não precisa de
-- privilégio nenhum além do de quem chama — precisa de ATOMICIDADE, que
-- é o que ela entrega.
--
-- Chamada tanto pela UI (como `authenticated`) quanto pelo webhook
-- (como `service_role`, que ignora RLS). No segundo caso `auth.uid()` é
-- NULL e o evento fica com `actor_user_id` NULL, que é exatamente o
-- significado de "quem registrou foi o sistema".
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_contact_opt_in(
  p_contact_id          UUID,
  p_status              TEXT,
  p_source              TEXT DEFAULT 'manual',
  p_keyword             TEXT DEFAULT NULL,
  p_whatsapp_message_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  contact_id        UUID,
  opt_in_status     TEXT,
  opt_in_updated_at TIMESTAMPTZ,
  changed           BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_phone      TEXT;
  v_previous   TEXT;
  v_now        TIMESTAMPTZ := NOW();
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('opted_in', 'opted_out', 'unknown') THEN
    RAISE EXCEPTION 'Invalid opt-in status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('inbound_keyword', 'manual',
                                          'import', 'api', 'automation') THEN
    RAISE EXCEPTION 'Invalid consent source: %', p_source
      USING ERRCODE = '22023';
  END IF;

  SELECT c.opt_in_status INTO v_previous
    FROM contacts c
   WHERE c.id = p_contact_id;

  UPDATE contacts c
     SET opt_in_status     = p_status,
         opt_in_source     = p_source,
         opt_in_updated_at = v_now
   WHERE c.id = p_contact_id
  RETURNING c.account_id, c.phone INTO v_account_id, v_phone;

  -- Zero linhas aqui significa "não existe" OU "a RLS não deixou".
  -- Os dois casos merecem a mesma resposta: não confirmar uma escrita
  -- que não aconteceu.
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Contact not found or not accessible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO contact_consent_events (
    account_id, contact_id, phone, status, source,
    keyword, whatsapp_message_id, actor_user_id
  ) VALUES (
    v_account_id, p_contact_id, v_phone, p_status, p_source,
    p_keyword, p_whatsapp_message_id, auth.uid()
  );

  RETURN QUERY
  SELECT p_contact_id, p_status, v_now,
         COALESCE(v_previous, 'unknown') IS DISTINCT FROM p_status;
END;
$$;

ALTER FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT)
  OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon**, separadamente — ver a lição da 044 §4:
-- o Supabase mantém ALTER DEFAULT PRIVILEGES concedendo EXECUTE a
-- `anon` em toda função nova de `public`, e essa concessão é nominal,
-- não herdada de PUBLIC.
REVOKE ALL ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_contact_opt_in(UUID, TEXT, TEXT, TEXT, TEXT) IS
  'Grava estado de consentimento + evento de trilha na mesma transacao (SPEC 044 §6.8). SECURITY INVOKER — RLS de contacts decide o escopo.';

-- ============================================================
-- 6) `broadcast_quota_usage` — liberar o caminho do cron
--
-- A guarda original é `is_account_member(p_account_id)`, que lê
-- `auth.uid()`. O cron da §6.3 roda SEM usuário (service_role), então a
-- guarda o barraria com 42501 e o disparo agendado morreria na leitura
-- de cota — a única peça do caminho que não é uma consulta de tabela.
--
-- A liberação é para `service_role` e só para ele. Não é afrouxamento:
-- quem tem a chave service-role já lê `broadcast_recipients` inteiro
-- direto, sem RLS. `anon` continua sem EXECUTE (asserção no fim), e
-- `authenticated` continua passando pela guarda de associação.
--
-- Mesma assinatura da 044 → CREATE OR REPLACE, sem DROP.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcast_quota_usage(
  p_account_id UUID,
  p_window_hours INT DEFAULT 24
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count BIGINT;
  v_role  TEXT;
BEGIN
  -- O claim vem do PostgREST. Ausente (psql direto) ou ilegível → trata
  -- como "não é service_role" e cai na guarda de associação.
  BEGIN
    v_role := current_setting('request.jwt.claims', true)::json ->> 'role';
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;

  IF COALESCE(v_role, '') <> 'service_role'
     AND NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 168 THEN
    p_window_hours := 24;
  END IF;

  SELECT COUNT(DISTINCT br.contact_id)
    INTO v_count
    FROM broadcast_recipients br
    JOIN broadcasts b ON b.id = br.broadcast_id
   WHERE b.account_id = p_account_id
     AND br.contact_id IS NOT NULL
     AND br.sent_at >= NOW() - make_interval(hours => p_window_hours)
     AND br.status IN ('sent', 'delivered', 'read', 'replied');

  RETURN COALESCE(v_count, 0);
END;
$$;

ALTER FUNCTION public.broadcast_quota_usage(UUID, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_quota_usage(UUID, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_quota_usage(UUID, INT) IS
  'Contatos distintos alcancados por disparo na janela (padrao 24 h). Guarda is_account_member, com excecao explicita para service_role (cron da §6.3).';

-- ============================================================
-- 7) VIEW DE TRIAGEM — agora com consentimento
--
-- Recriada (não alterada): a 046 já usa DROP + CREATE aqui, e uma view
-- não aceita coluna nova por ALTER sem reescrever a definição.
--
-- `is_opted_out` é derivado e não COALESCE-ado para FALSE por descuido:
-- uma linha de planilha que ainda não é contato NÃO está em opt-out —
-- ninguém nunca lhe perguntou. FALSE é o valor certo, e o comentário
-- existe para que a próxima pessoa não "conserte" isso para NULL.
-- ============================================================
DROP VIEW IF EXISTS public.broadcast_audience_triage;

CREATE VIEW public.broadcast_audience_triage
WITH (security_invoker = true) AS
SELECT
  s.id,
  s.broadcast_id,
  s.account_id,
  s.phone,
  s.phone_normalized,
  COALESCE(NULLIF(s.name, ''), c.name) AS name,
  s.email,
  s.company,
  s.existing_contact_id,
  s.selected,
  s.invalid_reason,
  s.source_row,
  s.created_at,

  (s.existing_contact_id IS NULL) AS is_new,

  -- ── Consentimento (§6.8) ────────────────────────────────────
  COALESCE(c.opt_in_status, 'unknown')          AS opt_in_status,
  (COALESCE(c.opt_in_status, 'unknown') = 'opted_out') AS is_opted_out,

  -- ── Histórico por contato (§5.1) ────────────────────────────
  COALESCE(h.campaigns_received, 0) AS campaigns_received,
  h.last_delivered_at,
  h.last_sent_at,
  h.last_replied_at,
  COALESCE(h.has_read,    FALSE)    AS has_read,
  COALESCE(h.has_replied, FALSE)    AS has_replied,
  COALESCE(h.failure_count, 0)      AS failure_count,

  COALESCE(t.tag_names, '{}'::TEXT[]) AS tag_names

FROM broadcast_audience_staging s

LEFT JOIN contacts c
  ON c.id = s.existing_contact_id

LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (
      WHERE br.status IN ('sent', 'delivered', 'read', 'replied')
    )                                            AS campaigns_received,
    max(br.delivered_at)                         AS last_delivered_at,
    max(br.sent_at)                              AS last_sent_at,
    max(br.replied_at)                           AS last_replied_at,
    bool_or(br.read_at    IS NOT NULL)           AS has_read,
    bool_or(br.replied_at IS NOT NULL)           AS has_replied,
    count(*) FILTER (WHERE br.status = 'failed') AS failure_count
  FROM broadcast_recipients br
  WHERE br.contact_id = s.existing_contact_id
) h ON s.existing_contact_id IS NOT NULL

LEFT JOIN LATERAL (
  SELECT array_agg(tg.name ORDER BY tg.name) AS tag_names
  FROM contact_tags ct
  JOIN tags tg ON tg.id = ct.tag_id
  WHERE ct.contact_id = s.existing_contact_id
) t ON s.existing_contact_id IS NOT NULL;

ALTER VIEW public.broadcast_audience_triage OWNER TO postgres;

REVOKE ALL ON public.broadcast_audience_triage FROM PUBLIC;
REVOKE ALL ON public.broadcast_audience_triage FROM anon;
GRANT SELECT ON public.broadcast_audience_triage TO authenticated, service_role;

COMMENT ON VIEW public.broadcast_audience_triage IS
  'Linha de triagem enriquecida com historico do contato (§5.1) e consentimento (§6.8). security_invoker — a RLS de quem chama e que vale.';

-- ============================================================
-- 8) FILTROS DE TRIAGEM — dois nomes novos
--
-- 'opted_out'  → quem pediu para sair (para conferir e remover)
-- 'optable'    → o complemento: quem PODE receber marketing
--
-- Mesma assinatura → CREATE OR REPLACE.
-- ============================================================
CREATE OR REPLACE FUNCTION public.triage_assert_filter(p_filter TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_filter IS NULL OR p_filter = '' THEN
    RETURN; -- ausente = sem filtro, igual a 'all'
  END IF;

  IF p_filter NOT IN (
    -- Estado da linha
    'all', 'selected', 'unselected',
    'valid', 'invalid',
    'new', 'existing',
    -- Presets de engajamento (§6.5)
    'engaged', 'reads_no_reply', 'dormant', 'never_contacted', 'problematic',
    -- Anti-fadiga (§6.2)
    'cooldown',
    -- Consentimento (§6.8)
    'opted_out', 'optable'
  ) THEN
    RAISE EXCEPTION 'Unknown triage filter: %', p_filter
      USING ERRCODE = '22023';
  END IF;
END;
$$;

ALTER FUNCTION public.triage_assert_filter(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_assert_filter(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_assert_filter(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_assert_filter(TEXT) TO authenticated, service_role;

-- ============================================================
-- 9) PREDICADO DE FILTRO — um parâmetro novo
--
-- A assinatura MUDA (ganha `r_opted_out`), então é DROP + CREATE: um
-- CREATE OR REPLACE criaria uma SOBRECARGA, e duas versões da mesma
-- função conviveriam com o planejador escolhendo por tipo de argumento.
--
-- Continua sem `SET search_path`, pela razão da 046 §3: função SQL com
-- cláusula SET não é INLINÁVEL, e sem inline isto vira uma chamada por
-- linha sobre até 50 000 linhas. Segue seguro pelo mesmo motivo — é
-- SECURITY INVOKER e o corpo só usa `pg_catalog`.
-- ============================================================
DROP FUNCTION IF EXISTS public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.triage_row_matches(
  p_filter          TEXT,
  p_search          TEXT,
  r_name            TEXT,
  r_phone           TEXT,
  r_selected        BOOLEAN,
  r_invalid_reason  TEXT,
  r_is_new          BOOLEAN,
  r_campaigns       BIGINT,
  r_has_read        BOOLEAN,
  r_has_replied     BOOLEAN,
  r_failure_count   BIGINT,
  r_last_replied_at TIMESTAMPTZ,
  r_last_sent_at    TIMESTAMPTZ,
  r_opted_out       BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    (
      p_search IS NULL
      OR p_search = ''
      OR r_name  ILIKE '%' || p_search || '%'
      OR r_phone ILIKE '%' || p_search || '%'
    )
    AND
    CASE COALESCE(NULLIF(p_filter, ''), 'all')
      WHEN 'all'             THEN TRUE
      WHEN 'selected'        THEN r_selected
      WHEN 'unselected'      THEN NOT r_selected
      WHEN 'valid'           THEN r_invalid_reason IS NULL
      WHEN 'invalid'         THEN r_invalid_reason IS NOT NULL
      WHEN 'new'             THEN r_is_new
      WHEN 'existing'        THEN NOT r_is_new
      -- 🔥 respondeu alguma campanha nos últimos 30 dias
      WHEN 'engaged'         THEN r_last_replied_at >= NOW() - INTERVAL '30 days'
      -- 👀 abre, mas nunca respondeu
      WHEN 'reads_no_reply'  THEN r_has_read AND NOT r_has_replied
      -- 😴 recebeu bastante e nunca abriu
      WHEN 'dormant'         THEN r_campaigns >= 3 AND NOT r_has_read
      WHEN 'never_contacted' THEN r_campaigns = 0
      -- ⚠️ candidato a número morto (§6.4)
      WHEN 'problematic'     THEN r_failure_count >= 2
      -- Em cooldown: recebeu algo nos últimos 7 dias (§6.2)
      WHEN 'cooldown'        THEN r_last_sent_at >= NOW() - INTERVAL '7 days'
      -- 🚫 pediu para sair (§6.8)
      WHEN 'opted_out'       THEN r_opted_out
      -- ✅ o complemento: quem pode receber marketing E tem número válido
      WHEN 'optable'         THEN NOT r_opted_out AND r_invalid_reason IS NULL
      ELSE FALSE
    END;
$$;

ALTER FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
) TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_row_matches(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BIGINT,
  BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN
) IS
  'Predicado de filtro+busca da triagem. Fonte unica das tres RPCs; ganhou consentimento na 048.';

-- ============================================================
-- 10) PÁGINA DA TABELA — devolve o consentimento por linha
--
-- RETURNS TABLE muda de forma → DROP obrigatório (CREATE OR REPLACE
-- não altera o tipo de retorno).
-- ============================================================
DROP FUNCTION IF EXISTS public.triage_audience_page(UUID, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.triage_audience_page(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all',
  p_limit    INT  DEFAULT 50,
  p_offset   INT  DEFAULT 0
)
RETURNS TABLE (
  id                 UUID,
  phone              TEXT,
  name               TEXT,
  email              TEXT,
  company            TEXT,
  selected           BOOLEAN,
  invalid_reason     TEXT,
  source_row         INTEGER,
  is_new             BOOLEAN,
  existing_contact_id UUID,
  campaigns_received BIGINT,
  last_delivered_at  TIMESTAMPTZ,
  last_sent_at       TIMESTAMPTZ,
  has_read           BOOLEAN,
  has_replied        BOOLEAN,
  failure_count      BIGINT,
  tag_names          TEXT[],
  opt_in_status      TEXT,
  is_opted_out       BOOLEAN,
  total_count        BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM triage_assert_filter(p_filter);

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    p_limit := 50;
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    p_offset := 0;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*, count(*) OVER() AS total_count
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out
          )
  )
  SELECT
    f.id, f.phone, f.name, f.email, f.company,
    f.selected, f.invalid_reason, f.source_row,
    f.is_new, f.existing_contact_id,
    f.campaigns_received, f.last_delivered_at, f.last_sent_at,
    f.has_read, f.has_replied, f.failure_count,
    f.tag_names, f.opt_in_status, f.is_opted_out, f.total_count
  FROM filtered f
  ORDER BY f.source_row NULLS LAST, f.created_at, f.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

ALTER FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) IS
  'Uma pagina da tabela de triagem, com historico, consentimento e total do filtro. SECURITY INVOKER.';

-- ============================================================
-- 11) RESUMO DA AUDIÊNCIA — dois números novos
--
-- `opted_out_rows`      → quantos pediram para sair
-- `sendable_rows`       → selecionadas, válidas E fora do opt-out
-- `selected_valid_rows` → selecionadas e válidas, INCLUINDO opt-out
--
-- Os dois últimos existem porque a exclusão vale para MARKETING (§6.8),
-- não para todo template: um template Utility legítimo alcança quem
-- optou por sair de marketing. Quem decide qual dos dois números é "o
-- alcance" é o chamador, que conhece a categoria do template — mas os
-- dois vêm da MESMA passada, para não haver duas contagens divergentes
-- (a lição do §7 item 3).
-- ============================================================
DROP FUNCTION IF EXISTS public.audience_engagement_summary(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.audience_engagement_summary(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS TABLE (
  total_rows          BIGINT,
  selected_rows       BIGINT,
  valid_rows          BIGINT,
  invalid_rows        BIGINT,
  new_contacts        BIGINT,
  existing_contacts   BIGINT,
  ever_contacted      BIGINT,
  ever_read           BIGINT,
  ever_replied        BIGINT,
  never_delivered     BIGINT,
  problematic         BIGINT,
  in_cooldown         BIGINT,
  opted_out_rows      BIGINT,
  selected_valid_rows BIGINT,
  sendable_rows       BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM triage_assert_filter(p_filter);

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out
          )
  )
  SELECT
    count(*)                                                          AS total_rows,
    count(*) FILTER (WHERE f.selected)                                AS selected_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NULL)                  AS valid_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NOT NULL)              AS invalid_rows,
    count(*) FILTER (WHERE f.is_new AND f.invalid_reason IS NULL)      AS new_contacts,
    count(*) FILTER (WHERE NOT f.is_new AND f.invalid_reason IS NULL)  AS existing_contacts,
    count(*) FILTER (WHERE f.campaigns_received > 0)                  AS ever_contacted,
    count(*) FILTER (WHERE f.has_read)                                AS ever_read,
    count(*) FILTER (WHERE f.has_replied)                             AS ever_replied,
    count(*) FILTER (
      WHERE NOT f.is_new AND f.last_delivered_at IS NULL
    )                                                                 AS never_delivered,
    count(*) FILTER (WHERE f.failure_count >= 2)                      AS problematic,
    count(*) FILTER (
      WHERE f.last_sent_at >= NOW() - INTERVAL '7 days'
    )                                                                 AS in_cooldown,
    count(*) FILTER (WHERE f.is_opted_out)                            AS opted_out_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL
    )                                                                 AS selected_valid_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL AND NOT f.is_opted_out
    )                                                                 AS sendable_rows
  FROM filtered f;
END;
$$;

ALTER FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) IS
  'Agregados da audiencia staged, com consentimento (§6.8) e o alcance efetivo (sendable_rows), no mesmo filtro+busca da tabela.';

-- ============================================================
-- 12) SELEÇÃO EM MASSA — passa o parâmetro novo ao predicado
--
-- Assinatura inalterada; o corpo precisa acompanhar o predicado. Com o
-- filtro 'opted_out' + `p_selected = false`, isto passa a ser a ação
-- "remover quem pediu para sair" da §5.4, sem código novo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.triage_set_selection(
  p_draft_id UUID,
  p_selected BOOLEAN,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_changed BIGINT;
BEGIN
  IF p_selected IS NULL THEN
    RAISE EXCEPTION 'p_selected is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM triage_assert_filter(p_filter);

  WITH target AS (
    SELECT v.id
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out
          )
  ),
  updated AS (
    UPDATE broadcast_audience_staging s
       SET selected = p_selected
      FROM target
     WHERE s.id = target.id
       AND s.selected IS DISTINCT FROM p_selected
    RETURNING s.id
  )
  SELECT count(*) INTO v_changed FROM updated;

  RETURN COALESCE(v_changed, 0);
END;
$$;

ALTER FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================
-- 13) ASSERÇÕES — padrão 042/044/045/046
--
-- Um REVOKE que não pegou, uma RLS que não ficou ligada ou uma política
-- de UPDATE que apareceu por engano na trilha falhariam em silêncio, e
-- a migração reportaria sucesso sobre um banco que não cumpre o que
-- este arquivo promete.
-- ============================================================
DO $$
DECLARE
  v_abertas TEXT[];
BEGIN
  -- ── ACL das funções ──────────────────────────────────────────
  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   ORDER BY p.proname)
    INTO v_abertas
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('set_contact_opt_in', 'broadcast_quota_usage',
                       'triage_audience_page', 'audience_engagement_summary',
                       'triage_set_selection', 'triage_row_matches',
                       'triage_assert_filter')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      '048: estas funcoes continuam executaveis por anon: %. O REVOKE nao pegou — confira a assinatura exata em pg_proc antes de seguir.',
      array_to_string(v_abertas, ', ')
      USING ERRCODE = '55006';
  END IF;

  -- ── Sobrecarga do predicado ──────────────────────────────────
  -- Duas versões de triage_row_matches conviverem é pior do que
  -- nenhuma: o planejador escolheria por tipo de argumento e o filtro
  -- 'opted_out' cairia silenciosamente no ELSE FALSE da versão antiga.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'triage_row_matches') <> 1 THEN
    RAISE EXCEPTION
      '048: existe mais de uma versao de triage_row_matches. O DROP da assinatura de 13 argumentos nao pegou.';
  END IF;

  -- ── View com consentimento e sem vazamento ───────────────────
  IF has_table_privilege('anon', 'public.broadcast_audience_triage', 'SELECT') THEN
    RAISE EXCEPTION
      '048: a view broadcast_audience_triage continua legivel por anon.';
  END IF;

  IF NOT (
    SELECT c.reloptions::TEXT LIKE '%security_invoker=%true%'
    FROM pg_class c
    WHERE c.oid = 'public.broadcast_audience_triage'::regclass
  ) THEN
    RAISE EXCEPTION
      '048: a view broadcast_audience_triage NAO esta com security_invoker.';
  END IF;

  -- ── RLS das trilhas ─────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.contact_consent_events'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '048: RLS nao esta ativa em contact_consent_events.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.broadcast_audit_log'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '048: RLS nao esta ativa em broadcast_audit_log.';
  END IF;

  -- ── PII das trilhas fora do alcance de anon ─────────────────
  IF has_table_privilege('anon', 'public.contact_consent_events', 'SELECT')
     OR has_table_privilege('anon', 'public.broadcast_audit_log', 'SELECT') THEN
    RAISE EXCEPTION
      '048: uma das trilhas continua legivel por anon. O REVOKE nao pegou.';
  END IF;

  -- ── Imutabilidade: nenhuma politica de UPDATE ou DELETE ──────
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('contact_consent_events', 'broadcast_audit_log')
      AND cmd IN ('UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION
      '048: apareceu politica de UPDATE/DELETE/ALL numa trilha de auditoria. Trilha editavel nao e trilha — ver a decisao 2 do cabecalho.';
  END IF;
END;
$$;
