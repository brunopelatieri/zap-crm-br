-- ============================================================
-- 057_notification_text_ptbr.sql — traduz o texto da notificação de
-- atribuição de conversa
--
-- `notify_conversation_assigned` (027:56) grava `title`/`body` como
-- texto FIXO em inglês na hora do INSERT — não é uma chave de i18n
-- traduzida na renderização. `notifications/page.tsx` exibe
-- `n.title`/`n.body` direto do banco (sem passar por next-intl), então
-- o texto gravado É o texto final visto pelo agente. Como o produto é
-- localizado para pt-BR e não guarda idioma por usuário, o texto vai
-- fixo em português — mesmo padrão do resto do app.
--
-- Não reescreve linhas já existentes: apenas as notificações CRIADAS
-- a partir de agora saem traduzidas.
-- ============================================================

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'Nova conversa atribuída',
    COALESCE(v_actor_name, 'Alguém') || ' atribuiu a você uma conversa com '
      || COALESCE(v_contact_name, 'um contato')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
