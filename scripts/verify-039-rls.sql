-- ============================================================
-- verify-039-rls.sql — conferência da migração 039
--
-- NÃO é uma migração: mora fora de supabase/migrations/ de propósito,
-- para não ser aplicado automaticamente. Cole no SQL editor do Supabase
-- DEPOIS de rodar `039_conversation_assignment.sql`.
--
-- PARTE A é automática e não escreve nada — rode-a inteira.
-- PARTE B precisa de dois ids de usuário reais (a query de descoberta
--        está logo antes) e roda dentro de uma transação abortada.
-- PARTE C precisa de duas abas do SQL editor abertas ao mesmo tempo.
-- ============================================================


-- ============================================================
-- PARTE A — asserções estruturais (read-only)
--
-- Toda linha deve sair com status 'OK'. Qualquer 'FALHOU' significa que
-- a 039 não foi aplicada por inteiro.
-- ============================================================

WITH checks AS (

  -- 1. FK de assigned_agent_id (não existia antes da 039)
  SELECT
    '1. FK conversations.assigned_agent_id' AS verificacao,
    EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname  = 'conversations_assigned_agent_id_fkey'
         AND conrelid = 'public.conversations'::regclass
    ) AS passou,
    'sem FK, dá para atribuir a um UUID de outra conta' AS por_que_importa

  -- 2. Índices que sustentam as políticas
  UNION ALL SELECT
    '2. Índice idx_conversations_assigned',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND indexname = 'idx_conversations_assigned'),
    'sem ele, messages_select vira seq-scan por linha'

  UNION ALL SELECT
    '3. Índice parcial idx_conversations_unassigned',
    EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND indexname = 'idx_conversations_unassigned'),
    'a fila (aba Open) é a query quente do Inbox'

  -- 4-6. Helpers de predicado
  UNION ALL SELECT
    '4. can_access_conversation() é SECURITY DEFINER',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'can_access_conversation'
               AND pronamespace = 'public'::regnamespace
               AND prosecdef),
    'sem DEFINER a subconsulta em conversations dá falso-negativo'

  UNION ALL SELECT
    '5. can_write_conversation() é SECURITY DEFINER',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'can_write_conversation'
               AND pronamespace = 'public'::regnamespace
               AND prosecdef),
    'idem, para o lado da escrita'

  UNION ALL SELECT
    '6. can_access_contact_notes() é SECURITY DEFINER',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'can_access_contact_notes'
               AND pronamespace = 'public'::regnamespace
               AND prosecdef),
    'sem DEFINER o NOT EXISTS inverte e a nota VAZA'

  -- 7-8. ⚠️ A checagem mais importante do arquivo.
  --      Políticas FOR ALL são combinadas com OR e anulam qualquer
  --      restrição no _select. Se estas duas falharem, a migração
  --      passou mas NÃO PROTEGE NADA.
  UNION ALL SELECT
    '7. NENHUMA política FOR ALL em messages',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'messages' AND cmd = 'ALL'),
    'FOR ALL concede SELECT por OR e anula o isolamento'

  UNION ALL SELECT
    '8. NENHUMA política FOR ALL em message_reactions',
    NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'message_reactions' AND cmd = 'ALL'),
    'mesma armadilha, pela tabela de reações'

  -- 9. conversations_update precisa dos DOIS lados
  UNION ALL SELECT
    '9. conversations_update tem USING **e** WITH CHECK',
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'conversations'
               AND policyname = 'conversations_update'
               AND qual IS NOT NULL AND with_check IS NOT NULL),
    'só com USING, o dono transfere a conversa para um terceiro'

  -- 10. As 4 políticas de messages
  UNION ALL SELECT
    '10. messages tem select/insert/update/delete',
    (SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'messages') = 4,
    'o FOR ALL foi trocado por 4 políticas separadas'

  -- 11. Predicado de assignment realmente presente na política
  UNION ALL SELECT
    '11. conversations_select referencia assigned_agent_id',
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'conversations'
               AND policyname = 'conversations_select'
               AND qual::text LIKE '%assigned_agent_id%'),
    'se não referencia, a política velha (plana por conta) sobreviveu'

  -- 12-13. RPCs de atribuição
  UNION ALL SELECT
    '12. claim_conversation() é SECURITY INVOKER',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'claim_conversation'
               AND pronamespace = 'public'::regnamespace
               AND NOT prosecdef),
    'DEFINER zeraria auth.uid() e geraria notificação espúria'

  UNION ALL SELECT
    '13. reassign_conversation() é SECURITY INVOKER',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'reassign_conversation'
               AND pronamespace = 'public'::regnamespace
               AND NOT prosecdef),
    'idem'

  -- 14. RPCs do dashboard (as 4)
  UNION ALL SELECT
    '14. As 4 RPCs de dashboard existem',
    (SELECT COUNT(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('dashboard_counts', 'dashboard_message_series',
                        'dashboard_response_samples', 'dashboard_recent_inbound')) = 4,
    'sem elas o dashboard passa a mostrar números por-agente'

  -- 15. Guarda de inquilino nas RPCs DEFINER do dashboard
  UNION ALL SELECT
    '15. dashboard_counts valida is_account_member',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'dashboard_counts'
               AND pronamespace = 'public'::regnamespace
               AND prosrc LIKE '%is_account_member%'),
    'DEFINER que recebe account_id sem validar = vazamento entre contas'

  -- 16. Higiene de remoção de membro
  UNION ALL SELECT
    '16. remove_account_member limpa assigned_agent_id',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'remove_account_member'
               AND pronamespace = 'public'::regnamespace
               AND prosrc LIKE '%assigned_agent_id%'),
    'sem isso, conversas do removido somem para todos menos admin'

  -- 17. Snapshot do backfill
  UNION ALL SELECT
    '17. Tabela de snapshot do backfill existe',
    EXISTS (SELECT 1 FROM pg_tables
             WHERE schemaname = 'public'
               AND tablename = '_039_assignment_backfill_snapshot'),
    'é o que permite desfazer o backfill'

  -- 18-19. ⚠️ Sobrevivência da 039 a uma reaplicação da 017
  --        (F-41-B da SPEC 041). A 017 se declara dona exclusiva das
  --        políticas destas tabelas e dropa todas antes de recriar as
  --        suas — com os MESMOS NOMES. Reaplicá-la depois da 039
  --        devolve a conta ao modelo plano SEM ERRO NENHUM. Estas duas
  --        asserções são o detector; a guarda que impede está no topo
  --        da própria 017, e a trava de deploy é a migração 041.
  UNION ALL SELECT
    '18. Guarda anti-reaplicação presente na 017',
    EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'can_access_conversation'
               AND pronamespace = 'public'::regnamespace),
    'se a função sumiu, a 017 foi reaplicada e levou a 039 junto'

  UNION ALL SELECT
    '19. messages_select ainda usa can_access_conversation',
    EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'messages'
               AND policyname = 'messages_select'
               AND qual::text LIKE '%can_access_conversation%'),
    'função órfã = política velha (plana por conta) sobreviveu'
)
SELECT
  verificacao,
  CASE WHEN passou THEN 'OK' ELSE '>>> FALHOU <<<' END AS status,
  por_que_importa
