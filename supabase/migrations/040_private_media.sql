-- ============================================================
-- 040_private_media.sql — mídia entra no perímetro de isolamento
--
-- Por que isso existe
--
--   A 039 trocou o isolamento POR CONTA por isolamento POR LINHA nas
--   tabelas de conversa. A mídia ficou de fora, e o cabeçalho da 039
--   registrou a dívida (039:71-79): "o bucket chat-media é PÚBLICO
--   (…) enquanto isso não for corrigido, o isolamento de conversas é
--   parcial: o texto fica protegido, os anexos não".
--
--   Esta migração é esse ticket. Ela cobre os DOIS caminhos de mídia
--   do produto, que têm armazenamentos diferentes:
--
--     RECEBIDA do cliente — não fica em bucket nenhum. O webhook grava
--       em `messages.media_url` a rota-proxy `/api/whatsapp/media/<id>`
--       e o byte é buscado à Meta sob demanda. O furo era de
--       AUTORIZAÇÃO na rota (F-40-A), corrigido no app; aqui só entra
--       a coluna `media_id` que essa checagem usa.
--
--     ENVIADA pelo agente — vai para o bucket `chat-media`, que é
--       PÚBLICO: leitura anônima, sem login, de qualquer objeto de
--       qualquer inquilino (023:83-86). É o F-40-B, e é o que a
--       seção 3 fecha.
--
-- ⚠️ DUAS ARMADILHAS — leia antes de mexer
--
--   1. FECHAR O BUCKET QUEBRA MÍDIA HISTÓRICA.
--      Toda mídia enviada antes desta migração tem só a URL pública
--      gravada. Se o bucket virar privado sem que o app saiba derivar
--      o caminho do objeto, a mídia some da tela do usuário. Por isso
--      a seção 2 faz o backfill de `media_path` ANTES, e a seção 5
--      publica a query de resíduo que precisa dar zero antes de
--      fechar.
--
--   2. `header_media_url` NEM SEMPRE É NOSSO.
--      O campo aceita URL externa colada pelo usuário
--      (step3-personalize.tsx:266, template-preview.tsx:30). Convertê-lo
--      em caminho de objeto quebraria esse caso legítimo. Ele
--      permanece sendo uma URL; quem resolve se ela é nossa (e portanto
--      precisa ser assinada na hora do uso) é `lib/storage/media-url.ts`.
--      Mesma coisa para `media_url` de nó de flow.
--
-- Idempotente — seguro reexecutar.
-- ============================================================


-- ============================================================
-- 1. `messages.media_id` — a coluna que sustenta a autorização
--                          da rota-proxy (F-40-A)
--
-- A rota `/api/whatsapp/media/[mediaId]` precisa responder "esta mídia
-- pertence a uma mensagem que VOCÊ pode ver?" antes de gastar uma
-- chamada à Meta. Até agora o id da mídia só existia embutido na
-- string de `media_url`; casar por ela funcionaria, mas amarraria a
-- autorização ao formato de uma rota — mude o prefixo e a checagem
-- silenciosamente para de casar.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id TEXT;

COMMENT ON COLUMN messages.media_id IS
  'Id da mídia na Meta, para mensagens recebidas. Usado pela rota /api/whatsapp/media/[mediaId] para autorizar o download via RLS de messages (SPEC 040, F-40-A). Nulo para mídia enviada pelo agente, que vive no bucket.';

-- Backfill do histórico. O prefixo é estável desde que a rota existe.
UPDATE messages
   SET media_id = substring(media_url FROM '^/api/whatsapp/media/([^?#]+)$')
 WHERE media_id IS NULL
   AND media_url LIKE '/api/whatsapp/media/%';

-- Índice parcial: a rota busca por este valor a cada abertura de mídia,
-- e só uma fração das mensagens tem mídia recebida.
CREATE INDEX IF NOT EXISTS idx_messages_media_id
  ON messages(media_id) WHERE media_id IS NOT NULL;


-- ============================================================
-- 2. `messages.media_path` — o objeto no bucket (F-40-B)
--
-- Com o bucket privado, exibir mídia enviada exige mintar uma URL
-- assinada, e para isso é preciso o CAMINHO do objeto. Guardá-lo
-- explicitamente evita ter de reverter a URL pública por regex a cada
-- leitura — e, mais importante, é o que permite fechar o bucket sem
-- perder a mídia já enviada.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path TEXT;

