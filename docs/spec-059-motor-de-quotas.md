# SPEC 059 — Motor de planos e quotas

> **Status:** proposta · pronta para implementação após ratificar o [PRD 058](./prd-058-planos-e-quotas.md)
> **Data:** 2026-08-24
> **Migração:** `067_plans_and_quotas.sql` (confira `ls supabase/migrations/` antes — a última hoje é a 066)
> **Semente comercial:** `supabase/setup/plans-seed.sql` (não é migração — D-2)

---

## 1. Princípio que organiza tudo

> **O banco decide, o app explica.**

Todo limite tem um ponto de enforcement no **Postgres**, porque o ZAP CRM BR
grava contato direto do navegador: `contact-form.tsx:264` e
`import-modal.tsx:376` chamam `supabase.from('contacts').insert(...)` com a
chave anônima e a sessão do usuário. Uma guarda em rota de API seria
contornável por qualquer um com o DevTools aberto — não é hipótese, é o
caminho normal do código atual.

O TypeScript existe para três coisas, nenhuma delas sendo a última palavra:

1. **Antecipar** o bloqueio (dizer "faltam 12 vagas" antes de o usuário colar
   500 linhas no importador);
2. **Traduzir** o erro do banco em algo acionável;
3. **Esconder** o que o plano não inclui, para o usuário não descobrir por
   erro.

O padrão é o mesmo já usado em `cold-send-limit.ts` e `evolution/limits.ts`:
**módulo puro decide a partir de números já lidos; quem chama busca os números
e executa a decisão.**

---

## 2. Modelo de dados — migração `067_plans_and_quotas.sql`

Idempotente (`IF NOT EXISTS`, `DROP … CREATE` para policies/triggers) e com o
bloco de asserções finais que falha alto, no padrão das 041/052/059/061/062.

### 2.1. `platform_settings` — o interruptor (D-1)

```sql
CREATE TABLE IF NOT EXISTS platform_settings (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  quotas_enforced      BOOLEAN NOT NULL DEFAULT FALSE,
  default_plan_code    TEXT    NOT NULL DEFAULT 'unlimited',
  payment_instructions TEXT,
  billing_contact      TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;
```

Linha única garantida pelo par `PRIMARY KEY` + `CHECK (id)` — não dá para
inserir uma segunda. Mora no banco e não no `.env` porque **trigger não lê
`process.env`**, e o enforcement de contatos é uma trigger.

RLS: `SELECT` para qualquer membro autenticado (a UI precisa saber se a aba
existe e qual a instrução de pagamento); escrita só `service_role`.

### 2.2. `plans` — catálogo

