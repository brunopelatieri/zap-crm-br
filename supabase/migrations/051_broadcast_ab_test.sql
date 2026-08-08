-- ============================================================
-- 051_broadcast_ab_test.sql — teste A/B de template (SPEC 044 §6.6)
--
-- O que isto resolve
--
--   "Qual das duas mensagens funciona melhor?" hoje só é respondível
--   disparando duas campanhas para duas audiências diferentes — o que
--   compara audiência, não texto. Esta migração cria o vínculo que
--   permite dividir UMA audiência triada entre dois templates aprovados
--   e comparar os funis lado a lado.
--
-- O desenho: a variante A É a campanha
--
--   Não existe linha "pai vazia". A variante A é um `broadcasts` comum,
--   com `variant_label = 'A'` e `parent_broadcast_id NULL`; a variante B
--   é outra linha, com `variant_label = 'B'` e `parent_broadcast_id`
--   apontando para A. Duas consequências deliberadas:
--
--     • Tudo o que já existe continua valendo sem exceção — contadores do
--       trigger agregador (003/005), destinatários, webhooks de status,
--       polling da tela de detalhe. Cada braço é uma campanha de verdade.
--     • Um teste A/B nunca cria uma linha órfã sem destinatário na lista
--       do usuário. Ele vê duas campanhas, que é o que de fato saiu.
--
--   O preço é a assimetria: A carrega `ab_split_percent` (a fatia da
--   audiência que coube a ela) e B não carrega nada além do vínculo. É
--   assimetria honesta — o percentual descreve a DIVISÃO, e a divisão
--   pertence ao par, cujo dono é A.
--
-- Por que `ON DELETE CASCADE`
--
--   Apagar a variante A e deixar B viva produziria uma campanha que diz
--   "sou a variante B" sem nada com que comparar. O par nasce e morre
--   junto. Apagar só a B é permitido e degrada para uma campanha comum —
--   a tela de comparação some, os números de A continuam corretos.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) COLUNAS
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS parent_broadcast_id UUID
    REFERENCES broadcasts(id) ON DELETE CASCADE;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS variant_label TEXT;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS ab_split_percent SMALLINT;

COMMENT ON COLUMN broadcasts.parent_broadcast_id IS
  'Teste A/B (SPEC 044 §6.6): preenchido apenas na variante B, apontando para a variante A. NULL em toda campanha comum.';
COMMENT ON COLUMN broadcasts.variant_label IS
  'Teste A/B (SPEC 044 §6.6): A ou B. NULL em campanha comum — um teste com um braço só nao e um teste.';
COMMENT ON COLUMN broadcasts.ab_split_percent IS
  'Teste A/B (SPEC 044 §6.6): percentual da audiencia sorteado para a variante A. Vive na linha A; NULL em qualquer outra.';

-- ============================================================
-- 2) INVARIANTES DE FORMA
--
-- O CHECK amarra rótulo e vínculo um ao outro. Sem ele seria possível
-- gravar uma linha `variant_label = 'B'` sem pai (uma variante de
-- coisa nenhuma) ou um filho rotulado 'A' — os dois casos fariam a tela
-- de comparação da §6.6 renderizar lixo em vez de falhar.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_ab_variant_shape_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_ab_variant_shape_check
      CHECK (
        (parent_broadcast_id IS NULL
          AND (variant_label IS NULL OR variant_label = 'A'))
        OR
        (parent_broadcast_id IS NOT NULL AND variant_label = 'B')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_ab_split_percent_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_ab_split_percent_check
      CHECK (
        ab_split_percent IS NULL
        OR (ab_split_percent BETWEEN 1 AND 99)
      );
  END IF;
END;
$$;

-- Um pai, uma variante B. Também é o índice que a tela de detalhe usa
-- para achar o irmão de uma campanha (`WHERE parent_broadcast_id = $1`).
CREATE UNIQUE INDEX IF NOT EXISTS broadcasts_one_variant_b_per_parent
  ON broadcasts(parent_broadcast_id)
  WHERE parent_broadcast_id IS NOT NULL;

-- ============================================================
-- 3) PROFUNDIDADE 1 — o CHECK não alcança isto
--
-- Um CHECK só enxerga a própria linha, então nada nele impede
-- A → B → C: a variante B de um teste virando pai de outra. A tela de
-- comparação assume exatamente dois braços, e uma corrente produziria
-- números que não somam a audiência de ninguém. O gatilho é o único
-- lugar onde essa regra cabe.
-- ============================================================
CREATE OR REPLACE FUNCTION public.broadcasts_ab_depth_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_parent_of_parent UUID;
BEGIN
  IF NEW.parent_broadcast_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_broadcast_id = NEW.id THEN
    RAISE EXCEPTION 'broadcast % nao pode ser variante de si mesmo', NEW.id
      USING ERRCODE = '23514';
  END IF;

  SELECT b.parent_broadcast_id INTO v_parent_of_parent
    FROM broadcasts b
   WHERE b.id = NEW.parent_broadcast_id;

  IF v_parent_of_parent IS NOT NULL THEN
    RAISE EXCEPTION
      'teste A/B tem no maximo dois bracos: % ja e a variante B de %',
      NEW.parent_broadcast_id, v_parent_of_parent
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.broadcasts_ab_depth_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS broadcasts_ab_depth_guard_trigger ON broadcasts;
CREATE TRIGGER broadcasts_ab_depth_guard_trigger
  BEFORE INSERT OR UPDATE OF parent_broadcast_id ON broadcasts
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcasts_ab_depth_guard();

COMMENT ON FUNCTION public.broadcasts_ab_depth_guard() IS
  'SPEC 044 §6.6: impede corrente de variantes (A -> B -> C) e auto-referencia. Um teste tem exatamente dois bracos.';

-- ============================================================
-- 4) RLS — nada novo
--
-- As políticas de `broadcasts` (001, endurecidas na 017) escopam por
-- conta e já cobrem colunas novas: a variante B é inserida pela mesma
-- sessão, com o mesmo `account_id`, na mesma transação lógica do
-- disparo. Registrado aqui de propósito: a ausência de política nova é
-- uma decisão, não um esquecimento.
-- ============================================================

-- ============================================================
-- 5) ASSERÇÕES — padrão 042/044/045/046/048/049/050
-- ============================================================
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT array_agg(c)
    INTO v_missing
    FROM unnest(ARRAY['parent_broadcast_id', 'variant_label', 'ab_split_percent']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'broadcasts'
        AND column_name = c
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '051: colunas ausentes em broadcasts: %',
      array_to_string(v_missing, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_ab_variant_shape_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    RAISE EXCEPTION '051: CHECK broadcasts_ab_variant_shape_check ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_ab_split_percent_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    RAISE EXCEPTION '051: CHECK broadcasts_ab_split_percent_check ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'broadcasts_one_variant_b_per_parent'
  ) THEN
    RAISE EXCEPTION '051: indice unico broadcasts_one_variant_b_per_parent ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'broadcasts_ab_depth_guard_trigger'
      AND tgrelid = 'public.broadcasts'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '051: gatilho broadcasts_ab_depth_guard_trigger ausente.';
  END IF;

  -- O FK precisa cascatear: um par meio apagado é pior do que nenhum.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcasts'::regclass
      AND contype = 'f'
      AND confdeltype = 'c'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.broadcasts'::regclass
           AND attname = 'parent_broadcast_id'
      )]::SMALLINT[]
  ) THEN
    RAISE EXCEPTION
      '051: broadcasts.parent_broadcast_id nao tem FK com ON DELETE CASCADE.';
  END IF;
END;
$$;
