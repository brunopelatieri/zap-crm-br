-- ============================================================
-- 060_merge_conversations_by_channel — alinha o merge de conversas
-- duplicadas ao invariante que a 059 criou
--
-- O problema
--
--   A 036 criou `merge_duplicate_conversations()` agrupando por
--   `(account_id, contact_id)`, porque naquele momento esse ERA o
--   invariante — o índice único `idx_conversations_account_contact`
--   dizia exatamente isso.
--
--   A 059 trocou o invariante por `(account_id, contact_id, channel_id)`
--   (D-2 do PRD 047: uma thread por canal), mas deixou a função como
--   estava. Ela virou uma arma carregada: rodada hoje, ela olha a thread
--   do WhatsApp Oficial e a do WhatsApp QRCode do MESMO contato, conclui
--   que são duplicatas, re-aponta mensagens/negócios/execuções de fluxo
--   de uma para a outra e DELETA a perdedora — desfazendo em uma chamada
--   a separação por canal, e deixando mensagens enviadas por um número
--   arquivadas numa conversa carimbada com o outro.
--
--   Não é hipotético: a função é o remédio documentado para "conversas
--   duplicadas", e o procedimento de dados legados da SPEC 050 §9.2
--   ensina o mantenedor a rodar a função IRMÃ (`merge_duplicate_contacts`)
--   na próxima fase. A chance de alguém rodar esta por analogia é alta.
--
-- A correção
--
--   Acrescenta `channel_id` ao GROUP BY. Duas conversas só são
--   duplicatas se forem do mesmo contato NO MESMO CANAL — que é
--   exatamente o que o índice único da 059 permite/proíbe.
--
--   O resto do corpo é idêntico ao da 036, de propósito: o re-apontamento
--   dos filhos antes do DELETE, a soma dos não-lidos e a re-derivação do
--   `last_message_*` continuam sendo o comportamento correto DENTRO de um
--   canal. Só o critério de "quem é duplicata de quem" mudou.
--
-- Sem perda de dados. Idempotente. Não executa o merge automaticamente
-- (ao contrário da 036, que rodava na hora): depois da 059 não deve
-- existir duplicata nenhuma, e disparar um merge em migração seria
-- justamente o risco que este arquivo existe para fechar.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           channel_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    -- `channel_id` entra no GROUP BY: é o que impede a thread do canal
    -- oficial e a do QRCode do mesmo contato de serem lidas como
    -- duplicatas (059 / PRD 047 D-2).
    GROUP BY account_id, contact_id, channel_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    -- Re-aponta todo filho escopado por conversa antes do DELETE — é o
    -- que salva messages/message_reactions/notifications do
    -- ON DELETE CASCADE. Nenhum deles tem restrição única por conversa
    -- (message_id é não-único de propósito — migração 009).
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

-- Mantém o lockdown da 042: SECURITY DEFINER varrendo todas as contas
-- não pode ser chamável por `authenticated`.
ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM anon;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM authenticated;

COMMENT ON FUNCTION public.merge_duplicate_conversations() IS
  'Funde conversas duplicadas dentro de (account_id, contact_id, channel_id) — o invariante da migração 059. NÃO agrupa entre canais: a thread do WhatsApp Oficial e a do QRCode do mesmo contato são distintas por desenho (PRD 047 D-2).';

-- ------------------------------------------------------------
-- Asserções — falham alto de propósito
-- ------------------------------------------------------------
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_duplicate_conversations';

  IF v_src IS NULL THEN
    RAISE EXCEPTION '060: merge_duplicate_conversations nao existe apos o CREATE OR REPLACE.';
  END IF;

  IF v_src NOT LIKE '%GROUP BY account_id, contact_id, channel_id%' THEN
    RAISE EXCEPTION '060: a funcao nao agrupa por channel_id — fundiria threads de canais diferentes.';
  END IF;

  -- O índice da 059 é o que dá sentido ao agrupamento acima.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'conversations'
      AND indexname = 'idx_conversations_account_contact_channel'
  ) THEN
    RAISE EXCEPTION '060: idx_conversations_account_contact_channel (059) ausente — rode a 059 primeiro.';
  END IF;
END $$;
