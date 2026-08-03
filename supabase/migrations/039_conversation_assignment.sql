-- ============================================================
-- 039_conversation_assignment.sql — visibilidade de conversa por agente
--
-- Por que isso existe
--
--   Até aqui o isolamento do ZAP CRM BR era PLANO POR CONTA: a
--   política `conversations_select` (017) era apenas
--   `is_account_member(account_id)`, então qualquer membro — inclusive
--   um `viewer` — lia todas as conversas e todas as mensagens da
--   conta. A coluna `conversations.assigned_agent_id` existe desde a
--   001, mas era decorativa: sem FK, sem índice, sem política, sem
--   validação nenhuma.
--
--   O Inbox em 3 abas (Chat / Open / Contatos) exige isolamento POR
--   LINHA dentro da conta. Isso não pode ser feito no cliente: o front
--   fala direto com o PostgREST usando a `anon key` que está no bundle,
--   então filtrar um array em React esconde a conversa da lista mas não
--   impede um `GET /rest/v1/conversations?select=*,messages(*)` com o
--   próprio token. Toda regra precisa existir como política.
--
-- Regra de visibilidade (decidida com o mantenedor)
--
--   Uma conversa é visível para um membro da conta quando:
--     • está SEM DONO (`assigned_agent_id IS NULL`) — é a fila
--       pública, a aba "Open"; ou
--     • está atribuída a ele (`= auth.uid()`) — a aba "Chat"; ou
--     • ele é `admin` ou `owner`.
--
--   O `viewer` segue a regra literal: enxerga apenas a fila. É o papel
--   de MENOR rank (1); dar-lhe leitura ampla o faria ver mais que um
--   `agent` (rank 2), invertendo a hierarquia de permissões.
--
-- ⚠️ TRÊS ARMADILHAS que esta migração resolve — leia antes de mexer
--
--   1. POLÍTICAS `FOR ALL` ANULAM UM SELECT RESTRITIVO.
--      O Postgres combina políticas permissivas com OR. A 017 criou
--      `messages_modify ... FOR ALL` (017:513) e
--      `message_reactions_modify ... FOR ALL` (017:586). Endurecer
--      apenas o `_select` dessas tabelas NÃO PROTEGE NADA: o `FOR ALL`
--      continua concedendo SELECT a qualquer membro da conta. Por isso
--      os `FOR ALL` são DROPADOS e reescritos como INSERT / UPDATE /
--      DELETE separados.
--
--   2. A 017 SE DECLARA DONA EXCLUSIVA DESTAS POLÍTICAS.
--      O bloco `DO $$` em 017:361-382 dropa TODAS as políticas das
--      tabelas do seu array (que inclui `conversations`, `messages`,
--      `message_reactions`, `contact_notes`, `flow_runs`,
--      `flow_run_events`) antes de recriá-las. Reexecutar a 017 DEPOIS
--      desta migração apagaria tudo o que está aqui, em silêncio, e a
--      conta voltaria ao modelo plano. Se a 017 for reaplicada, esta
--      039 TEM de ser reaplicada em seguida.
--
--   3. `UPDATE` SEM `.select()` NÃO ACUSA FALHA DE RLS.
--      O PostgREST devolve sucesso com 0 linhas afetadas. Os call sites
--      no app que fazem `.update()` sem `.select()` passam a ser no-ops
--      silenciosos. Isso é corrigido do lado do app (Fases 2 e 3), não
--      aqui — mas está anotado porque é a consequência menos óbvia
--      desta migração.
--
-- Escopo
--
--   Endurecidas: `conversations`, `messages`, `message_reactions`,
--   `contact_notes`, `flow_runs`, `flow_run_events` (o `payload` de
--   `flow_run_events` guarda o texto de resposta do cliente).
--
--   NÃO endurecidas, de propósito: `contacts`, `contact_tags`,
--   `broadcast_recipients` e as tabelas `ai_*` — nenhuma carrega
--   conteúdo de conversa. `notifications` já é row-level por
--   `auth.uid() = user_id` (027:41) e está correta como está.
--
--   FORA DE ESCOPO (ticket separado, mas registrado aqui porque
--   relativiza o resultado): o bucket `chat-media` é PÚBLICO —
--   `USING (bucket_id = 'chat-media')` (023:84), sem qualquer checagem
--   de identidade. Anexos de TODOS os inquilinos são legíveis por URL
--   sem login, e o caminho (`<timestamp>-<nome>`) é adivinhável.
--   Enquanto isso não for corrigido, o isolamento de conversas é
--   parcial: o texto fica protegido, os anexos não. Idem para
--   `/api/v1`, que autentica por API key e usa service role
--   (`api-context.ts:112`), ignorando RLS por completo.
--
-- Idempotente — seguro reexecutar.
-- ============================================================

