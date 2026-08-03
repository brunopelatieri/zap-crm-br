-- ============================================================
-- verify-040-media.sql — conferência da migração 040
--
-- NÃO é uma migração: mora fora de supabase/migrations/ de propósito,
-- para não ser aplicado automaticamente. Cole no SQL editor do Supabase
-- DEPOIS de rodar `040_private_media.sql`.
--
-- PARTE A é automática e não escreve nada — rode-a inteira.
-- PARTE B é a conferência de RESÍDUO: precisa dar zero antes de você
--        considerar a migração concluída (é o que decide se alguma
--        mídia histórica sumiu da tela do usuário).
-- PARTE C precisa de um terminal fora do SQL editor (curl).
-- ============================================================


-- ============================================================
-- PARTE A — asserções estruturais (read-only)
--
-- Toda linha deve sair com status 'OK'. Qualquer 'FALHOU' significa que
-- a 040 não foi aplicada por inteiro.
-- ============================================================

WITH checks AS (

  -- 1-2. Colunas novas em `messages`
  SELECT
    '1. Coluna messages.media_id' AS verificacao,
    EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'messages'
         AND column_name = 'media_id'
    ) AS passou,
    'sem ela a rota-proxy nao consegue autorizar o download (F-40-A)' AS por_que_importa

  UNION ALL SELECT
    '2. Coluna messages.media_path',
    EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'messages'
         AND column_name = 'media_path'
    ),
    'sem ela nao da para mintar URL assinada da midia enviada'

  UNION ALL SELECT
    '3. Indice idx_messages_media_id',
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_messages_media_id'
    ),
    'a rota consulta por media_id a cada abertura de midia'

  -- 4-5. Buckets privados — o coracao do F-40-B
  UNION ALL SELECT
    '4. Bucket chat-media e PRIVADO',
    EXISTS (
      SELECT 1 FROM storage.buckets WHERE id = 'chat-media' AND public = FALSE
    ),
    'publico = leitura anonima de anexo de QUALQUER inquilino'

  UNION ALL SELECT
    '5. Bucket flow-media e PRIVADO',
    EXISTS (
      SELECT 1 FROM storage.buckets WHERE id = 'flow-media' AND public = FALSE
    ),
    'mesmo desenho do chat-media (016), mesmo furo'

  -- 6-7. Politicas publicas de leitura removidas
  UNION ALL SELECT
    '6. Politica "Chat media is publicly readable" REMOVIDA',
    NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Chat media is publicly readable'
    ),
    'ela concedia SELECT sem nenhuma checagem de identidade'

  UNION ALL SELECT
    '7. Politica "Flow media is publicly readable" REMOVIDA',
    NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Flow media is publicly readable'
    ),
    'idem, para o bucket dos flows'

  -- 8. Politica nova, escopada por conta
  UNION ALL SELECT
    '8. Politica "Members read own account media" existe',
    EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Members read own account media'
    ),
    'e a unica leitura permitida nos dois buckets agora'

  UNION ALL SELECT
    '9. A politica nova consulta profiles',
    EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Members read own account media'
         AND qual ILIKE '%profiles%'
    ),
    'sem o EXISTS em profiles ela nao isola conta nenhuma'

  -- 10. As politicas de ESCRITA da 023/020 seguem intactas
  UNION ALL SELECT
    '10. Politicas de escrita preservadas',
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN (
          'Members can upload chat media', 'Members can update chat media',
          'Members can delete chat media', 'Members can upload flow media',
          'Members can update flow media',  'Members can delete flow media'
        )) = 6,
    'a 040 nao deve mexer em escrita — se caiu, o upload quebrou'
)
SELECT
  verificacao,
  CASE WHEN passou THEN 'OK' ELSE 'FALHOU' END AS status,
  por_que_importa
FROM checks
ORDER BY verificacao;


-- ============================================================
-- PARTE B — RESÍDUO (a conferência que decide o deploy)
--
-- ⚠️ `sem_path` PRECISA SER ZERO.
--
-- Cada linha contada aqui é uma mídia enviada cujo caminho no bucket
-- não pôde ser derivado da URL gravada. Com o bucket já privado, ela
-- não abre mais na tela de ninguém. Se der > 0, investigue com a
-- segunda query antes de dar a migração por concluída.
-- ============================================================

SELECT count(*) FILTER (WHERE media_path IS NULL) AS sem_path,
       count(*)                                   AS total_midia_enviada
  FROM messages
 WHERE media_url LIKE '%/chat-media/%';

-- Quais linhas ficaram para trás (rode só se a de cima deu > 0):
SELECT id, conversation_id, created_at, media_url
  FROM messages
 WHERE media_url LIKE '%/chat-media/%'
   AND media_path IS NULL
 ORDER BY created_at DESC
 LIMIT 20;

-- Mídia RECEBIDA sem `media_id`: a rota-proxy vai responder 404 para
-- estas, inclusive para o dono da conversa. O backfill da seção 1 cobre
-- tudo que seguiu o formato da rota, então o esperado também é zero.
SELECT count(*) AS recebidas_sem_media_id
  FROM messages
 WHERE media_url LIKE '/api/whatsapp/media/%'
   AND media_id IS NULL;

-- Objetos de flow na convenção ANTIGA (por usuário, anterior à 020).
-- Não é erro: a política da seção 3 tem uma cláusula de legado que os
-- mantém legíveis pelo próprio dono. É só para você saber que existem.
SELECT count(*) AS objetos_flow_legado
  FROM storage.objects
 WHERE bucket_id = 'flow-media'
   AND (storage.foldername(name))[1] NOT LIKE 'account-%';


-- ============================================================
-- PARTE C — prova de fogo (fora do SQL editor)
--
-- 1. LEITURA ANÔNIMA DEVE FALHAR. Pegue uma URL de anexo qualquer:
--
--      SELECT media_url FROM messages
--       WHERE media_url LIKE '%/chat-media/%' LIMIT 1;
--
--    e, num terminal SEM nenhum cabeçalho de autenticação:
--
--      curl -s -o /dev/null -w '%{http_code}\n' '<a url acima>'
--
--    Esperado: 400 ou 404 (o Storage nao expoe bucket privado por
--    /object/public). Um 200 significa que o bucket ainda esta publico
--    — a Parte A teria acusado, mas confira mesmo assim.
--
-- 2. PROXY DE MÍDIA RECEBIDA (F-40-A). Com a sessão de um agente que
--    NÃO é dono da conversa:
--
--      curl -s -o /dev/null -w '%{http_code}\n' \
--        -H 'Cookie: <sessao do agente B>' \
--        'https://<app>/api/whatsapp/media/<mediaId de conversa do agente A>'
--
--    Esperado: 404 (nunca 403 — um 403 confirmaria que o anexo existe).
--    Com a sessão do agente A (dono): 200.
--
-- 3. CACHE. Confira que nenhuma resposta de mídia sai com
--    `Cache-Control: public`:
--
--      curl -sI -H 'Cookie: <sessao>' \
--        'https://<app>/api/whatsapp/media/<mediaId>' | grep -i cache-control
--
--    Esperado: `private, max-age=86400`.
-- ============================================================