COMMENT ON COLUMN messages.media_path IS
  'Caminho do objeto dentro do bucket chat-media (account-<uuid>/<ts>-<nome>.<ext>), para mídia enviada pelo agente. Fonte de verdade para mintar URL assinada (SPEC 040). Nulo para mídia recebida, que usa media_id.';

-- Backfill: extrai o caminho da URL pública já gravada.
--
-- Formato servido pelo Storage:
--   <projeto>/storage/v1/object/public/chat-media/account-<uuid>/<arquivo>
-- O `[^?#]+` para na query string (a URL pública não costuma ter uma,
-- mas uma assinada teria `?token=`).
UPDATE messages
   SET media_path = substring(
         media_url FROM '/storage/v1/object/(?:public|sign|authenticated)/chat-media/([^?#]+)'
       )
 WHERE media_path IS NULL
   AND media_url LIKE '%/chat-media/%';


-- ============================================================
-- 3. STORAGE — buckets deixam de ser públicos
--
-- `public = FALSE` faz o Storage parar de servir o objeto pela rota
-- `/object/public/...` sem credencial. A leitura passa a exigir uma
-- URL assinada (`createSignedUrl`), que o app minta sob demanda para
-- quem tem permissão.
--
-- A objeção óbvia — "mas a Meta precisa buscar a mídia" — não se
-- sustenta: a Meta baixa o arquivo UMA vez, no instante do envio, e
-- re-hospeda por conta própria. Uma URL de 10 minutos é folgada.
-- ============================================================

UPDATE storage.buckets
   SET public = FALSE
 WHERE id IN ('chat-media', 'flow-media');

-- ---- leitura -------------------------------------------------------
--
-- Escopo de CONTA, não de conversa. Seria tentador cruzar com
-- `can_access_conversation` para espelhar a 039, mas o caminho do
-- objeto não carrega `conversation_id` — carrega só `account-<uuid>` —
-- e o mesmo bucket serve mídia de template e de flow, que não
-- pertencem a conversa nenhuma. Fechar por conta elimina o furo
-- EXTERNO (leitura anônima), que é o desta migração; o resíduo interno
-- está registrado na §6 da SPEC 040 e o vetor prático dele some com a
-- correção da rota-proxy.
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members read own account media" ON storage.objects;

CREATE POLICY "Members read own account media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id IN ('chat-media', 'flow-media')
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      -- LEGADO do `flow-media`. O bucket nasceu na 016 com caminho POR
      -- USUÁRIO (`flow-media/<auth.uid()>/…`, 016:19); só a 020
      -- reescreveu as políticas de ESCRITA para `account-<uuid>` — os
      -- objetos antigos nunca foram movidos. Sem esta cláusula, todo
      -- anexo de flow anterior à 020 ficaria ilegível para o próprio
      -- dono. Mantém o mesmo nível de isolamento (o uid é do
      -- solicitante), só reconhece a convenção antiga.
      OR (storage.foldername(name))[1] = auth.uid()::text
    )
  );


-- ============================================================
-- 4. HIGIENE — a `service_role` continua lendo tudo
--
-- O envio à Meta, o handle de header de template e o motor de flows
-- rodam com service role e precisam ler o objeto para assiná-lo ou
-- baixá-lo. A `service_role` ignora RLS por natureza, então não há
-- política a criar — este bloco existe só para registrar que a
-- omissão é deliberada, não esquecimento.
-- ============================================================


-- ============================================================
-- 5. CONFERÊNCIA — rode DEPOIS de aplicar
--
-- Mídia enviada cujo caminho não pôde ser derivado da URL. Com o
-- bucket já privado, cada linha aqui é uma mídia que sumiu da tela de
-- alguém. O esperado é ZERO — o backfill da seção 2 cobre tudo que
-- seguiu a convenção de `buildMediaPath`.
--
--   SELECT count(*) FILTER (WHERE media_path IS NULL) AS sem_path,
--          count(*)                                   AS total
--     FROM messages
--    WHERE media_url LIKE '%/chat-media/%';
--
-- Se `sem_path > 0`, investigue as linhas antes de considerar a
-- migração concluída:
--
--   SELECT id, conversation_id, created_at, media_url
--     FROM messages
--    WHERE media_url LIKE '%/chat-media/%' AND media_path IS NULL
--    LIMIT 20;
--
-- Objetos de flow na convenção antiga (por usuário), cobertos pela
-- cláusula de legado da seção 3:
--
--   SELECT count(*) FROM storage.objects
--    WHERE bucket_id = 'flow-media'
--      AND (storage.foldername(name))[1] NOT LIKE 'account-%';
-- ============================================================