-- ============================================================
-- 1. ESTRUTURA DE `assigned_agent_id`
-- ============================================================

-- FK. Não existia: até agora nada impedia gravar um UUID de outra
-- conta (ou lixo) na coluna. `ON DELETE SET NULL` para que o
-- desligamento de um agente devolva a carteira dele à fila, em vez de
-- cascatear DELETE nas conversas.
--
-- Valores órfãos precisam ser limpos ANTES, senão a constraint não
-- valida — e como nunca houve FK, é bem provável que existam.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversations_assigned_agent_id_fkey'
       AND conrelid = 'public.conversations'::regclass
  ) THEN
    UPDATE conversations c
       SET assigned_agent_id = NULL
     WHERE c.assigned_agent_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM auth.users u WHERE u.id = c.assigned_agent_id
       );

    ALTER TABLE conversations
      ADD CONSTRAINT conversations_assigned_agent_id_fkey
      FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Sem estes índices, `messages_select` — que consulta `conversations`
-- uma vez por linha de mensagem — vira seq-scan. O gráfico de tempo de
-- resposta do dashboard lê 14 dias de mensagens de uma vez só.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned
  ON conversations(account_id, assigned_agent_id, last_message_at DESC);

-- Índice parcial: a fila (aba "Open") é a query quente do Inbox.
CREATE INDEX IF NOT EXISTS idx_conversations_unassigned
  ON conversations(account_id, last_message_at DESC)
  WHERE assigned_agent_id IS NULL;

-- ============================================================
-- 2. PREDICADOS CENTRAIS
--
-- Mesmo molde de `is_account_member` (017:136): SECURITY DEFINER +
-- STABLE + `SET search_path = public` + OWNER postgres.
--
-- O SECURITY DEFINER é OBRIGATÓRIO, não uma otimização: a política de
-- `messages` precisa consultar `conversations`, que tem RLS. Sem
-- DEFINER a subconsulta seria filtrada recursivamente pela própria
-- política que estamos avaliando e o resultado daria falso-negativo.
--
-- `auth.uid()` continua devolvendo o CHAMADOR dentro de um DEFINER:
-- ele lê a claim do JWT no ajuste de sessão, que não muda com a troca
-- de role.
-- ============================================================

-- Leitura. `is_account_member(x, 'admin')` já cobre `owner` (rank 4 ≥
-- 3) — NUNCA comparar `account_role = 'admin'` diretamente, isso
-- deixaria o dono da conta de fora.
CREATE OR REPLACE FUNCTION public.can_access_conversation(conv_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM conversations c
     WHERE c.id = conv_id
       AND is_account_member(c.account_id)
       AND (
         c.assigned_agent_id IS NULL
         OR c.assigned_agent_id = auth.uid()
         OR is_account_member(c.account_id, 'admin')
       )
  );
$$;

ALTER FUNCTION public.can_access_conversation(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID)
  TO authenticated, service_role;

-- Escrita. Mesma visibilidade, mais a exigência de papel `agent`+ —
-- assim um `viewer` que enxerga a fila não consegue escrever nela.
CREATE OR REPLACE FUNCTION public.can_write_conversation(conv_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM conversations c
     WHERE c.id = conv_id
       AND is_account_member(c.account_id, 'agent')
       AND (
         c.assigned_agent_id IS NULL
         OR c.assigned_agent_id = auth.uid()
         OR is_account_member(c.account_id, 'admin')
       )
  );
$$;

