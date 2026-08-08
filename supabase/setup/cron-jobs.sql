-- ============================================================
-- cron-jobs.sql — agenda os três pingers de cron do ZAP CRM BR
-- usando o Supabase Cron (pg_cron + pg_net).
--
-- ⚠️ ISTO NÃO É UMA MIGRAÇÃO. Não numere, não coloque em
--    `supabase/migrations/`, não rode em CI.
--
--    As migrações descrevem o SCHEMA da aplicação e valem igual em
--    todo ambiente e em todo fork. Este arquivo descreve a
--    CONFIGURAÇÃO DE UM AMBIENTE: carrega a URL pública daquele deploy
--    e o segredo daquele operador. Versionado como migração, ele faria
--    o fork de qualquer pessoa agendar chamadas para o domínio de
--    outra — e, pior, o segredo viraria texto no git.
--
--    Por isso o arquivo tem duas partes: a PARTE 1 você edita e roda
--    uma vez por projeto; a PARTE 2 é copiar e colar sem tocar em nada.
--
-- Onde rodar: SQL Editor do painel do Supabase, no projeto que o SEU
-- deploy de produção usa (confira o `NEXT_PUBLIC_SUPABASE_URL` do
-- ambiente). Rodar no projeto errado cria um cron que funciona e não
-- serve para nada.
--
-- O que estes jobs fazem
--
--   /api/broadcasts/cron   — dispara campanhas AGENDADAS que venceram
--                            (SPEC 044 §6.3 e §6.6). Sem ele, um
--                            agendamento fica em `scheduled` para
--                            sempre: nada mais no app olha para
--                            `broadcasts.scheduled_at`.
--   /api/automations/cron  — retoma automações paradas em passos de
--                            espera (Wait).
--   /api/flows/cron        — encerra execuções de fluxo abandonadas.
--
-- Idempotente: `cron.schedule` com um nome que já existe SOBRESCREVE o
-- job anterior, e a parte 1 apaga o segredo antigo antes de recriar.
-- Rodar duas vezes não duplica nada.
-- ============================================================


-- ============================================================
-- PARTE 1 — EDITE ESTES DOIS VALORES E RODE
--
-- Os dois vão para o Supabase Vault (extensão `supabase_vault`, já
-- instalada), não para dentro do comando do job. O motivo é concreto:
-- o comando de um job fica legível em texto puro em `cron.job.command`,
-- e uma tabela que qualquer futuro `select * from cron.job` expõe não é
-- lugar para segredo. No Vault ele fica cifrado em repouso e o job o lê
-- no instante da execução.
--
-- ⚠️ NÃO commite este arquivo depois de preencher. Substitua os valores
--    no editor do painel, rode, e descarte.
-- ============================================================

-- URL pública do app, SEM barra no final.
--   Ex.: https://crm.seudominio.com
-- Segredo: o MESMO valor de `AUTOMATION_CRON_SECRET` configurado nas
-- variáveis de ambiente do deploy. Se ainda não existe, gere um com
--   openssl rand -hex 32
-- e configure-o no painel do host ANTES de rodar isto — sem a variável
-- no servidor, as três rotas respondem 503 por segurança.

DO $$
DECLARE
  v_app_url    TEXT := 'https://SUBSTITUA-PELO-SEU-DOMINIO.com';
  v_cron_secret TEXT := 'SUBSTITUA-PELO-AUTOMATION_CRON_SECRET';
BEGIN
  IF v_app_url LIKE '%SUBSTITUA%' OR v_cron_secret LIKE '%SUBSTITUA%' THEN
    RAISE EXCEPTION
      'Edite v_app_url e v_cron_secret na PARTE 1 antes de rodar este script.';
  END IF;

  IF right(v_app_url, 1) = '/' THEN
    RAISE EXCEPTION 'v_app_url nao pode terminar com barra: %', v_app_url;
  END IF;

  -- Reexecutar o script troca os valores em vez de falhar com nome
  -- duplicado — é o que permite rotacionar o segredo rodando de novo.
  DELETE FROM vault.secrets WHERE name IN ('zapcrm_app_url', 'zapcrm_cron_secret');

  PERFORM vault.create_secret(v_app_url, 'zapcrm_app_url',
    'ZAP CRM BR: URL publica do app, usada pelos jobs de cron.');
  PERFORM vault.create_secret(v_cron_secret, 'zapcrm_cron_secret',
    'ZAP CRM BR: valor de AUTOMATION_CRON_SECRET, enviado no header x-cron-secret.');