```sql
CREATE TABLE IF NOT EXISTS plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  price_cents    INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  billing_period TEXT NOT NULL DEFAULT 'monthly'
                 CHECK (billing_period IN ('monthly','yearly','custom','none')),
  limits         JSONB NOT NULL DEFAULT '{}'::jsonb,
  features       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Por que `limits` é JSONB e não colunas.** Cada quota nova seria uma migração
mais um deploy — e a §5.2 do PRD lista nove candidatas. Com JSONB, quota nova
é uma chave no seed. O preço é perder o `CHECK` do banco sobre o formato; o
contrapeso é `src/lib/plans/types.ts` ser a fonte de verdade das chaves e um
teste de contrato validar o seed contra ela.

`currency` copia o formato já validado em `accounts.default_currency`
(migração 021) — mesmo regex, mesma decisão de não fixar um enum.

RLS: `SELECT` para autenticado **quando `is_active AND is_public`** (é o
catálogo que a página de planos desenha) — mais uma policy que libera o plano
atual da própria conta mesmo se ele for privado (plano "Sob medida" negociado
não aparece no catálogo, mas o dono precisa ver o próprio). Escrita só
`service_role`.

### 2.3. `account_plans` — a assinatura

```sql
CREATE TABLE IF NOT EXISTS account_plans (
  account_id         UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id            UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
  trial_ends_at      TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  limit_overrides    JSONB NOT NULL DEFAULT '{}'::jsonb,
  note               TEXT,
  updated_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`PRIMARY KEY (account_id)` = uma assinatura por conta, sem índice extra.
`ON DELETE RESTRICT` no plano impede apagar um plano que ainda tem cliente.

`limit_overrides` é a exceção por conta ("esse cliente negociou 15.000
contatos no plano Profissional") — o mesmo papel que
`accounts.evolution_instance_limit` cumpre hoje, generalizado.

`status` já existe agora, mas **só `active` e `suspended` têm comportamento no
MVP**; os demais são registro. Ver §11.

RLS: `SELECT` para membro da conta; escrita só `service_role` — o dono da
conta não pode se auto-promover.

### 2.4. `account_plan_events` — histórico append-only

```sql
CREATE TABLE IF NOT EXISTS account_plan_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_plan_code  TEXT,
  to_plan_code    TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  overrides_after JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor           TEXT NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Guarda `code` e não `plan_id`: o histórico precisa sobreviver a um plano
apagado. Mesma razão de `channel_cold_sends` gravar o julgamento e não os
dados que o produziram.

Sem policy de escrita para o cliente (padrão da 062: policy de escrita aqui
permitiria forjar histórico de cobrança).

### 2.5. `plan_change_requests` — a solicitação (D-8)

```sql
CREATE TABLE IF NOT EXISTS plan_change_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_plan_id  UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  requested_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','canceled')),
  message            TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_requests_one_pending
  ON plan_change_requests (account_id) WHERE status = 'pending';
```

O índice parcial impede a conta acumular dez solicitações abertas — mesma
técnica do `idx_channels_one_default_per_account` (055).

RLS: `SELECT` e `INSERT` para `admin+` da conta (`is_account_member(account_id,
'admin')`); `UPDATE`/`DELETE` só `service_role` — quem resolve é o operador.

### 2.6. `account_usage_counters` — uso O(1)

```sql
CREATE TABLE IF NOT EXISTS account_usage_counters (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, metric)
);
```

**Por que um contador, e não `count(*)`.** Uma conta Empresarial tem 50.000
contatos. Uma trigger que faz `SELECT count(*) FROM contacts WHERE account_id
= …` a cada linha inserida transforma uma importação de 5.000 linhas em 5.000
varreduras — a importação passa de segundos para minutos e o banco fica de
joelhos. O contador é uma linha, lida e escrita em O(1).

**Efeito colateral que é na verdade a garantia.** O `UPDATE … RETURNING value`
pega lock de linha, então dois inserts concorrentes na mesma conta serializam
naquele ponto: o segundo enxerga o valor do primeiro. Sem isso, duas abas
poderiam furar o teto em corrida. O custo — inserts de contato da **mesma
conta** serializam num ponto — é irrelevante (contas diferentes não se tocam,
e a importação já é sequencial em blocos de 50).

Métricas do MVP: `contacts` (mantida por trigger). `members_*` e `channels_*`
são contagens sobre tabelas pequenas com índice — leem direto, sem contador.

RLS: `SELECT` para membro; escrita nenhuma pelo cliente (as triggers são
`SECURITY DEFINER`).

### 2.7. `contacts.created_via` — a origem (D-5)

```sql
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'manual'
  CHECK (created_via IN ('manual','import','api','audience','inbound','legacy'));
```

Backfill: as linhas existentes viram `'legacy'` (a migração faz o `UPDATE`
antes de o `DEFAULT` valer para o histórico; documentar que `legacy` é
"anterior à 067", não uma origem real).

**Por que uma coluna, e não uma variável de sessão.** A ideia natural seria
`set_config('app.quota_bypass', 'on', true)` na ingestão. Não funciona: a
ingestão fala com o banco pelo PostgREST via `supabase-js`, que não garante
que o `set_config` e o `INSERT` caiam na mesma conexão do pool. A origem tem
que viajar **no payload**, e a coluna é isso — com o bônus de virar dado de
relatório ("quantos contatos vieram de inbound este mês?").

**Por que o `DEFAULT` é `'manual'` (bloqueante) e não `'inbound'`.** Quem
esquecer de declarar cai no caminho restrito. O único jeito de não ser
bloqueado é dizer explicitamente que é ingestão — e a trigger da §3.4 confere
que quem disse isso estava rodando com `service_role`. Um cliente com o
DevTools aberto pode mandar `created_via: 'inbound'`; a trigger reescreve para
`'manual'` antes do check.

### 2.8. Plano padrão e atribuição

A migração semeia **um** plano (D-2):

```sql
INSERT INTO plans (code, name, description, price_cents, billing_period,
                   limits, features, is_public, sort_order)
VALUES ('unlimited', 'Ilimitado',
        'Plano padrão do deployment. Sem limites — é o comportamento do ZAP CRM BR antes da 067.',
        0, 'none', '{}'::jsonb, '{}'::jsonb, FALSE, 1000)
ON CONFLICT (code) DO NOTHING;
```

e atribui **toda conta existente** a ele. Depois recria `handle_new_user()`
(cuja definição vigente está em `017_account_sharing.sql:691` — parta dela,
não da 001) acrescentando, depois do `INSERT INTO profiles`, a atribuição do
plano de `platform_settings.default_plan_code`, com `ON CONFLICT DO NOTHING` e
dentro do mesmo `EXCEPTION WHEN OTHERS` que a função já tem: **falha ao
atribuir plano não pode impedir alguém de se cadastrar.**

### 2.9. Asserções finais da migração

No bloco `DO $$` final, além das checagens de RLS no padrão do repositório:

- `plans` tem exatamente o plano `unlimited` e nenhuma conta sem
  `account_plans`;
- `platform_settings.quotas_enforced` é `FALSE` (uma migração nunca liga
  quota — D-1);
- `account_usage_counters.contacts` bate com `count(*)` de `contacts` por
  conta logo após o backfill;
- nenhuma policy de escrita pelo cliente em `account_plans`,
  `account_plan_events`, `account_usage_counters`.

---

## 3. Funções e triggers SQL

### 3.1. `account_effective_limits(account_id) → JSONB`

`plan.limits || account_plans.limit_overrides` (o `||` do JSONB já é
"direita vence"). Devolve `'{}'::jsonb` quando `quotas_enforced` é falso — um
objeto vazio significa "toda chave ausente", e chave ausente é ilimitada
(D-3). O interruptor fica implementado num lugar só.

### 3.2. `plan_limit(account_id, key) → INTEGER` — `STABLE SECURITY DEFINER`

```sql
SELECT NULLIF(account_effective_limits(p_account_id) ->> p_key, '')::INTEGER;
```

`NULL` = ilimitado. `STABLE` para o planejador reaproveitar o resultado dentro
do mesmo comando (importante: numa inserção de 50 linhas, é uma avaliação, não
50). `SECURITY DEFINER` porque a trigger roda sob o papel do chamador, que não
enxerga `plans` privado.

Sem linha em `account_plans` → `NULL` → ilimitado. **Falha aberta, de
propósito**: uma conta órfã por bug de migração não pode ficar impedida de
cadastrar contato. Quota não é controle de segurança (isso é a RLS); é
política comercial.

### 3.3. `plan_feature(account_id, key) → BOOLEAN`

`COALESCE((features || overrides) ->> key, 'true')::boolean` — ausente é
`TRUE`, mesma lógica permissiva de D-3, e `TRUE` também quando o interruptor
está desligado.

### 3.4. `enforce_contact_quota()` — `AFTER INSERT … FOR EACH ROW ON contacts`

```
1. NEW.created_via = 'inbound' e o chamador não é service_role
      → tratar como 'manual'  (BEFORE INSERT, ver nota)
2. INSERT INTO account_usage_counters (…, 'contacts', 1)
     ON CONFLICT (account_id, metric)
     DO UPDATE SET value = account_usage_counters.value + 1,
                   updated_at = NOW()
     RETURNING value INTO v_used;
3. v_limit := plan_limit(NEW.account_id, 'contacts');
4. SE v_limit IS NOT NULL
      E v_used > v_limit
      E NEW.created_via <> 'inbound'
   ENTÃO
      RAISE EXCEPTION 'QUOTA_EXCEEDED:contacts:%:%', v_used, v_limit
        USING ERRCODE = 'P0001';
```

São **duas** triggers: uma `BEFORE INSERT` que normaliza `created_via` (passo
1, precisa reescrever `NEW`) e uma `AFTER INSERT` que conta e decide. Separar
é o que torna o passo 1 inviolável.

Detalhes que a implementação não pode errar:

- **A exceção aborta a transação, então o incremento do passo 2 é desfeito
  junto** — o contador não fica inflado por tentativas recusadas. É por isso
  que a ordem é incrementar-depois-checar, e não o contrário: o incremento é
  o que dá o lock que serializa a corrida.
- **Inbound conta mas não bloqueia** (D-5): o passo 2 acontece sempre, o passo
  4 sai pela condição `created_via <> 'inbound'`. É assim que a conta entra em
  overage visível sem perder mensagem.
- **`ERRCODE = 'P0001'`** (`raise_exception`) porque é o que o PostgREST
  devolve como HTTP 400 com a mensagem preservada — códigos de classe
  desconhecida viram 500 opaco. **Confirmar empiricamente no F4** e ajustar
  se o comportamento do PostgREST desta versão divergir.
- O formato `QUOTA_EXCEEDED:<metric>:<used>:<limit>` é contrato entre banco e
  `src/lib/plans/errors.ts`. Mudou de um lado, muda dos dois.

Complemento: `AFTER DELETE` decrementa (com `GREATEST(value - 1, 0)`), e
`recount_account_usage(account_id)` recalcula do zero — chamada pelo backfill,
pela rota de operador e, opcionalmente, por uma linha nova em
`supabase/setup/cron-jobs.sql` (madrugada).

### 3.5. Quota de membros dentro dos RPCs existentes

Não há trigger nova aqui — os dois caminhos que criam membro já são funções
`SECURITY DEFINER` e é dentro delas que a checagem entra:

- **`redeem_invitation(token_hash)`** (`019_invitation_rpcs.sql:125`): depois
  das validações de convite e antes do `UPDATE profiles`, checar
  `members_total` e `members_<papel do convite>` contra
  `plan_limit(v_inv.account_id, …)`. Excedeu → `RAISE EXCEPTION` com o mesmo
  formato `QUOTA_EXCEEDED:members_admin:3:2` e `ERRCODE = '22023'` (é o código
  que as outras recusas deste RPC já usam).
- **`set_member_role(…)`** (`018_account_member_rpcs.sql:37`): promover para
  um papel cujo teto está cheio falha. Rebaixar nunca falha.

`owner` conta em `members_total` e em `members_admin` (D-6), e nunca é
bloqueado — o dono já existe antes de qualquer plano.

---

## 4. Inventário de pontos de enforcement

Levantado no código atual. **É esta tabela que define "pronto"** — uma entrada
esquecida é um furo silencioso na quota.

| # | Caminho | Arquivo | Tratamento |
| --- | --- | --- | --- |
| 1 | Formulário de contato | `src/components/contacts/contact-form.tsx:264` | Trigger bloqueia; UI antecipa (botão desabilitado + motivo) |
| 2 | Importação CSV/XLSX/Sheets | `src/components/contacts/import-modal.tsx:376,387` | Trigger bloqueia; **pré-checagem obrigatória** (§7.2) |
| 3 | API pública | `src/lib/api/v1/contacts.ts:128` | Trigger bloqueia; mapear para HTTP 403 `quota_exceeded` (§8) |
| 4 | Audiência de disparo | `src/lib/audience/resolve.ts:242,375` | Trigger bloqueia; virar `BroadcastError` legível na triagem |
| 5 | Webhook de entrada (SPEC 055) | `src/app/api/v1/ingest/contact/route.ts` + `src/lib/ingest/` | **Bloqueia** — é integração que o operador controla; resposta 403 `quota_exceeded` |
| 6 | Ingestão inbound (canais) | `src/lib/channels/ingest.ts:626` | `created_via: 'inbound'` — **nunca bloqueia** (D-5) |
| 7 | Ingestão inbound (Cloud) | `src/lib/whatsapp/resolve-conversation.ts:145` | idem |
| 8 | Criar convite | `POST /api/account/invitations` | Pré-checagem na rota, contando convites **pendentes** como vaga ocupada (§4.1) |
| 9 | Aceitar convite | RPC `redeem_invitation` | Checagem final (§3.5) |
| 10 | Mudar papel | RPC `set_member_role` | Checagem no papel de destino |
| 11 | Criar instância QRCode | `POST /api/channels/evolution/instances` | `checkInstanceLimit` passa a receber o limite do plano (§4.2) |
| 12 | Conectar WhatsApp oficial | `POST /api/whatsapp/config` | Recusa quando `channels_whatsapp_cloud = 0` |
| 13 | Recursos por plano | rotas `/api/ai/**`, `/api/flows/**`, `/api/broadcasts/**`, `/api/v1/**`, webhooks de saída | `plan_feature` na rota + item some da navegação |

### 4.1. Convites pendentes ocupam vaga

Sem isso, um plano de 5 usuários emite 20 convites e recebe 20 pessoas — cada
`redeem` individual passaria pela checagem antes de o anterior ser contado, ou
pior, todos falhariam no aceite depois de a pessoa já ter clicado. Contar
`account_invitations` com `accepted_at IS NULL AND expires_at > NOW()` junto
com os membros ativos resolve na origem, e é o índice
`idx_account_invitations_account_pending` (017) que torna isso barato.

### 4.2. `evolution/limits.ts` muda de fonte, não de forma

`checkInstanceLimit` já tem exatamente a assinatura certa:

```ts
accountOverride: number | null;   // hoje: accounts.evolution_instance_limit
defaultPerAccount: number;        // hoje: EVOLUTION_MAX_INSTANCES_PER_ACCOUNT
maxTotal: number;                 // EVOLUTION_MAX_INSTANCES_TOTAL — permanece
```

A mudança é de quem preenche `accountOverride`: passa a ser
`plan_limit(account_id, 'channels_whatsapp_qr')`, com o `.env` continuando
como padrão quando o plano não define a chave. **`maxTotal` não muda e
continua sendo checado primeiro** (PRD §6) — a mensagem de recusa por teto de
deployment já é distinta da de conta (`describeLimitDenial`), e isso precisa
continuar visível na UI, senão o cliente vê "limite do plano" quando o
problema é a VPS lotada.

A migração backfilla `accounts.evolution_instance_limit` para
`account_plans.limit_overrides->>'channels_whatsapp_qr'`. A coluna permanece
(não quebrar quem já a usa), marcada como obsoleta em `COMMENT ON COLUMN`, e
**deixa de ser lida pelo app** ao fim do F6.

---

## 5. Núcleo TypeScript — `src/lib/plans/`

Puro, sem I/O, com teste co-locado, no padrão do resto de `src/lib/`.

| Arquivo | Responsabilidade |
| --- | --- |
| `types.ts` | `QuotaKey`, `FeatureKey` (uniões literais — **fonte de verdade das chaves**), `PlanLimits`, `PlanFeatures`, `Plan`, `AccountPlan`, `PlanUsage` |
| `limits.ts` | `resolveLimit(limits, overrides, key)`, `isUnlimited(v)`, `isBlocked(v)` (`0`), `mergeLimits` |
| `usage.ts` | `remaining`, `ratio`, `bucketStatus` → `'ok' \| 'warn' \| 'full' \| 'over'` (limiar de aviso em 80%), `overageAmount` |
| `gate.ts` | `checkQuota({ limit, used, requested })` → `{ allowed, reason, limit, used, remaining }`. Espelha a forma de `checkInstanceLimit` — é o mesmo tipo de decisão |
| `errors.ts` | `parseQuotaError(err)` ⇄ `formatQuotaError(...)`. Reconhece `QUOTA_EXCEEDED:<metric>:<used>:<limit>` vindo de `PostgrestError.message` |
| `format.ts` | Preço via `Intl.NumberFormat` na moeda do plano (o app já formata moeda — reaproveitar o helper de `Currencies`); limite `null` → "Ilimitado", `0` → "Não incluído" |
| `catalog.ts` | Validação do seed contra `types.ts` (chave desconhecida em `limits` é erro) — o teste de contrato que compensa o JSONB sem `CHECK` |
| `account-plan.ts` | **Server-only.** `getAccountPlan()` — plano + limites efetivos + uso, uma chamada; usa `@/lib/supabase/server` |

E `src/hooks/use-account-plan.ts` no cliente, consumindo `GET /api/account/plan`.

### 5.1. Testes obrigatórios

`limits.test.ts` (precedência override > plano > ausente; `0` ≠ ausente),
`usage.test.ts` (limiares, overage, divisão por ilimitado não estoura),
`gate.test.ts` (borda exata: `used === limit` bloqueia, `used === limit - 1`
passa; `requested > 1` para a pré-checagem em lote),
`errors.test.ts` (parse do formato, incluindo mensagem que **não** é de quota),
`catalog.test.ts` (o seed do repositório é válido),
`format.test.ts` (pt-BR e en, ilimitado, não incluído).

---

## 6. Rotas de API

| Rota | Método | Quem | O quê |
| --- | --- | --- | --- |
| `/api/account/plan` | GET | membro | plano atual, limites efetivos, uso, catálogo público, solicitação pendente |
| `/api/account/plan/request` | POST | `admin+` | grava `plan_change_requests`; dispara webhook opcional |
| `/api/account/plan/request` | DELETE | `admin+` | cancela a própria solicitação pendente |
| `/api/admin/plans` | GET/POST | operador | catálogo (criar/editar plano) |
| `/api/admin/accounts/[accountId]/plan` | GET/PUT | operador | ler/trocar plano, status e overrides; grava `account_plan_events` |
| `/api/admin/plan-requests` | GET/PATCH | operador | listar e resolver solicitações |

**Guarda do operador** (`src/lib/auth/platform-admin.ts`), copiando o formato
das rotas de cron: header `x-admin-secret` comparado a `PLATFORM_ADMIN_SECRET`
com comparação de tempo constante; **sem a variável no servidor, `503`** — o
mesmo "falha alto em vez de abrir" que `AUTOMATION_CRON_SECRET` já pratica.

**Webhook opcional de solicitação:** `PLAN_REQUEST_WEBHOOK_URL`, entregue pelo
caminho de webhooks de saída que já existe em `src/lib/webhooks/` — **inclusive
a guarda de SSRF**, que não pode ser contornada só porque a URL vem do `.env`.

---

## 7. Interface

### 7.1. Aba "Plano e uso"

- `src/components/settings/settings-sections.ts`: nova seção `'plan'` no grupo
  `account`, ícone `Gauge` (ou `CreditCard`), **rótulo já pelo dicionário** —
  e o item só entra na lista quando `quotas_enforced` é verdadeiro.
- `src/components/settings/plan-panel.tsx` — orquestra;
  `plan-usage-bars.tsx` — as barras (`bucketStatus` decide a cor);
  `plan-catalog.tsx` — cartões do catálogo + botão de escolha (D-8);
  `plan-request-state.tsx` — estado "em análise".

Deep-link `?tab=plan` funciona automaticamente (o roteamento por query já
existe).

### 7.2. Pré-checagem na importação — não é opcional

`import-modal.tsx` hoje trata erro de linha como "pulado" (`23505` = duplicado).
Se a quota estourar no meio de um bloco de 50, o modal reporta "48 pulados" e
o usuário não faz ideia do porquê. Obrigatório:

1. Antes de inserir, ler o uso e o limite; se `linhas > vagas`, mostrar o
   número exato de vagas e deixar o usuário escolher entre importar as
   primeiras N ou cancelar;
2. Se ainda assim uma linha voltar com `QUOTA_EXCEEDED`, **parar o laço**
   (continuar só produz 4.000 falhas idênticas) e apresentar quantas entraram
   e por que parou.

### 7.3. Recursos desligados pelo plano

`ai_enabled: false` esconde a aba de IA em Configurações e a ação de rascunho
no inbox — não mostra botão que devolve 403. A rota continua guardando por
`plan_feature` (a UI não é a defesa), mas o usuário não descobre o limite
tropeçando nele.

### 7.4. i18n

Chaves novas em `messages/en.json` (fonte) e `messages/pt-BR.json` (espelho),
sob `Settings.plan.*` (painel, barras, catálogo, solicitação) e `Plans.*`
(nomes/rótulos de quota reutilizados nos erros). Mensagens de `/api/**`
permanecem **em inglês**; quem traduz é a UI, pela chave da métrica.

`npm run i18n:check` faz parte do gate de conclusão.

---

## 8. Impacto na API pública `/api/v1`

Duas mudanças de contrato — e a regra do `AGENTS.md` vale integralmente: as
**três** edições saem juntas (`docs/public-api.md`, `public/openapi.json`,
`public/openapi.pt-BR.json`), com `npx @redocly/cli lint` nos dois JSON e
conferência de paridade estrutural.

1. **Erro novo:** `POST /api/v1/contacts` e `POST /api/v1/ingest/contact`
   passam a poder responder **403** com código `quota_exceeded` e corpo
   descrevendo métrica, uso e limite. Acrescentar o código à união de
   `src/lib/api/v1/respond.ts`.
2. **`GET /api/v1/me`** ganha um bloco `plan` (código, nome, status) e `usage`.
   Útil para integrações checarem antes de despejar 10.000 contatos.

---

## 9. Fases

Cada fase é implementável, testável e commitável isolada. Nenhuma delas muda
comportamento enquanto o interruptor estiver desligado.

| Fase | Entrega | Pronto quando |
| --- | --- | --- |
| **F1** | Migração 067: tabelas, funções, triggers, contadores, backfill, plano `unlimited`, `handle_new_user` | Suíte verde; asserções da migração passam; app se comporta exatamente como antes |
| **F2** | `src/lib/plans/**` + testes (§5) | `npm run test` verde com os seis arquivos de teste |
| **F3** | `getAccountPlan()`, `GET /api/account/plan`, `useAccountPlan()` | Rota devolve plano/uso corretos com o interruptor nos dois estados |
| **F4** | Quota de **contatos**: `created_via` nos 7 caminhos, mapeamento de erro, pré-checagem da importação | Critérios 2 e 6 do PRD §10 |
| **F5** | Quota de **membros**: rota de convite + `redeem_invitation` + `set_member_role` | Critério 3 |
| **F6** | Quota de **canais**: fonte do limite em `limits.ts`, `whatsapp/config`, mensagens distintas plano × deployment | Critérios 4 e 5 |
| **F7** | UI "Plano e uso" + solicitação + i18n | Critério 7; `i18n:check` verde |
| **F8** | Operação: `/api/admin/**`, `plans-seed.sql`, webhook opcional, docs, API pública (§8) | Critério 8; `redocly lint` verde nos dois JSON |
| **F9** | Teste manual ponta a ponta com o interruptor **ligado** num projeto de teste, roteiro em `docs/spec-059-teste-manual.md` | Os 8 critérios do PRD §10 verificados contra banco real |

**Migrações:** F1 aplica a 067 — e, pela regra do `AGENTS.md`, **só depois de
confirmar com o mantenedor**, projeto por projeto (`vn`, `rs`, `jh`).

---

## 10. Armadilhas específicas desta SPEC

| Sintoma | Causa |
| --- | --- |
| Importação diz "N pulados" sem explicar | Falta a §7.2 — erro de quota se disfarçando de duplicado |
| Mensagem de cliente some quando a conta enche | `created_via` não foi setado em `ingest.ts` / `resolve-conversation.ts` (D-5) |
| Erro de quota chega ao usuário como 500 opaco | `ERRCODE` que o PostgREST não mapeia para 4xx — ver §3.4 |
| Contador diverge do `count(*)` | Caminho que apaga contato sem passar pela trigger (`TRUNCATE`, `DELETE` administrativo) — rodar `recount_account_usage` |
| Fork de terceiro reclama de limite após `git pull` | `quotas_enforced` ligado indevidamente, ou catálogo comercial dentro da migração (viola D-2) |
| Conta nova nasce sem plano | `handle_new_user` recriada a partir da versão da 001 em vez da 017 |
| "Limite do plano" quando o problema é a VPS | `maxTotal` e limite de conta compartilhando a mesma mensagem — §4.2 |
| Tela quebrada só em pt-BR | Chave nova em um dicionário só — `npm run i18n:check` |

---

## 11. Deixado para depois (schema já preparado)

- **Suspensão por inadimplência** — `status = 'suspended'` bloqueando envio e
  criação, mantendo leitura e exportação. É a única alavanca real enquanto a
  cobrança for externa; vale como F10 assim que o PRD ratificar o
  comportamento exato.
- **Trial** — `trial_ends_at` + rebaixamento automático para o plano gratuito
  (mais uma rota de cron no formato das três já existentes).
- **Medição de mensagens/mês** — medir antes de limitar; a chave já está
  prevista em `types.ts`.
- **Painel de super-admin** com login (substitui o `x-admin-secret` de D-9).
- **Gateway de pagamento** — só depois de tudo acima estar em uso.

---

## 12. Validação antes de entregar cada fase

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```