ALTER FUNCTION public.can_write_conversation(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_write_conversation(UUID)
  TO authenticated, service_role;

-- Notas de contato. Uma nota pertence ao CONTATO, não à conversa, mas
-- carrega o contexto do atendimento — então segue a visibilidade da
-- conversa daquele contato. Contato sem nenhuma conversa continua
-- visível a todos os membros (não há atendimento a isolar).
--
-- Precisa ser DEFINER: se as subconsultas rodassem sob a RLS nova de
-- `conversations`, uma conversa de outro agente ficaria INVISÍVEL, o
-- `NOT EXISTS` daria verdadeiro e a nota vazaria — exatamente o
-- contrário do pretendido.
CREATE OR REPLACE FUNCTION public.can_access_contact_notes(
  p_contact_id UUID,
  p_account_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    is_account_member(p_account_id)
    AND (
      is_account_member(p_account_id, 'admin')
      OR NOT EXISTS (
        SELECT 1 FROM conversations c
         WHERE c.contact_id = p_contact_id
           AND c.account_id = p_account_id
      )
      OR EXISTS (
        SELECT 1 FROM conversations c
         WHERE c.contact_id = p_contact_id
           AND c.account_id = p_account_id
           AND (
             c.assigned_agent_id IS NULL
             OR c.assigned_agent_id = auth.uid()
           )
      )
    );
$$;

ALTER FUNCTION public.can_access_contact_notes(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_access_contact_notes(UUID, UUID)
  TO authenticated, service_role;

-- ============================================================
-- 3. POLÍTICAS — `conversations`
--
-- O predicado é escrito INLINE aqui, e não via
-- `can_access_conversation(id)`: o helper faz um SELECT na própria
-- `conversations`, o que seria uma varredura extra por linha. Nas
-- tabelas filhas o helper compensa; aqui não.
-- ============================================================

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

-- `USING` decide QUAIS LINHAS posso tocar; `WITH CHECK` decide COMO A
-- LINHA PODE FICAR depois. Os dois são necessários: só com `USING`, o
-- agente dono conseguiria transferir a conversa para um terceiro
-- arbitrário — que é justamente o que a regra proíbe fora do caso
-- admin.
--
-- Matriz resultante:
--   agente reivindica conversa livre   → USING (IS NULL) ok,
--                                        CHECK (= auth.uid()) ok
--   agente devolve a SUA à fila        → USING (= uid) ok,
--                                        CHECK (IS NULL) ok
--   agente passa a SUA para terceiro   → CHECK falha  ✔ bloqueado
--   agente rouba conversa de outro     → USING falha  ✔ bloqueado
--   admin/owner move para quem quiser  → ambos ok
DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

-- Impede criar uma conversa já atribuída a um terceiro.
DROP POLICY IF EXISTS conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

-- ============================================================
-- 4. POLÍTICAS — `messages`  (⚠️ armadilha 1)
-- ============================================================

DROP POLICY IF EXISTS messages_select ON messages;
-- `messages_modify` era FOR ALL — concedia SELECT por OR e anulava
-- qualquer restrição no `_select`. É a linha mais importante do
-- arquivo.
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT
  USING (can_access_conversation(conversation_id));

CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (can_write_conversation(conversation_id));

CREATE POLICY messages_update ON messages FOR UPDATE
  USING (can_write_conversation(conversation_id))
  WITH CHECK (can_write_conversation(conversation_id));

CREATE POLICY messages_delete ON messages FOR DELETE
  USING (can_write_conversation(conversation_id));

-- ============================================================
-- 5. POLÍTICAS — `message_reactions`  (⚠️ armadilha 1)
--
-- A 017 descia por `messages JOIN conversations`. A tabela tem
-- `conversation_id` desnormalizado desde a 009 (009:45, NOT NULL, com
-- índice próprio) — usar a coluna direta poupa um join por linha.
-- ============================================================

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;

CREATE POLICY message_reactions_select ON message_reactions FOR SELECT
  USING (can_access_conversation(conversation_id));

CREATE POLICY message_reactions_insert ON message_reactions FOR INSERT
  WITH CHECK (can_write_conversation(conversation_id));

CREATE POLICY message_reactions_update ON message_reactions FOR UPDATE
  USING (can_write_conversation(conversation_id))
  WITH CHECK (can_write_conversation(conversation_id));

CREATE POLICY message_reactions_delete ON message_reactions FOR DELETE
  USING (can_write_conversation(conversation_id));

-- ============================================================
-- 6. POLÍTICAS — `contact_notes`
-- ============================================================

DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (can_access_contact_notes(contact_id, account_id));

DROP POLICY IF EXISTS contact_notes_insert ON contact_notes;
CREATE POLICY contact_notes_insert ON contact_notes FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND can_access_contact_notes(contact_id, account_id)
  );

DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact_notes(contact_id, account_id)
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND can_access_contact_notes(contact_id, account_id)
  );

DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact_notes(contact_id, account_id)
  );

