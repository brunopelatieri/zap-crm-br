-- ============================================================
-- 049_dead_number_cleanup.sql — auto-limpeza de números mortos
-- (SPEC 044 §6.4)
--
-- Contatos com ≥2 falhas de entrega CONSECUTIVAS, ou um erro da Meta
-- que já significa "este número não é WhatsApp" (código 131026),
-- recebem `whatsapp_status = 'invalid'` e passam a ser excluídos por
-- padrão de toda audiência futura — nos mesmos três pontos que já
-- excluem opt-out (§6.8): a estimativa do passo 2 (`estimate.ts`), o
-- planejador autoritativo do envio (`broadcast-dispatch.ts`) e a
-- simulação a seco (`broadcast-test-send.ts`, §6.7). Manter um número
-- morto na base infla `total_recipients`, distorce toda taxa derivada
-- e consome cota do tier (§4) para nada.
--
-- Duas decisões que valem ser lidas antes de mexer
--
--   1. **Nenhuma RPC nova.** Ao contrário do opt-in (§6.8), que precisa
--      de uma trilha imutável para responder "quem, quando, por qual
--      via" perante a LGPD, o status de WhatsApp não carrega essa
--      exigência legal — é uma heurística operacional, reversível a
--      qualquer momento, sem consequência jurídica em não ter uma
--      trilha de eventos. A política `contacts_update` (017) já
--      autoriza `agent`+ a escrever qualquer coluna da própria conta;
--      tanto a detecção automática (webhook/despacho, sob service-role
--      ou SSR) quanto a reversão manual (tela do contato) usam um
--      UPDATE direto, sem abrir superfície nova.
--   2. **A detecção mora em TypeScript, não num trigger.** As duas
--      regras (código 131026, ≥2 falhas consecutivas) já precisam
--      existir em código — é onde o erro da Meta chega. Um trigger em
--      SQL duplicaria o predicado `isInvalidWhatsappNumberError` numa
--      segunda linguagem, exatamente a duplicação que o §7 item 3 desta
--      SPEC (e o cabeçalho de `broadcast-variables.ts`) apontam como a
--      fonte mais comum de "duas telas, dois números". Ver
--      `src/lib/contacts/whatsapp-status.ts`.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- ============================================================
-- 1) ESTADO DE WHATSAPP EM `contacts`
--
-- Default 'valid': a base existente nunca foi checada, e um número
-- nunca visto falhar não é "morto" — é desconhecido, o que aqui é o
-- mesmo que válido (ninguém tentou e falhou ainda).
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_status           TEXT NOT NULL DEFAULT 'valid',
  ADD COLUMN IF NOT EXISTS whatsapp_status_reason     TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_status_updated_at TIMESTAMPTZ;

-- CHECKs adicionados à parte (ADD COLUMN IF NOT EXISTS não aceita
-- re-declarar constraint em re-execução).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_whatsapp_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_whatsapp_status_check
      CHECK (whatsapp_status IN ('valid', 'invalid'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_whatsapp_status_reason_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_whatsapp_status_reason_check
      CHECK (
        whatsapp_status_reason IS NULL
        OR whatsapp_status_reason IN (
          'consecutive_failures', 'meta_error', 'manual'
        )
      );
  END IF;
END;
$$;

COMMENT ON COLUMN contacts.whatsapp_status IS
  'valid | invalid (SPEC 044 §6.4). invalid = numero morto, excluido por padrao de audiencias futuras. Reversivel — ver whatsapp-status.ts.';
COMMENT ON COLUMN contacts.whatsapp_status_reason IS
  'Por que ficou no status atual: consecutive_failures (>=2 falhas de entrega seguidas) | meta_error (Meta respondeu que o numero nao e WhatsApp, codigo 131026) | manual (agente mudou na tela do contato).';
COMMENT ON COLUMN contacts.whatsapp_status_updated_at IS
  'Quando o status atual passou a valer. NULL = nunca mudou do default (valid de nascimento).';

-- Parcial: a pergunta que o código faz é sempre "quem desta conta está
-- com número morto", e são a minoria. Mesmo raciocínio do índice de
-- opt-out (048) — o índice fica do tamanho da exceção, não da base.
CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_invalid
  ON contacts(account_id)
  WHERE whatsapp_status = 'invalid';

-- ============================================================
-- 2) ASSERÇÕES — padrão 042/044/045/046/048
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name = 'whatsapp_status'
  ) THEN
    RAISE EXCEPTION '049: contacts.whatsapp_status nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_whatsapp_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    RAISE EXCEPTION '049: CHECK contacts_whatsapp_status_check ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_whatsapp_status_reason_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    RAISE EXCEPTION '049: CHECK contacts_whatsapp_status_reason_check ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'contacts'
      AND indexname = 'idx_contacts_whatsapp_invalid'
  ) THEN
    RAISE EXCEPTION '049: indice idx_contacts_whatsapp_invalid ausente.';
  END IF;
END;
$$;
