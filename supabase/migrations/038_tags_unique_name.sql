-- ============================================================
-- 038_tags_unique_name.sql — unicidade de nome de etiqueta por conta
--
-- Por que isso existe
--
--   O picker de etiquetas do Inbox precisa de um "get-or-create":
--   o operador digita um nome e, se a etiqueta já existir, ela é
--   apenas atribuída ao contato em vez de duplicada. Sem uma
--   constraint no banco, essa checagem só pode ser feita no cliente
--   (SELECT ... ILIKE antes do INSERT), o que não cobre a corrida
--   entre dois operadores criando o mesmo nome ao mesmo tempo —
--   ambos leem "não existe" e ambos inserem.
--
--   Com o índice único abaixo, o INSERT concorrente perdedor falha
--   com 23505 (unique_violation) e o cliente trata esse código
--   como "já existe → apenas atribui". O get-or-create passa a ser
--   atômico sem precisar de transação explícita ou RPC.
--
--   `lower(name)` porque "Cliente VIP" e "cliente vip" são a mesma
--   etiqueta para quem opera. Sem isso o catálogo acumula variações
--   de caixa que quebram tanto o filtro do Inbox quanto o público-
--   alvo de disparos.
--
-- Escopo
--
--   Por `account_id`, não por `user_id`: desde a migração 017 as
--   etiquetas são um recurso compartilhado da conta (política
--   `tags_select` usa `is_account_member(account_id)`), então duas
--   contas distintas podem ter "Cliente VIP" sem conflito.
--
-- Dedupe prévio
--
--   Bases existentes podem já ter duplicatas (o tag-manager insere
--   sem verificar desde a 001). O bloco abaixo consolida antes de
--   criar o índice, senão o CREATE UNIQUE INDEX falha. A etiqueta
--   sobrevivente é a mais antiga (menor created_at, desempate por
--   id) — preserva o registro que os contatos já referenciam há
--   mais tempo.
--
--   Os vínculos são movidos com UPDATE, e não com
--   `INSERT ... ON CONFLICT DO NOTHING`. Dois motivos:
--     - preserva o `created_at` original de cada vínculo (o INSERT
--       criava linhas novas, reescrevendo desde quando o contato
--       carrega aquela etiqueta);
--     - o linter do editor SQL do Supabase lê o padrão
--       `INSERT INTO contact_tags (col, col)` como se fosse uma
--       criação de tabela e emite um falso positivo de "tabela sem
--       RLS". contact_tags tem RLS desde a 001 (políticas revisadas
--       na 017); o alerta era só ruído, mas ruído que leva alguém a
--       clicar no botão errado.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Consolida duplicatas de (account_id, lower(name))
-- ------------------------------------------------------------
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY account_id, lower(name)
      ORDER BY created_at, id
    ) AS keeper_id
  FROM tags
),
dupes AS (
  SELECT id, keeper_id FROM ranked WHERE id <> keeper_id
),
-- Escolhe UM vínculo por (contato, etiqueta sobrevivente) para
-- reapontar.
--
-- O DISTINCT ON é obrigatório, não cosmético: se um contato carrega
-- duas duplicatas da mesma etiqueta (ex.: "vip" e "Vip", ambas
-- apontando para "VIP"), reapontar as duas colidiria com
-- UNIQUE(contact_id, tag_id) dentro do próprio UPDATE. Movemos a
-- mais antiga e deixamos as demais serem removidas pelo CASCADE.
--
-- O NOT EXISTS cobre o caso irmão: o contato já tem a etiqueta
-- sobrevivente, então o vínculo da duplicata é puro descarte.
targets AS (
  SELECT DISTINCT ON (ct.contact_id, d.keeper_id)
    ct.id AS link_id,
    d.keeper_id
  FROM contact_tags ct
  JOIN dupes d ON d.id = ct.tag_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM contact_tags existing
    WHERE existing.contact_id = ct.contact_id
      AND existing.tag_id = d.keeper_id
  )
  ORDER BY ct.contact_id, d.keeper_id, ct.created_at, ct.id
),
moved AS (
  UPDATE contact_tags ct
  SET tag_id = t.keeper_id
  FROM targets t
  WHERE ct.id = t.link_id
  RETURNING 1
)
-- ON DELETE CASCADE em contact_tags.tag_id limpa os vínculos
-- remanescentes das duplicatas (os redundantes e os preteridos
-- pelo DISTINCT ON acima).
DELETE FROM tags
WHERE id IN (SELECT id FROM dupes);

-- ------------------------------------------------------------
-- 2. Índice único case-insensitive por conta
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON tags (account_id, lower(name));