-- ============================================================
-- 7. POLÍTICAS — `flow_runs` / `flow_run_events`
--
-- `flow_run_events.payload` guarda os eventos `reply_received`, ou
-- seja, o TEXTO DA RESPOSTA DO CLIENTE. Deixar essas duas de fora
-- seria uma porta lateral para o conteúdo da conversa.
--
-- `flow_runs.conversation_id` é anulável (`ON DELETE SET NULL`, 010:164).
-- Run órfão — cuja conversa foi apagada — permanece visível a qualquer
-- membro da conta: não há mais atendimento a isolar, e escondê-lo
-- tornaria o histórico de automação inauditável.
--
-- Escrita continua exclusiva do service role (a 017 não criou
-- políticas de INSERT/UPDATE/DELETE nessas tabelas, e seguimos assim).
-- ============================================================

DROP POLICY IF EXISTS flow_runs_select ON flow_runs;
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      conversation_id IS NULL
      OR can_access_conversation(conversation_id)
    )
  );

DROP POLICY IF EXISTS flow_run_events_select ON flow_run_events;
CREATE POLICY flow_run_events_select ON flow_run_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM flow_runs r
       WHERE r.id = flow_run_events.flow_run_id
         AND is_account_member(r.account_id)
         AND (
           r.conversation_id IS NULL
           OR can_access_conversation(r.conversation_id)
         )
    )
  );

-- ============================================================
-- 8. RPC — REIVINDICAÇÃO ATÔMICA
--
-- Hoje a atribuição é um `UPDATE` direto do browser, sem condição
-- (message-thread.tsx:883). Dois agentes clicando na mesma conversa da
-- fila no mesmo instante: os dois UPDATEs passam e o segundo
-- sobrescreve o primeiro. O agente A já enviou a resposta ao cliente
-- quando descobre que perdeu a thread — e o cliente recebe duas
-- saudações de pessoas diferentes.
--
-- O `WHERE assigned_agent_id IS NULL` É o lock: o Postgres serializa as
-- duas transações na mesma linha; a segunda espera o commit da
-- primeira, reavalia o predicado, encontra 0 linhas e falha. Um único
-- vencedor, garantido pelo banco.
--
-- SECURITY INVOKER de propósito: `notify_conversation_assigned` (027:75)
-- já pula a auto-atribuição comparando `auth.uid() = NEW.assigned_agent_id`.
-- Chamar isto com service role zeraria `auth.uid()` e dispararia uma
-- notificação espúria para o próprio agente que acabou de assumir.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_conversation(p_conversation_id UUID)
RETURNS conversations
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row conversations;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  UPDATE conversations
     SET assigned_agent_id = auth.uid(),
         updated_at = NOW()
   WHERE id = p_conversation_id
     AND assigned_agent_id IS NULL
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- Nada foi atualizado. Três causas, tratadas abaixo:
  --   a) já é minha        → idempotente (duplo clique, retry de rede)
  --   b) é de outro agente → perdi a corrida
  --   c) não existe, ou é invisível para mim → mesma resposta de (b),
  --      para não confirmar a existência do recurso a quem sondar ids.
  SELECT * INTO v_row FROM conversations WHERE id = p_conversation_id;

  IF FOUND AND v_row.assigned_agent_id = auth.uid() THEN
    RETURN v_row;
  END IF;

  -- Linha visível e livre, mas o UPDATE não a alcançou: o chamador não
  -- tem papel de escrita (`viewer`). Erro específico, senão ele receberia
  -- um "já reivindicada" enganoso.
  IF FOUND AND v_row.assigned_agent_id IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE' USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'CONVERSATION_ALREADY_CLAIMED' USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION public.claim_conversation(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_conversation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_conversation(UUID) TO authenticated;

