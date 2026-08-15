-- ============================================================
-- 061_filter_contacts_by_channel.sql — filtro de contatos por canal
-- (SPEC 049 §1.4 e §3.1 · F5.1)
--
-- Por que é migração, e não um `.in()` no cliente
--
--   O cabeçalho da 025 já documenta o motivo de o filtro de etiquetas
--   ser um RPC: resolver o filtro no cliente (`SELECT contact_id …` →
--   `.in('id', ids)`) estoura o teto de ~1000 linhas do PostgREST EM
--   SILÊNCIO, derrubando contatos do resultado e quebrando o
--   `total_count` e a paginação.
--
--   "Contatos que têm conversa no canal X" tem exatamente a mesma
--   forma: uma consulta em `conversations` devolvendo ids de contato
--   alimentando um `.in()`. Numa conta com alguns milhares de conversas
--   no canal oficial, o filtro perderia contatos e ninguém notaria — o
--   número de resultados continua plausível. Por isso o canal entra
--   como PARÂMETRO da mesma função, não como um segundo caminho.
--
-- O que muda no contrato da 025
--
--   1. `p_channel_ids` novo, opcional. NULL ou vazio = sem filtro de
--      canal, ou seja, o comportamento da 025 preservado para a
--      chamada de 4 argumentos que a página já faz.
--   2. `p_tag_ids` vazio deixa de ser proibido. Hoje a função só é
--      chamada com etiquetas selecionadas; com filtro de canal sozinho
--      ela precisa aceitar `'{}'` e não filtrar por etiqueta — senão o
--      caminho "só canal" volta para o `.in()` que esta migração
--      existe para evitar.
--   3. O filtro por etiqueta vira `EXISTS` em vez de JOIN + DISTINCT.
--      Mesmo conjunto de linhas (`contacts.id` é PK, então o DISTINCT
--      sobre o join é exatamente um teste de existência), com o mesmo
--      OR entre etiquetas — só que a consulta para no primeiro acerto
--      em vez de materializar uma linha por etiqueta. O filtro de
--      canal usa a mesma forma pelo mesmo motivo: um contato com cinco
--      conversas no mesmo canal apareceria cinco vezes num join.
--
-- D-4 da SPEC 049 — por que DROP antes de CREATE
--
--   `CREATE OR REPLACE FUNCTION` com um parâmetro a mais NÃO substitui
--   a função: cria uma SOBRECARGA. Com as duas versões vivas, a chamada
--   de 4 argumentos que a página de contatos faz fica ambígua e o
--   PostgREST escolhe uma delas por critério que não controlamos. O
--   `DROP FUNCTION` da assinatura antiga é explícito, e a asserção do
--   fim confere que sobrou exatamente UMA função com este nome.
--
--   O `REVOKE`/`GRANT` também NÃO é herdado pela assinatura nova. Sem
--   reaplicá-lo, a página de contatos passa a devolver 403 para todo
--   mundo — e só em produção, onde ninguém chama a função como
--   `postgres`. A segunda asserção existe para isso.
--
-- Segurança
--
--   `SECURITY INVOKER` permanece, como na 025: a função roda como quem
--   chama, então a RLS de `contacts`, `contact_tags` e `conversations`
--   escopa o resultado à conta (e, no caso de `conversations`, à
--   visibilidade por linha da 039). Trocar para `DEFINER` aqui vazaria
--   contatos entre contas.
--
--   Consequência intencional: para um usuário cuja RLS restringe as
--   conversas que ele enxerga, o filtro de canal enxerga o mesmo
--   recorte. É a resposta certa — filtrar por um dado que o usuário
--   não pode ler seria vazá-lo pela contagem.
--
-- Idempotente — seguro reexecutar.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Índice do filtro
--
-- A 059 criou `idx_conversations_channel (channel_id, last_message_at
-- DESC)`, que serve a lista do inbox e não cobre a projeção por
-- contato deste EXISTS. Este é o índice do filtro.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversations_channel_contact
  ON conversations (account_id, channel_id, contact_id);

-- ------------------------------------------------------------
-- 2) D-4: derrubar a assinatura antiga ANTES de criar a nova
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  -- NULL ou vazio = sem filtro de canal (comportamento da 025).
  p_channel_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- Contatos que satisfazem TODOS os filtros ativos. Cada bloco é
    -- neutro quando o seu parâmetro vem vazio, o que permite as quatro
    -- combinações (nenhum / só etiqueta / só canal / os dois) numa
    -- consulta só.
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE (
      -- Etiquetas: OR entre as selecionadas.
      p_tag_ids IS NULL
      OR cardinality(p_tag_ids) = 0
      OR EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.id
          AND ct.tag_id = ANY(p_tag_ids)
      )
    )
    AND (
      -- Canal: "tem conversa neste canal". Contato é identidade e não
      -- pertence a canal nenhum (princípio 1 do PRD 047) — o que se
      -- filtra é a existência da thread.
      p_channel_ids IS NULL
      OR cardinality(p_channel_ids) = 0
      OR EXISTS (
        SELECT 1 FROM conversations cv
        WHERE cv.contact_id = c.id
          AND cv.channel_id = ANY(p_channel_ids)
      )
    )
    AND (
      p_search IS NULL
      OR c.name ILIKE '%' || p_search || '%'
      OR c.phone ILIKE '%' || p_search || '%'
      OR c.email ILIKE '%' || p_search || '%'
    )
  ),
  page AS (
    -- count(*) OVER() é avaliado antes do LIMIT, então é o total real
    -- da busca, independente da página devolvida.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[]) TO authenticated;

-- ------------------------------------------------------------
-- 3) Asserções — falham alto de propósito (padrão 041/052/059)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_count INT;
BEGIN
  -- D-4: exatamente UMA função com este nome.
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'filter_contacts_by_tags';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '061: % versoes de filter_contacts_by_tags — a sobrecarga antiga sobreviveu ao DROP.', v_count;
  END IF;

  -- O GRANT nao e herdado pela nova assinatura; sem ele a pagina de
  -- contatos devolve 403 para todo mundo, e so em producao.
  IF NOT has_function_privilege('authenticated',
       'public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[])', 'EXECUTE') THEN
    RAISE EXCEPTION '061: authenticated perdeu EXECUTE em filter_contacts_by_tags.';
  END IF;

  -- O filtro de canal le conversations.channel_id: sem a 059 ele nao
  -- tem sobre o que filtrar.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'conversations' AND column_name = 'channel_id') THEN
    RAISE EXCEPTION '061: conversations.channel_id ausente — rode a 059 primeiro.';
  END IF;

  -- A 059 e a SPEC 045 continuam de pe.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename = 'conversations'
                   AND indexname = 'idx_conversations_account_contact_channel') THEN
    RAISE EXCEPTION '061: dedupe de conversas por canal (059) desapareceu.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'conversations' AND column_name = 'last_customer_message_at') THEN
    RAISE EXCEPTION '061: coluna da SPEC 045 desapareceu.';
  END IF;

  RAISE NOTICE '061: filter_contacts_by_tags com filtro de canal aplicado.';
END $$;