FROM checks
ORDER BY verificacao;


-- ============================================================
-- Resultado do backfill — quantas conversas ganharam dono
-- ============================================================
SELECT
  COUNT(*)                                   AS conversas_atribuidas,
  COUNT(DISTINCT new_assigned_agent_id)      AS agentes_distintos,
  MIN(taken_at)                              AS executado_em
FROM _039_assignment_backfill_snapshot;

-- Distribuição da carteira depois do backfill:
SELECT
  c.account_id,
  COALESCE(p.full_name, '(sem dono — fila/aba Open)') AS responsavel,
  COUNT(*) AS conversas
FROM conversations c
LEFT JOIN profiles p ON p.user_id = c.assigned_agent_id
GROUP BY c.account_id, p.full_name
ORDER BY c.account_id, conversas DESC;


-- ============================================================
-- PARTE B — matriz de RLS por papel
--
-- Descubra primeiro dois usuários da MESMA conta, um `agent` e um
-- `admin`/`owner`, e uma conversa atribuída ao agente:
-- ============================================================

SELECT p.user_id, p.full_name, p.account_role, p.account_id
FROM profiles p
ORDER BY p.account_id, p.account_role;

SELECT c.id AS conversation_id, c.account_id, c.assigned_agent_id
FROM conversations c
WHERE c.assigned_agent_id IS NOT NULL
LIMIT 5;


-- ------------------------------------------------------------
-- Preencha os 4 valores abaixo e rode o bloco inteiro.
-- Ele roda dentro de BEGIN/ROLLBACK: não altera nada.
--
-- O que impersonar um usuário significa aqui: `auth.uid()` lê a claim
-- `sub` de `request.jwt.claims`, e `SET LOCAL ROLE authenticated` tira
-- o bypass de RLS que o papel `postgres` do SQL editor tem. Sem os
-- DOIS, a consulta ignora as políticas e o teste não prova nada.
-- ------------------------------------------------------------

BEGIN;

-- >>> EDITE AQUI <<<
CREATE TEMP TABLE _params AS SELECT
  '00000000-0000-0000-0000-000000000000'::uuid AS agente_dono,
  '00000000-0000-0000-0000-000000000000'::uuid AS agente_outro,
  '00000000-0000-0000-0000-000000000000'::uuid AS admin_user,
  '00000000-0000-0000-0000-000000000000'::uuid AS conversa_do_dono;