-- ============================================================
-- 9. RPC — REATRIBUIÇÃO
--
-- `p_target_user_id NULL` devolve a conversa à fila.
--
-- A política de UPDATE já bloqueia o caso proibido; esta função existe
-- para (a) devolver um erro LEGÍVEL em vez de "0 linhas afetadas" e
-- (b) validar que o destino é membro DESTA conta — sem isso, um admin
-- (ou um payload forjado) atribuiria a conversa a um UUID de outra
-- conta e a linha sumiria para todo mundo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reassign_conversation(
  p_conversation_id UUID,
  p_target_user_id  UUID
)
RETURNS conversations
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row        conversations;
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Sob a RLS nova, uma conversa de outro agente simplesmente não é
  -- visível — o NOT FOUND aqui já é a resposta fail-closed correta, e
  -- é genérico de propósito (não revela se o id existe).
  SELECT * INTO v_row FROM conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  v_account_id := v_row.account_id;

  IF NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE' USING ERRCODE = '42501';
  END IF;

  -- Mandar para um TERCEIRO exige admin+. O dono pode apenas devolver
  -- à fila (NULL) ou manter consigo.
  IF p_target_user_id IS NOT NULL
     AND p_target_user_id <> auth.uid()
     AND NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS' USING ERRCODE = '42501';
  END IF;

  -- Destino precisa ser membro desta conta e capaz de atender.
  IF p_target_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = p_target_user_id
         AND p.account_id = v_account_id
         AND p.account_role IN ('owner', 'admin', 'agent')
    ) THEN
      RAISE EXCEPTION 'INVALID_ASSIGNEE' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE conversations
     SET assigned_agent_id = p_target_user_id,
         updated_at = NOW()
   WHERE id = p_conversation_id
  RETURNING * INTO v_row;

  -- Rede de segurança: a política de UPDATE recusou (ex.: agente
  -- tentando mexer em conversa que não é dele por outra via).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_CONVERSATION_OWNER' USING ERRCODE = '42501';
  END IF;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.reassign_conversation(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reassign_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reassign_conversation(UUID, UUID) TO authenticated;

-- ============================================================
-- 10. RPCs DE MÉTRICAS DO DASHBOARD
--
-- O dashboard agrega no cliente (`src/lib/dashboard/queries.ts`) e
-- depende de ver a conta INTEIRA. Sob a RLS nova, dez dessas queries
-- passariam a devolver números MENORES sem erro nenhum — o pior modo
-- de falha possível: "Conversas ativas" viraria "as minhas", o gráfico
-- de tempo de resposta ficaria vazio para agentes novos, e admin e
-- agente veriam números diferentes na mesma tela sem rótulo nenhum.
--
-- Estas funções devolvem os MESMOS dados brutos que o TS já consome,
-- só que atrás de SECURITY DEFINER com escopo por conta. Toda a lógica
-- de bucket por dia local continua no TS, intocada — mover datas para
-- o SQL trocaria um problema conhecido por um problema de fuso.
--
-- ⚠️ Cada função valida `is_account_member(p_account_id)`. Sem isso um
-- SECURITY DEFINER que recebe `account_id` por parâmetro é um vazamento
-- entre inquilinos: bastaria passar o id de outra conta.
--
-- Colunas sempre qualificadas (`m.`, `c.`, `ct.`) para não colidir com
-- os parâmetros de saída do `RETURNS TABLE`.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_counts(
  p_account_id      UUID,
  p_today_start     TIMESTAMPTZ,
  p_yesterday_start TIMESTAMPTZ
)
RETURNS TABLE (
  open_conversations          BIGINT,
  new_conversations_today     BIGINT,
  new_conversations_yesterday BIGINT,
  agent_messages_today        BIGINT,
  agent_messages_yesterday    BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.status = 'open'),
    (SELECT COUNT(*) FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.status = 'open'
        AND c.created_at >= p_today_start),
    (SELECT COUNT(*) FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.status = 'open'
        AND c.created_at >= p_yesterday_start
        AND c.created_at <  p_today_start),
    (SELECT COUNT(*) FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type = 'agent'
        AND m.created_at >= p_today_start),
    (SELECT COUNT(*) FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = p_account_id
        AND m.sender_type = 'agent'
        AND m.created_at >= p_yesterday_start
        AND m.created_at <  p_today_start);
END;
$$;

ALTER FUNCTION public.dashboard_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.dashboard_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated;

-- Série "conversas ao longo do tempo" (entrada vs saída por dia).
CREATE OR REPLACE FUNCTION public.dashboard_message_series(
  p_account_id UUID,
  p_start      TIMESTAMPTZ
)
RETURNS TABLE (created_at TIMESTAMPTZ, sender_type TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.created_at, m.sender_type
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account_id
     AND m.created_at >= p_start
   ORDER BY m.created_at ASC;
END;
$$;

ALTER FUNCTION public.dashboard_message_series(UUID, TIMESTAMPTZ)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(UUID, TIMESTAMPTZ)
  TO authenticated;

-- Amostras de tempo de resposta. A ordenação por (conversa, tempo) é
-- parte do contrato: o TS percorre as linhas em sequência para parear
-- "primeira mensagem do cliente" com "primeira resposta seguinte".
CREATE OR REPLACE FUNCTION public.dashboard_response_samples(
  p_account_id UUID,
  p_start      TIMESTAMPTZ
)
RETURNS TABLE (
  conversation_id UUID,
  sender_type     TEXT,
  created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.conversation_id, m.sender_type, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account_id
     AND m.created_at >= p_start
   ORDER BY m.conversation_id ASC, m.created_at ASC;
END;
$$;

ALTER FUNCTION public.dashboard_response_samples(UUID, TIMESTAMPTZ)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.dashboard_response_samples(UUID, TIMESTAMPTZ)
  TO authenticated;

-- Feed de atividade — só a fatia de mensagens recebidas. As outras
-- quatro fontes do feed (contatos, negócios, disparos, logs de
-- automação) não tocam `conversations` e seguem no cliente.
--
-- O contato vem achatado: a versão em PostgREST usava um embed
-- (`conversations(contact_id, contacts(name, phone))`) que, sendo LEFT
-- JOIN, deixaria a mensagem no feed com o contato nulo — o item
-- apareceria como "Desconhecido" apontando para uma thread inacessível.
CREATE OR REPLACE FUNCTION public.dashboard_recent_inbound(
  p_account_id UUID,
  p_limit      INTEGER DEFAULT 10
)
RETURNS TABLE (
  id              UUID,
  content_text    TEXT,
  created_at      TIMESTAMPTZ,
  conversation_id UUID,
  contact_id      UUID,
  contact_name    TEXT,
  contact_phone   TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.id, m.content_text, m.created_at, m.conversation_id,
         ct.id, ct.name, ct.phone
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    LEFT JOIN contacts ct ON ct.id = c.contact_id
   WHERE c.account_id = p_account_id
     AND m.sender_type = 'customer'
   ORDER BY m.created_at DESC
   LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.dashboard_recent_inbound(UUID, INTEGER)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.dashboard_recent_inbound(UUID, INTEGER)
  TO authenticated;

-- ============================================================
-- 11. HIGIENE — REMOÇÃO DE MEMBRO DEVOLVE A CARTEIRA À FILA
--
-- `remove_account_member` (018:127) move o removido para uma conta
-- pessoal nova, mas NÃO limpa `assigned_agent_id`. Sob a RLS nova, as
-- conversas dele ficariam apontando para alguém que não é mais membro
-- da conta: invisíveis para todos os agentes, visíveis só para admin+,
-- e sem nenhum caminho de UI para devolvê-las ao time.
--
-- Recriada aqui na íntegra (o corpo abaixo é o da 018 mais o UPDATE
-- novo). Reaplicar a 018 depois desta migração reintroduz o bug.
--
-- O trigger `on_conversation_assigned` não dispara para estas linhas:
-- ele retorna cedo quando `NEW.assigned_agent_id IS NULL` (027:66).
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- id da nova conta pessoal
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role       account_role_enum;
  v_target_account_id UUID;
  v_target_role       account_role_enum;
  v_target_name       TEXT;
  v_target_email      TEXT;
  v_new_account_id    UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
    INTO v_caller_account_id, v_caller_role
    FROM profiles
   WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
    INTO v_target_account_id, v_target_role, v_target_name, v_target_email
    FROM profiles
   WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- NOVO na 039: devolve à fila tudo o que estava atribuído ao removido.
  UPDATE conversations
     SET assigned_agent_id = NULL,
         updated_at = NOW()
   WHERE account_id = v_target_account_id
     AND assigned_agent_id = p_user_id;

  -- Cria uma conta pessoal nova para o removido. Espelho do
  -- handle_new_user — ele continua inteiro, só realocado.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
     SET account_id   = v_new_account_id,
         account_role = 'owner'
   WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ============================================================
-- 12. BACKFILL — atribuição inicial (estratégia híbrida)
--
-- Sem backfill, TODAS as conversas existentes ficariam sem dono: a aba
-- "Chat" nasceria vazia para todo mundo e não haveria isolamento algum
-- até que cada thread fosse reivindicada uma a uma.
--
-- Critérios (conservadores de propósito — na dúvida, vai para a fila):
--   • atribui ao ÚLTIMO agente que respondeu na thread;
--   • só conversas com atividade nos últimos 30 dias (threads mortas
--     não devem entrar na carteira de ninguém);
--   • só se esse agente AINDA é membro da mesma conta com papel
--     `agent`+ (senão a conversa nasceria invisível — o problema que a
--     seção 11 corrige);
--   • nunca sobrescreve uma atribuição já existente.
--
-- O snapshot abaixo permite desfazer:
--   UPDATE conversations c
--      SET assigned_agent_id = s.previous_assigned_agent_id
--     FROM _039_assignment_backfill_snapshot s
--    WHERE c.id = s.conversation_id;
-- ============================================================

CREATE TABLE IF NOT EXISTS _039_assignment_backfill_snapshot (
  conversation_id            UUID PRIMARY KEY,
  previous_assigned_agent_id UUID,
  new_assigned_agent_id      UUID,
  taken_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sem políticas: tabela de manutenção, alcançável apenas por
-- service_role / postgres.
ALTER TABLE _039_assignment_backfill_snapshot ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Reexecução: o snapshot não-vazio prova que o backfill já rodou.
  IF EXISTS (SELECT 1 FROM _039_assignment_backfill_snapshot) THEN
    RAISE NOTICE '039: backfill já executado anteriormente — pulando.';
    RETURN;
  END IF;

  -- ⚠️ O trigger `on_conversation_assigned` dispara em CADA UPDATE de
  -- `assigned_agent_id`. Durante a migração `auth.uid()` é NULL, então
  -- o desvio de auto-atribuição (027:75) não se aplica e cada conversa
  -- backfillada geraria uma notificação — uma tempestade de avisos
  -- "Fulano atribuiu uma conversa a você" no primeiro login de todos.
  --
  -- Guardado por existência: a 027 sempre roda antes desta migração,
  -- mas um banco montado fora de ordem não deve explodir aqui.
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'on_conversation_assigned'
       AND tgrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE conversations DISABLE TRIGGER on_conversation_assigned;
  END IF;

  WITH last_agent AS (
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           m.sender_id
      FROM messages m
     WHERE m.sender_type = 'agent'
       AND m.sender_id IS NOT NULL
     ORDER BY m.conversation_id, m.created_at DESC
  ),
  eligible AS (
    SELECT c.id                 AS conversation_id,
           c.assigned_agent_id  AS previous_assigned_agent_id,
           la.sender_id         AS new_assigned_agent_id
      FROM conversations c
      JOIN last_agent la ON la.conversation_id = c.id
      JOIN profiles   p  ON p.user_id = la.sender_id
     WHERE c.assigned_agent_id IS NULL
       AND c.last_message_at >= NOW() - INTERVAL '30 days'
       AND p.account_id = c.account_id
       AND p.account_role IN ('owner', 'admin', 'agent')
  ),
  -- `applied`, não `snapshot`: este último é palavra-chave do Postgres
  -- (`SET TRANSACTION SNAPSHOT`) e, embora não-reservada, não vale o
  -- risco como nome de CTE.
  applied AS (
    INSERT INTO _039_assignment_backfill_snapshot
      (conversation_id, previous_assigned_agent_id, new_assigned_agent_id)
    SELECT conversation_id, previous_assigned_agent_id, new_assigned_agent_id
      FROM eligible
    RETURNING conversation_id, new_assigned_agent_id
  )
  UPDATE conversations c
     SET assigned_agent_id = applied.new_assigned_agent_id,
         updated_at = NOW()
    FROM applied
   WHERE c.id = applied.conversation_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'on_conversation_assigned'
       AND tgrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE conversations ENABLE TRIGGER on_conversation_assigned;
  END IF;

  RAISE NOTICE '039: backfill atribuiu % conversa(s) ao último agente que respondeu.', v_count;
END $$;