END;
$$;


-- ============================================================
-- PARTE 2 — COPIE E COLE SEM EDITAR
-- ============================================================

-- ── Extensões ────────────────────────────────────────────────
-- pg_cron  → o agendador (cria o schema `cron`).
-- pg_net   → HTTP assíncrono de dentro do Postgres (cria o schema
--            `net`). É beta segundo a própria Supabase; para um pinger
--            de 5 em 5 minutos isso é aceitável — se uma execução
--            falhar, a próxima acontece em minutos e o app não perde
--            estado (o claim de cada rota é idempotente).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net;

GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- Falha cedo e com mensagem legível se o pg_net tiver sido instalado em
-- outro schema (o painel às vezes usa `extensions`), em vez de deixar o
-- job quebrar silenciosamente a cada 5 minutos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'http_get'
       AND p.pronamespace = 'net'::regnamespace
  ) THEN
    RAISE EXCEPTION
      'net.http_get() nao encontrado. Confira onde o pg_net foi instalado: SELECT extnamespace::regnamespace FROM pg_extension WHERE extname = ''pg_net'';';
  END IF;
END;
$$;

-- ── Os três jobs ─────────────────────────────────────────────
--
-- Cadência de 5 minutos: a granularidade do agendamento na interface é
-- de minuto, e alguns minutos de atraso num disparo em massa não mudam
-- nada. Menos que isso só aumentaria requisições ociosas.
--
-- `timeout_milliseconds` = 20 s porque a rota de broadcasts faz várias
-- consultas antes de responder (resolve audiência, confere cota,
-- persiste destinatários) — o default de 2 s do pg_net cortaria a
-- espera e registraria falha numa execução que deu certo. Vale saber: o
-- timeout corta apenas a ESPERA pela resposta; o trabalho no servidor
-- segue até o fim, e o claim de status impede disparo duplicado.

SELECT cron.schedule(
  'zapcrm-broadcasts-cron',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_app_url')
           || '/api/broadcasts/cron',
    headers := jsonb_build_object(
      'x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_cron_secret')
    ),
    timeout_milliseconds := 20000
  );
  $job$
);

SELECT cron.schedule(
  'zapcrm-automations-cron',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_app_url')
           || '/api/automations/cron',
    headers := jsonb_build_object(
      'x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_cron_secret')
    ),
    timeout_milliseconds := 20000
  );
  $job$
);

SELECT cron.schedule(
  'zapcrm-flows-cron',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_app_url')
           || '/api/flows/cron',
    headers := jsonb_build_object(
      'x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapcrm_cron_secret')
    ),
    timeout_milliseconds := 20000
  );
  $job$
);


-- ============================================================
-- CONFERÊNCIA — rode depois, separadamente
-- ============================================================

-- 1) Os três jobs existem e estão ativos?
--
-- SELECT jobname, schedule, active FROM cron.job
--  WHERE jobname LIKE 'zapcrm-%' ORDER BY jobname;

-- 2) As últimas execuções deram certo? (espere 5 min pela primeira)
--
-- SELECT j.jobname, d.status, d.return_message, d.start_time
--   FROM cron.job_run_details d
--   JOIN cron.job j ON j.jobid = d.jobid
--  WHERE j.jobname LIKE 'zapcrm-%'
--  ORDER BY d.start_time DESC
--  LIMIT 10;
--
-- `status = 'succeeded'` aqui significa que o SQL rodou — não que o app
-- respondeu 200. A resposta HTTP de verdade está no passo 3.

-- 3) O app respondeu o quê?
--
-- SELECT status_code, content, created
--   FROM net._http_response
--  ORDER BY created DESC
--  LIMIT 10;
--
-- Esperado: 200 com um corpo como {"dispatched":0,"postponed":0,"failed":0}.
--   401 → o segredo do Vault não bate com o do servidor.
--   503 → `AUTOMATION_CRON_SECRET` não está configurado no deploy.
--   404 → a URL do Vault está errada (barra sobrando? domínio errado?).


-- ============================================================
-- DESFAZER
-- ============================================================
--
-- SELECT cron.unschedule('zapcrm-broadcasts-cron');
-- SELECT cron.unschedule('zapcrm-automations-cron');
-- SELECT cron.unschedule('zapcrm-flows-cron');
-- DELETE FROM vault.secrets WHERE name IN ('zapcrm_app_url', 'zapcrm_cron_secret');