-- --- B1. O agente DONO enxerga a própria conversa? (esperado: 1)
SELECT set_config('request.jwt.claims',
       json_build_object('sub', (SELECT agente_dono FROM _params),
                         'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT 'B1 dono vê a própria conversa (esperado 1)' AS teste, COUNT(*) AS resultado
FROM conversations WHERE id = (SELECT conversa_do_dono FROM _params);
RESET ROLE;

-- --- B2. Um OUTRO agente enxerga a mesma conversa? (esperado: 0)
SELECT set_config('request.jwt.claims',
       json_build_object('sub', (SELECT agente_outro FROM _params),
                         'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT 'B2 outro agente vê a conversa (esperado 0)' AS teste, COUNT(*) AS resultado
FROM conversations WHERE id = (SELECT conversa_do_dono FROM _params);

-- --- B3. ⚠️ O TESTE QUE PEGA A ARMADILHA DO `FOR ALL`.
--         O outro agente consegue ler as MENSAGENS pelo conversation_id,
--         mesmo sem enxergar a conversa? (esperado: 0)
SELECT 'B3 outro agente lê mensagens da conversa (esperado 0)' AS teste, COUNT(*) AS resultado
FROM messages WHERE conversation_id = (SELECT conversa_do_dono FROM _params);

-- --- B4. E as reações? (esperado: 0)
SELECT 'B4 outro agente lê reações (esperado 0)' AS teste, COUNT(*) AS resultado
FROM message_reactions WHERE conversation_id = (SELECT conversa_do_dono FROM _params);
RESET ROLE;

-- --- B5. O ADMIN enxerga a conversa de outro agente? (esperado: 1)
SELECT set_config('request.jwt.claims',
       json_build_object('sub', (SELECT admin_user FROM _params),
                         'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT 'B5 admin vê conversa alheia (esperado 1)' AS teste, COUNT(*) AS resultado
FROM conversations WHERE id = (SELECT conversa_do_dono FROM _params);
RESET ROLE;

-- --- B6. O outro agente consegue ROUBAR a conversa? (esperado: 0 linhas)
SELECT set_config('request.jwt.claims',
       json_build_object('sub', (SELECT agente_outro FROM _params),
                         'role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
WITH tentativa AS (
  UPDATE conversations
     SET assigned_agent_id = (SELECT agente_outro FROM _params)
   WHERE id = (SELECT conversa_do_dono FROM _params)
  RETURNING 1
)
SELECT 'B6 outro agente rouba a conversa (esperado 0)' AS teste, COUNT(*) AS resultado
FROM tentativa;
RESET ROLE;

ROLLBACK;


-- ============================================================
-- PARTE C — concorrência do claim (precisa de DUAS abas)
--
-- Escolha uma conversa SEM dono:
--   SELECT id FROM conversations WHERE assigned_agent_id IS NULL LIMIT 1;
--
-- ABA 1 — abra a transação e reivindique, mas NÃO commite ainda:
--   BEGIN;
--   SELECT set_config('request.jwt.claims',
--          json_build_object('sub','<AGENTE_A>','role','authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   SELECT id, assigned_agent_id FROM claim_conversation('<CONVERSA>');
--   -- deixe aberta
--
-- ABA 2 — a mesma reivindicação por outro agente. Vai FICAR BLOQUEADA
--         esperando o commit da aba 1: é o lock de linha do Postgres
--         serializando as duas transações. É exatamente o que queremos ver.
--   BEGIN;
--   SELECT set_config('request.jwt.claims',
--          json_build_object('sub','<AGENTE_B>','role','authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   SELECT id, assigned_agent_id FROM claim_conversation('<CONVERSA>');
--
-- ABA 1 — agora commite:  COMMIT;
--
-- RESULTADO ESPERADO: a aba 2 destrava e falha com
--   'CONVERSATION_ALREADY_CLAIMED' (SQLSTATE 55006).
--   Um único vencedor, garantido pelo banco.
--   Depois: ROLLBACK; na aba 2.
--
-- Se a aba 2 tiver SUCESSO, o `WHERE assigned_agent_id IS NULL` do
-- claim_conversation não está no lugar e a corrida continua aberta.
-- ============================================================


-- ============================================================
-- PARTE D — custo das políticas
--
-- A política de messages consulta conversations uma vez por linha.
-- Esta é a query mais pesada do dashboard (14 dias de mensagens).
-- Procure por "Index Scan using idx_conversations_assigned"; um
-- "Seq Scan on conversations" significa que os índices da seção 1
-- não estão sendo usados.
-- ============================================================

-- EXPLAIN ANALYZE
-- SELECT m.conversation_id, m.sender_type, m.created_at
--   FROM messages m
--  WHERE m.created_at >= NOW() - INTERVAL '14 days'
--  ORDER BY m.conversation_id, m.created_at;
