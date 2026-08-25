# SPEC 055 — Webhook de entrada: ingestão de contatos, disparo e funil por `webhook_id`

| Campo               | Valor                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status              | **Proposta — aguardando ratificação das decisões D-1 … D-15**                                                                                                    |
| Escopo              | Endpoint de webhook de **entrada** (terceiro faz `POST` para o CRM), log de erros em Settings e funil de disparo por `webhook_id`                                 |
| Migração            | **065** (próxima livre — `064_contact_exports.sql` é a última em `supabase/migrations/`)                                                                          |
| Dependências novas  | **nenhuma** (todo o trabalho reusa módulos já existentes)                                                                                                        |
| Precedente externo  | [`n8n_automation/`](../n8n_automation/README.md) — o mesmo contrato já roda **fora** do app, em n8n, escrevendo direto no Supabase                                |
| SPECs relacionadas  | [050](./spec-050-padronizacao-telefone-br.md) (telefone), [051](./spec-051-exportacao-de-contatos.md) (padrão de rota+lib), [049](./spec-049-inbox-multicanal-e-motores.md) (canais) |
| Documentação pública| `docs/public-api.md` + `public/openapi.json` — **fora do escopo desta SPEC**, ver §13                                                                             |
| Data                | 2026-08-18                                                                                                                                                       |

---

## 1. O problema, em uma frase

Um sistema externo (n8n, formulário, e-commerce, discador) que queira **criar um contato completo
no CRM e já disparar um template para ele** hoje não tem por onde: a API pública cria contato com
`name`/`email`/`company`/`tags` e nada mais — **notas e campos personalizados não têm endpoint
nenhum** — e o disparo, quando acontece, some num `broadcasts` avulso que não se conecta à origem
que o gerou.

O contorno que existe hoje é **externo ao app**: o workflow n8n `Contact Ingestion`
([`n8n_automation/README.md`](../n8n_automation/README.md)) escreve direto nas tabelas
`contacts` / `tags` / `contact_tags` / `custom_fields` / `contact_custom_values` /
`contact_notes` via PostgREST com a `service_role`. Funciona, mas o preço é conhecido e está
escrito no próprio README daquela pasta: a regra de negócio vive fora do repositório, a chave
`service_role` circula numa credencial de n8n, e nenhuma das validações do app (SPEC 050,
dedupe, RLS) é reaproveitada — o n8n reimplementou cada uma.

Esta SPEC traz esse contrato **para dentro do app**.

### 1.1 O que NÃO é o problema

- **Webhooks de saída já existem e não são isto.** `/api/v1/webhooks` (+ `webhook_endpoints`,
  migração 028, e `src/lib/webhooks/deliver.ts`) é o CRM **notificando** terceiros sobre eventos.
  Esta SPEC é o inverso: terceiro notificando o CRM. Não há sobreposição de código útil (§4 D-11).
- **Envio de template já funciona.** `broadcast-core.ts` / `send-message.ts` / `channels/send.ts`
  cobrem o envio. Esta SPEC não reimplementa envio.
- **Contadores de funil já são automáticos.** As colunas
  `sent_count`/`delivered_count`/`read_count`/`replied_count`/`failed_count` de `broadcasts` são
  mantidas por trigger no banco (§2, achado D). Esta SPEC **não escreve contador nenhum**.

---

## 2. Estado atual (verificado no código em 2026-08-18)

### 2.1 O que a API pública já sabe fazer

| Capacidade                       | Onde está                                                                        | Serve para esta SPEC?                                    |
| -------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Autenticação por chave + escopos | [`src/lib/auth/api-context.ts`](../src/lib/auth/api-context.ts) `requireApiKey`  | ✅ reusar inteiro                                        |
| Envelope de resposta             | [`src/lib/api/v1/respond.ts`](../src/lib/api/v1/respond.ts)                      | ✅ reusar inteiro                                        |
| Rate limit por chave             | `RATE_LIMITS.publicApi` em [`src/lib/rate-limit.ts:152`](../src/lib/rate-limit.ts) | ✅ já aplicado dentro de `requireApiKey`                 |
| Criar contato (dedupe por fone)  | `findOrCreateContact` em [`src/lib/api/v1/contacts.ts`](../src/lib/api/v1/contacts.ts) | ✅ reusar — mas **ver achado A**                    |
| Vincular tags (criando as novas) | `setContactTags` → `resolveImportTagIds`                                         | ⚠️ reusar com ressalva — **ver achado B**                |
| Atribuição de autoria            | `resolveAuditUserId` (mesmo arquivo)                                            | ✅ reusar inteiro                                        |
| **Notas de contato**             | **não existe em `src/lib/`** — ver achado C                                      | ❌ precisa ser extraído                                  |
| **Campos personalizados**        | **não existe em `src/lib/`** — ver achado C                                      | ❌ precisa ser extraído                                  |
| **Checagem de template aprovado**| **não existe no servidor** — ver achado E                                        | ❌ precisa de helper novo                                |

### Achado A — a API pública **não** usa a validação da SPEC 050

`findOrCreateContact` valida com `sanitizePhoneForMeta` + `isValidE164`
([`contacts.ts`](../src/lib/api/v1/contacts.ts), bloco de validação de `input.phone`), **não** com
`normalizeContactPhone`. Isso é intencional e está ratificado: a SPEC 050 §4 **D-5** decidiu
manter a validação de DDD **desligada** em `/api/v1`, com a razão explícita de *"ligá-la quebraria
integrações existentes que hoje criam contato com qualquer número E.164 válido"*.

> **Consequência direta para esta SPEC:** o pedido é que o novo endpoint valide pela SPEC 050. Como
> o endpoint é **novo**, ele não tem integração existente para quebrar — a razão que sustenta o D-5
> não se aplica a ele. Isso é tratado no **D-3**, que acrescenta uma linha nova à tabela de
> estritude da SPEC 050 em vez de contradizê-la.

### Achado B — `setContactTags` **substitui**, não acrescenta

`setContactTags` faz um *diff* contra o conjunto atual e **remove** as tags que não vieram na
chamada (o comentário no código é explícito: *"pass `[]` to clear all tags"*). Para um webhook de
ingestão isso é destrutivo: um POST vindo de um formulário de landing page apagaria a tag
`cliente_vip` que outro canal colocou. O helper certo para o comportamento aditivo é o par
`resolveImportTagIds` + `assignImportedContactTags` de
[`src/lib/contacts/resolve-import-tags.ts`](../src/lib/contacts/resolve-import-tags.ts) — o segundo
faz `upsert` com `ignoreDuplicates`, que só acrescenta. Ver **D-6**.

> Isto responde diretamente à pergunta do pedido *"confirme se é exatamente o mesmo helper"*:
> **não é.** `POST /api/v1/contacts` usa `setContactTags` (substitutivo); esta SPEC usa a camada de
> baixo do mesmo módulo (aditiva). É o mesmo módulo, função diferente, semântica oposta.

### Achado C — notas e campos personalizados só existem **dentro de componente**

Toda a escrita vive em client component, com o cliente Supabase do browser:

- Notas: `addNote()` em
  [`src/components/contacts/contact-detail-view.tsx`](../src/components/contacts/contact-detail-view.tsx)
  (insert em `contact_notes` com `contact_id`, `account_id`, `user_id`, `note_text`); há uma
  segunda cópia da mesma escrita em
  [`src/components/inbox/contact-sidebar.tsx`](../src/components/inbox/contact-sidebar.tsx).
- Campos personalizados: `saveCustomFields()` no mesmo `contact-detail-view.tsx` — e a estratégia
  dele é **`DELETE` de todos os valores do contato seguido de re-`INSERT`**, o que é aceitável num
  formulário que carregou o estado inteiro e é **inaceitável** num webhook que conhece só 1 campo
  (apagaria os outros 9).

Não há nada em `src/lib/` para reusar. A regra do `AGENTS.md` — *"lógica de negócio vive em
`src/lib/`, não em componentes"* — é exatamente o que falta aqui. Ver **F3**.

### Achado D — o funil sai de graça se o disparo for uma linha de `broadcasts`

Três mecanismos já existentes fazem os seis contadores do funil andarem sozinhos, **desde que**
exista uma linha em `broadcast_recipients`:

1. **Trigger agregador incremental** — `broadcast_recipient_aggregate_trigger`
   ([`003_broadcast_recipient_wamid.sql`](../supabase/migrations/003_broadcast_recipient_wamid.sql),
   reescrito por [`005_broadcast_counts_incremental.sql`](../supabase/migrations/005_broadcast_counts_incremental.sql)):
   qualquer INSERT/UPDATE/DELETE em `broadcast_recipients` recalcula
   `sent/delivered/read/replied/failed_count` no pai. `deliverBroadcast` documenta que **nunca**
   escreve essas colunas justamente por isso.
2. **Espelhamento de status da Meta** — o webhook de entrada da Meta
   ([`src/app/api/whatsapp/webhook/route.ts:435`](../src/app/api/whatsapp/webhook/route.ts))
   casa `broadcast_recipients.whatsapp_message_id` com o `wamid` do status e sobe
   `delivered`/`read`.
3. **Resposta do contato** — `flagBroadcastReplyIfAny` em
   [`src/lib/channels/ingest.ts:822`](../src/lib/channels/ingest.ts) vira a linha mais recente do
   contato para `replied` quando ele responde.

> Nenhum dos três sabe (nem precisa saber) de onde veio a linha. **Uma linha em
> `broadcast_recipients` já é um funil completo.** É o argumento decisivo do **D-4**.

### Achado E — não existe guarda server-side de "template aprovado"

A checagem `status = 'APPROVED'` existe em **três lugares, todos client-side**, e todos são
filtros de *listagem*, não guardas de envio:

- [`src/components/broadcasts/step1-choose-template.tsx:87`](../src/components/broadcasts/step1-choose-template.tsx)
- [`src/components/inbox/template-picker.tsx:115`](../src/components/inbox/template-picker.tsx)
- [`src/components/automations/automation-builder.tsx:410`](../src/components/automations/automation-builder.tsx)

No servidor: `createBroadcast` ([`broadcast-core.ts`](../src/lib/whatsapp/broadcast-core.ts)) busca
o template por `name` + `language` e só valida a **forma** da linha (`isMessageTemplate`);
`send-message.ts` idem. **Nenhum dos dois olha `status`.** O único módulo de status é
[`template-status-normalize.ts`](../src/lib/whatsapp/template-status-normalize.ts), que traduz o
enum da Meta e não decide nada.

> Ou seja: o pedido dizia *"deve haver algo em `src/lib/whatsapp/template-*.ts` — reaproveite, não
> reimplemente"*. **Não há.** O que dá para reusar é o enum (`MessageTemplateStatus`) e o
> normalizador; a guarda em si é código novo — pequeno, puro e testável (ver **D-8** e **F5**).

### 2.2 O que o modelo de dados já tem

| Tabela                   | Colunas relevantes                                                                                                | Observação                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `broadcasts`             | `total_recipients`, `sent_count`, `delivered_count`, `read_count`, `replied_count`, `failed_count`, `status`, `account_id` | `status` tem `CHECK (status IN ('draft','scheduled','sending','sent','failed'))` — 001, nunca alterado |
| `broadcast_recipients`   | `status`, `whatsapp_message_id`, `error_message`, `contact_id` (nullable desde 004)                               | **sem** unique em `(broadcast_id, contact_id)` — repetição é permitida                              |
| `custom_fields`          | `field_name`, `field_type`, `account_id`                                                                          | **sem índice único** por `(account_id, field_name)` — só `idx_custom_fields_account` (017)          |
| `tags`                   | `name`, `account_id`                                                                                              | **tem** unique *case-insensitive*: `idx_tags_account_name_ci` (038)                                  |
| `contact_notes`          | `contact_id`, `account_id`, `user_id` (NOT NULL), `note_text`                                                     | sem dedupe — cada linha é um evento de histórico                                                     |
| `contact_custom_values`  | `contact_id`, `custom_field_id`, `value`, `UNIQUE(contact_id, custom_field_id)`                                   | **não tem `account_id`** — a tenancy vem por `contacts` na RLS (017)                                |
| `message_templates`      | `id` (uuid PK), `meta_template_id` (text, 014), `name`, `language`, `status`, `account_id`                        | dois "ids" diferentes — ver **D-8**                                                                  |
| `webhook_endpoints`      | `failure_count`, `last_delivery_at`                                                                               | log de **saída**, agregado por endpoint, sem payload nem motivo — inútil aqui (**D-11**)             |

### 2.3 A UI que já existe

- **Funil:** [`funnel-chart.tsx`](../src/components/broadcasts/funnel-chart.tsx) e
  [`stat-card.tsx`](../src/components/broadcasts/stat-card.tsx) já são componentes extraídos e
  reusáveis — a tela `/broadcasts/[id]` monta 6 `StatCard` + 1 `FunnelChart` a partir das colunas
  de contagem e de `total_recipients`.
- **Settings:** as abas são um enum literal em
  [`settings-sections.ts`](../src/components/settings/settings-sections.ts)
  (`SETTINGS_SECTIONS`, `SECTION_META`, `RAIL_GROUPS`) + o mapa `panel` em
  [`settings/page.tsx`](<../src/app/(dashboard)/settings/page.tsx>). Adicionar uma aba é: 1 entrada
  no array, 1 em `SECTION_META`, 1 no `panel`, 1 chave em cada dicionário i18n. O painel de
  referência para "tabela/lista paginada" é
  [`api-keys-settings.tsx`](../src/components/settings/api-keys-settings.tsx) (507 linhas, carrega
  por `fetch` numa rota interna, `RequireRole min="admin"` para ações).

---

## 3. Objetivo

1. **Um endpoint de entrada** que recebe um contato, valida, grava tudo o que o cadastro manual
   grava (incluindo notas e campos personalizados, que hoje a API não tem) e opcionalmente dispara
   um template.
2. **Rastreabilidade por origem:** todo disparo feito por este caminho aparece no dashboard agrupado
   por `webhook_id`, com `webhook_name` como nome, e os seis contadores do funil.
3. **Falha visível:** toda rejeição de validação vira uma linha consultável numa aba de Settings —
   nunca um 400 que só existe no log do n8n de quem chamou.
4. **Zero reimplementação:** telefone (SPEC 050), dedupe, tags, envio, canais e contadores vêm de
   módulos que já existem e já têm teste.

### 3.1 Fora de escopo

- Atualizar `docs/public-api.md` e `public/openapi.json` (trabalho de acompanhamento — §13).
- Aposentar o workflow n8n `Contact Ingestion`. Ele continua funcionando; a migração de quem usa é
  decisão de operação, não desta SPEC.
- Retrofit da guarda de template aprovado nos três caminhos existentes (wizard, inbox, automações).
  O helper novo nasce isolado; unificar é follow-up (§13).
- Fila durável / retry de envio. Vale aqui a mesma limitação já documentada em
  `POST /api/v1/broadcasts` (`maxDuration = 60`, fan-out em `after()`).
- Envio de conteúdo livre (texto, mídia). Este endpoint envia **template**, e só.
- Endpoint público de leitura de notas/campos personalizados (`GET`). Esta SPEC só escreve.

---

## 4. Decisões

> Nenhuma decisão abaixo está ratificada. As marcadas com 💡 são as que o pedido original deixou
> explicitamente em aberto ("decida e documente").

### D-1 💡 — O endpoint é uma **extensão de `/api/v1`**, não uma rota separada

**Proposta:** `POST /api/v1/ingest/contact`.

O que se ganha é grande e já está pronto: `requireApiKey` (401/403/429 padronizados, revogação,
expiração, `last_used_at`), o envelope `{data}` / `{error:{code,message}}`, o rate limit por chave
com headers `X-RateLimit-*`, e o cliente `service_role` já escopado por `accountId`. Uma rota fora
do `/api/v1` teria que reconstruir cada um desses — e cada reconstrução é um lugar novo onde a
tenancy pode vazar.

**Por que `ingest/` e não `webhooks/`:** `/api/v1/webhooks` já significa "endpoints de **saída**"
(gerenciamento de `webhook_endpoints`). Pendurar entrada no mesmo prefixo criaria a ambiguidade
mais cara possível num CRM: duas coisas opostas com o mesmo nome. `ingest/` é livre e deixa espaço
para irmãos futuros (`ingest/deal`, `ingest/event`) sem renomear nada.

**Trade-off aceito:** o caller precisa mandar `Authorization: Bearer wacrm_live_…`, o que é um passo
a mais para quem só quer colar uma URL num n8n. É o preço de não ter autenticação por URL secreta
(ver D-2).

### D-2 💡 — Autenticação: **chave de API existente + escopo novo `ingest:write`**

**Proposta:** reusar `api_keys` e acrescentar `'ingest:write'` a `API_SCOPES`
([`src/lib/api-keys/scopes.ts`](../src/lib/api-keys/scopes.ts)) — uma linha no array, uma em
`SCOPE_DESCRIPTIONS`, **sem migração** (o comentário do próprio arquivo registra que a coluna é um
`text[]` livre).

| Opção                                     | A favor                                                                                                                     | Contra                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Chave de API + escopo** *(proposta)*    | Revogação, expiração, rate limit, auditoria (`last_used_at`), criação restrita a admin+ e revelação única — tudo já existe   | Exige header; uma chave por integração para poder revogar isolado                                                          |
| Segredo por webhook (espelho do de saída) | URL colável, sem header                                                                                                     | Tabela nova, criptografia nova, rotação nova, tela nova — e segredo na URL vaza em log de proxy e histórico de navegador  |

**O `webhook_id` NÃO é credencial.** Ele vem no corpo, é exibido no dashboard e no log, e a única
regra que o pedido dá é de forma (dígitos, ≥16). Tratá-lo como autenticação seria autenticação
caseira disfarçada de identificador. Ele identifica o **funil**; a chave identifica a **conta**.

**Consequência que precisa estar escrita:** um `401` (chave ausente/inválida) **não gera linha de
log**, porque sem chave não há `account_id` a que a linha pertença — e uma tabela de log
sem tenancy é um vazamento entre contas. Quem chama vê o 401 na resposta HTTP; o dashboard não vê
nada. Isso é intencional e vai na doc da aba (§8.1).

### D-3 💡 — Validação de telefone: **estrita** (SPEC 050), por ser endpoint novo

**Proposta:** usar `normalizeContactPhone` de [`src/lib/phone/br.ts`](../src/lib/phone/br.ts). Se
`ok: false`, **nada é criado** — nem contato, nem nota, nem tag, nem disparo — e a rejeição vira
linha de log com o `reason` (`invalid_ddd`, `mobile_invalid_ninth_digit`, `invalid_length`, …).

Isto **acrescenta uma linha** à tabela de estritude da SPEC 050 §4 D-5, sem contradizê-la:

| Caminho                          | Normaliza | Valida DDD/tipo    | Se inválido            |
| -------------------------------- | --------- | ------------------ | ---------------------- |
| API pública `/api/v1` (existente)| ✅        | ❌ desligada       | —                      |
| **`/api/v1/ingest/*` (novo)**    | ✅        | ✅ **ligada**      | **rejeita + registra** |

A razão do D-5 para manter desligado é preservar integrações existentes. Um endpoint que ainda não
existe não tem integração para preservar — então o custo é zero e o benefício (não deixar entrar
DDD inexistente numa base que será usada para disparo pago) é real. Ratificar isto significa aceitar
que **dois endpoints da mesma API têm estritude diferente**, o que precisa ficar registrado em
`docs/public-api.md` quando ela for atualizada (§13).

### D-4 💡 — Funil: **linhas em `broadcasts`**, não tabela nova

**Proposta:** `broadcasts` ganha `source`, `webhook_id`, `webhook_name`; `source = 'webhook'`
marca a linha como funil de ingestão.

O achado D é o argumento inteiro: espelhar `broadcasts`/`broadcast_recipients` numa tabela nova
significaria reescrever o trigger agregador (003/005), reescrever o espelhamento de status da Meta
(`whatsapp_message_id` → `broadcast_recipients`) e reescrever `flagBroadcastReplyIfAny` — três
mecanismos testados, para chegar exatamente no mesmo lugar. E a tela de detalhe
(`/broadcasts/[id]`, com os 6 `StatCard` + `FunnelChart`) passaria a ter uma gêmea.

**Custo aceito:** `broadcasts` fica com três colunas que só metade das linhas usa, e a lista de
campanhas precisa filtrar `source` para não misturar campanha com funil (D-10).

### D-5 💡 — Um funil **acumulativo** por `webhook_id`, não um por POST

**Proposta:** cada `webhook_id` distinto tem **uma** linha em `broadcasts` por conta, criada no
primeiro POST e reusada em todos os seguintes. Cada POST com envio acrescenta **uma** linha em
`broadcast_recipients`.

É o que o pedido descreve ("todos que chegam com esse `webhook_id` são organizados no funil") e é
o que faz sentido operacional: um `webhook_id` é uma **origem** (uma landing page, um fluxo de
n8n), que vive meses. Um funil por POST daria uma campanha de 1 destinatário por lead — lista
ilegível, e o funil como visão perde o sentido.

Duas consequências que precisam estar escritas:

1. **`total_recipients` conta envios, não pessoas.** Não há unique em
   `(broadcast_id, contact_id)` (§2.2), então o mesmo contato reengajado no mês seguinte conta de
   novo — o que é o comportamento certo para um funil de origem. O rótulo da UI deve dizer
   "destinatários" no sentido de **envios**, e a aba precisa dizer isso em uma linha (§8.2).
2. **`status` fica em `'sending'` para sempre.** O `CHECK` de 001 não tem valor para "fluxo
   contínuo" e a lista renderiza isso como "Enviando" indefinidamente. **Proposta:** estender o
   `CHECK` com `'streaming'` na migração 065 e usar esse valor em toda linha `source='webhook'`.
   Alternativa descartada: reusar `'sent'` (mentiria — o funil não terminou).

### D-6 — Tags: **aditivas**, nunca substitutivas

**Proposta:** usar `resolveImportTagIds` + `assignImportedContactTags`, não `setContactTags`
(achado B). O webhook conhece uma fatia do contato; apagar o que ele não conhece é perda de dado.
`tag_create` é implícito e sempre `true` (o pedido diz *"tag que não existir na conta é criada"*) —
o parâmetro `canCreateTags` do helper existe para o caso do agente sem permissão, que não se aplica
a uma chave de API cujo escopo já foi concedido por um admin.

**Formato de entrada:** `tags` é uma **string separada por vírgula** (`"vip, lead quente"`),
conforme o pedido. Um array de strings também é aceito e tratado igual — custa uma linha e evita
que um integrador que já manda array receba erro. Espaços são aparados; entradas vazias, ignoradas;
o casamento é *case-insensitive* (é o que o helper já faz, e a unique `idx_tags_account_name_ci`
garante que não há ambiguidade).

### D-7 💡 — Notas: objeto indexado, ordenado **numericamente**

**Proposta:** aceitar `notes` como objeto `{"nota_1": "…", "nota_2": "…"}`; cada valor não-vazio
vira uma linha em `contact_notes`. As chaves são ordenadas pelo **sufixo numérico**, não
lexicograficamente — senão `nota_10` entraria antes de `nota_2` e o histórico ficaria fora de
ordem. Chaves sem sufixo numérico vão para o fim, em ordem alfabética.

Notas **nunca são deduplicadas nem substituídas** — cada POST empilha. É o que o workflow n8n já
faz (`n8n_automation/README.md`: *"funciona como um log de interações, não como um campo único"*),
e mudar isso agora criaria duas semânticas para a mesma tabela.

**Também aceitar array de strings** (`["texto 1", "texto 2"]`): é o formato que o n8n já manda hoje,
custa três linhas de código e evita que a migração de quem usa o workflow exija reescrever o
payload. O objeto é a forma canônica documentada.

`user_id` da nota vem de `resolveAuditUserId` — a mesma atribuição que todo write da API pública já
usa (dono da config do WhatsApp, com fallback no dono da conta).

### D-8 💡 — Campos personalizados: pula o campo, **não derruba a requisição**

**Proposta:** para cada `{ "field": "...", "value": "..." }`, casar `field` contra
`custom_fields.field_name` da conta. Sem correspondência → **aquele campo é ignorado**, uma linha
de log de nível `warning` é gravada, e o resto (contato, tags, notas, disparo) segue normalmente.

O pedido diz *"se não bater, ignora aquele campo específico"* e observa a ambiguidade. A leitura
por-campo é a certa: derrubar a requisição inteira por causa de um campo faria uma renomeação
inocente em Settings quebrar a captação de leads de um formulário em produção — e o operador
descobriria pelo volume caindo, não por uma mensagem.

**Casamento: *case-insensitive* com `trim`**, não byte-a-byte. O pedido diz "bater exatamente"; a
razão para afrouxar é concreta e verificável: `custom_fields` **não tem índice único** por
`(account_id, field_name)` (§2.2) — a duplicata é barrada só por checagem client-side em
[`custom-fields-manager.tsx:95`](../src/components/contacts/custom-fields-manager.tsx), que já usa
`toLowerCase()`. Exigir casamento exato faria `"CPF"` não casar com um campo cadastrado como
`"cpf"`, sendo que a própria UI considera os dois o mesmo campo. É também o que o n8n já faz.

**Se o casamento for ambíguo** (a conta tem `"CPF"` e `"cpf"`, possível por falta da unique): o
campo é **pulado** com log de nível `warning` e código `custom_field_ambiguous`. Escolher um dos
dois em silêncio gravaria no campo errado metade das vezes.

**Escrita:** `upsert` em `contact_custom_values` com `onConflict: 'contact_id,custom_field_id'` —
usa a unique que já existe e **nunca** o `DELETE`-then-`INSERT` do `contact-detail-view.tsx`
(achado C), que apagaria os campos que este POST não conhece.

### D-9 💡 — Template: busca por `message_templates.id`, guarda de aprovação **nova**

**Proposta:** `template_id` é o **UUID** de `message_templates.id`, não o `meta_template_id` (text)
da migração 014. Razão: é o id que a UI mostra e que o resto do app usa como chave; o
`meta_template_id` é detalhe da integração com a Meta e pode ser nulo em linha `DRAFT`.

Como não existe guarda server-side (achado E), nasce
`src/lib/whatsapp/template-approval.ts` — função pura sobre uma linha já carregada:

```ts
export type TemplateApprovalResult =
  | { ok: true; template: MessageTemplate }
  | { ok: false; reason: 'not_found' | 'not_approved'; status?: MessageTemplateStatus };
```

Aprovado ⇒ envia. Não aprovado (`PENDING`, `REJECTED`, `PAUSED`, `DISABLED`, …) ou inexistente na
conta ⇒ **não envia**, registra log com o status encontrado, e **o contato continua sendo criado**
(ver D-12). O envio em si reusa `sendContentViaChannel`/`cloudChannelContext`
([`src/lib/channels/send.ts`](../src/lib/channels/send.ts)) exatamente como `deliverBroadcast` faz.

**`assertAccountCanBroadcast` é chamado antes de qualquer envio** — é a guarda da SPEC 049 §5.3 que
impede um número QRCode de disparar campanha. Se a conta não tem canal Cloud, o envio é recusado
com `channel_not_capable` e registrado; a ingestão do contato segue.

### D-10 💡 — Onde o funil aparece: **na lista de `/broadcasts`, com filtro**, reusando a tela de detalhe

**Proposta:** [`/broadcasts`](<../src/app/(dashboard)/broadcasts/page.tsx>) ganha um seletor
segmentado **Campanhas | Funis de webhook**; o padrão é *Campanhas* e a consulta atual passa a
filtrar `source = 'dashboard'` (ou `IS NULL`, para as linhas históricas). Clicar num funil abre
`/broadcasts/[id]` — **a tela de detalhe não muda em nada**, porque ela lê exatamente as colunas
que o funil preenche.

Alternativas descartadas: (a) página nova `/webhooks` — duplicaria a lista e a tela de detalhe;
(b) misturar tudo numa lista só — a primeira campanha de verdade sumiria no meio de 30 funis.

A tela de detalhe ganha **uma** adição: quando `source = 'webhook'`, um cabeçalho com
`webhook_name`, o `webhook_id` (com botão copiar) e um link para a aba de log já filtrada por esse
`webhook_id`.

### D-11 💡 — Log: **tabela própria**, nada reusado do webhook de saída

**Proposta:** tabela nova `webhook_ingest_logs` (migração 065). Nada de
`webhook_endpoints.failure_count`.

Os dois não têm nada em comum além da palavra "webhook": `failure_count` é um **contador agregado
por endpoint de saída**, cuja unidade é "a última entrega HTTP falhou", sem payload, sem motivo,
sem timestamp por evento — existe para auto-desativar um destino morto após 15 falhas
([`deliver.ts`](../src/lib/webhooks/deliver.ts)). O que esta SPEC precisa é o oposto: **uma linha
por tentativa rejeitada**, com motivo, payload e origem, consultável e filtrável.

### D-12 💡 — Aba de log **separada** da visão de funil, e só para falhas

**Proposta:** aba nova em Settings → **"Log de webhook"** (`?tab=webhook-log`), contendo **apenas**
rejeições e avisos. O sucesso vive no funil, em `/broadcasts`.

São dois públicos e dois momentos: o funil é acompanhamento de resultado (quantos leram, quantos
responderam), consultado por quem opera a campanha; o log é depuração de integração (por que 40
POSTs não viraram contato), consultado por quem escreveu o n8n — a mesma pessoa que já vai a
Settings → API keys pegar a credencial. Juntar os dois numa tela com sub-filtro faria a visão de
resultado carregar peso de depuração para sempre.

A ligação entre as duas existe nos dois sentidos: o detalhe do funil linka para o log filtrado
(D-10), e cada linha do log com `webhook_id` conhecido linka para o funil correspondente.

**Colunas por linha:** `created_at` · `webhook_name` · `webhook_id` · nível (`error` / `warning`) ·
código do erro (traduzido) · telefone (mascarado, ver D-13) · payload (expansível). `webhook_name` e
`webhook_id` são **nullable** — quando a falha é a validação deles próprios, não há o que mostrar, e
a coluna renderiza `—`.

### D-13 💡 — Payload no log: guardado inteiro, **mascarado na exibição**, com retenção

**Proposta:**

- **Guardar:** o corpo JSON recebido, íntegro, em `jsonb`, **truncado em 8 KB** (payload maior é
  substituído por `{"_truncated": true, "_size": N}` — o log é para depurar forma, não para
  arquivar conteúdo). O `Authorization` **nunca** entra: só o corpo é gravado, nunca headers.
- **Exibir:** a coluna de telefone da tabela vem mascarada (`+55 (19) 9****-**58`); o payload fica
  atrás de um "Ver payload" com aviso de que contém dado pessoal. Não é segredo — é dado da própria
  conta, visível a qualquer membro pela RLS — mas não precisa ficar exposto numa tela que alguém
  abre com o time olhando.
- **Reter:** índice em `(account_id, created_at DESC)` e purga do que passar de **90 dias**.

> ⚠️ **A purga NÃO é automática.** A memória do projeto e o `AGENTS.md` registram que o `pg_cron`
> **não está instalado no projeto `vn`** — agendar a purga e assumir que ela roda produziria
> exatamente o silêncio que a armadilha descreve. A migração 065 cria a **função** de purga; o
> agendamento vai como snippet comentado em `supabase/setup/`, para o mantenedor decidir. Enquanto
> não houver cron, a tabela cresce — o que é aceitável (uma linha por *falha*, não por requisição).

### D-14 — Código HTTP em falha de validação: **400 com o envelope padrão**

**Proposta:** manter o contrato de `/api/v1` — `400` + `{"error":{"code":"…","message":"…"}}`, com
`code` específico por falha (§5.3). O log é o registro durável; o HTTP é a resposta imediata.

O workflow n8n existente responde `422` nesses casos, e um `4xx` faz o node HTTP do n8n falhar de
qualquer forma. Divergir do envelope de `/api/v1` para agradar um cliente específico quebraria a
promessa que `docs/public-api.md` faz em letras grandes ("um único parser de resposta"). Quem quiser
tratar sem falhar o node usa a opção "never error" do n8n e lê `error.code`.

### D-15 💡 — Contato ingerido sem envio também aparece no funil

**Proposta:** `broadcasts` ganha também `ingested_count`, incrementado a cada POST **aceito**,
independentemente de ter havido disparo. `total_recipients` continua sendo o que já é: número de
linhas em `broadcast_recipients` (envios tentados).

Sem isso, um `webhook_id` que só ingere (sem `template_id`) não apareceria em lugar nenhum — nem no
funil (sem envio) nem no log (sem erro), e o operador não teria como confirmar que a integração está
viva. Com os dois números lado a lado, a tela responde a pergunta que importa: *"chegaram 500,
receberam 300 — por que 200 não?"* (resposta: no log).

Alternativa descartada: contar só no log. Um "log de sucesso" é uma linha por POST — ordens de
grandeza mais volume, para informação que um contador já dá.

---

## 5. Contrato do endpoint

### 5.1 Requisição

```http
POST /api/v1/ingest/contact
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

```json
{
  "webhook_id": "1234567890123456",
  "webhook_name": "Landing page — Black Friday",

  "phone": "(19) 9 9924-9658",
  "name": "Maria Souza",
  "email": "maria@empresa.com.br",
  "company": "Empresa LTDA",
  "tags": "Cliente VIP, lead quente",

  "notes": {
    "nota_1": "Veio do formulário da LP de Black Friday",
    "nota_2": "Pediu contato à tarde"
  },

  "custom_fields": [
    { "field": "CPF", "value": "123.456.789-00" },
    { "field": "origem", "value": "landing_page_bf" }
  ],

  "template_id": "3f2b8c10-2a44-4a7e-9c1e-77c3b2a1d5e0",
  "template_params": ["Maria"]
}
```

| Campo             | Tipo                    | Obrigatório | Regra                                                                                     |
| ----------------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `webhook_id`      | string                  | **sim**     | `/^\d{16,}$/` — só dígitos, mínimo 16                                                     |
| `webhook_name`    | string                  | **sim**     | não vazia após `trim`; limite de 120 caracteres (vira nome do funil)                      |
| `phone`           | string                  | **sim**     | `normalizeContactPhone` (SPEC 050) — ver D-3                                              |
| `name`            | string                  | não         | ausente ⇒ o telefone normalizado vira o nome (comportamento de `findOrCreateContact`)     |
| `email`           | string                  | não         | gravado como veio                                                                          |
| `company`         | string                  | não         | gravado como veio                                                                          |
| `tags`            | string CSV \| string[]  | não         | aditivo; cria a tag que não existir (D-6)                                                 |
| `notes`           | objeto \| string[]      | não         | ordem por sufixo numérico; sempre acrescenta (D-7)                                        |
| `custom_fields`   | `{field,value}[]`       | não         | campo sem correspondência é pulado com aviso (D-8)                                        |
| `template_id`     | uuid                    | não         | `message_templates.id` da conta, status `APPROVED` (D-9)                                  |
| `template_params` | string[]                | não         | parâmetros posicionais do corpo (`{{1}}`, `{{2}}`…); ignorado sem `template_id`           |

### 5.2 Respostas

**202 — aceito** (o envio, quando há, corre em `after()`):

```json
{
  "data": {
    "contact_id": "b630a43f-…",
    "contact_created": true,
    "funnel": { "broadcast_id": "9c1e…", "webhook_id": "1234567890123456" },
    "tags": { "linked": 2, "created": 1 },
    "notes": { "inserted": 2 },
    "custom_fields": { "matched": 1, "skipped": ["origem"] },
    "send": { "attempted": true, "template_id": "3f2b8c10-…" },
    "warnings": [
      { "code": "custom_field_not_found", "message": "Custom field 'origem' does not exist in this account" }
    ]
  }
}
```

`warnings[]` é o espelho em tempo real das linhas de `warning` gravadas no log — quem consome pela
API vê na hora; quem opera vê na aba.

**400 — rejeitado**, nada foi criado:

```json
{ "error": { "code": "invalid_phone", "message": "Phone number failed Brazilian validation: invalid_ddd" } }
```

### 5.3 Códigos de erro e aviso

| `code`                     | HTTP | Nível no log | Situação                                                              |
| -------------------------- | ---- | ------------ | ----------------------------------------------------------------------- |
| `invalid_webhook_id`       | 400  | error        | ausente, não-numérico, ou com menos de 16 dígitos                     |
| `invalid_webhook_name`     | 400  | error        | ausente ou vazia após `trim`                                          |
| `invalid_phone`            | 400  | error        | `normalizeContactPhone` recusou (`message` carrega o `reason`)        |
| `bad_request`              | 400  | error        | corpo não é objeto JSON                                               |
| `template_not_found`       | 202  | error        | `template_id` não existe nesta conta — contato **foi** criado         |
| `template_not_approved`    | 202  | error        | existe mas `status ≠ APPROVED` — contato **foi** criado               |
| `channel_not_capable`      | 202  | error        | conta sem canal Cloud (SPEC 049 §5.3) — contato **foi** criado        |
| `send_failed`              | 202  | error        | a Meta recusou o envio (a linha do destinatário vira `failed`)        |
| `custom_field_not_found`   | 202  | warning      | `field` sem correspondência — o campo foi pulado                      |
| `custom_field_ambiguous`   | 202  | warning      | duas definições diferindo só em caixa — o campo foi pulado            |
| `note_empty`               | 202  | warning      | chave de nota com valor vazio — pulada                                |
| `payload_truncated`        | 202  | warning      | payload acima de 8 KB; o log guardou só o marcador                    |
| `unauthorized` / `forbidden` / `rate_limited` | 401/403/429 | **nenhum** | vem de `requireApiKey`; sem conta resolvida não há linha (D-2) |

> A assimetria HTTP é deliberada: falha **antes** de criar o contato é `400` (nada aconteceu);
> falha **depois** é `202` com o erro em `warnings` e no log (o contato existe, e mentir sobre isso
> com um `4xx` faria o caller reprocessar e duplicar).

---

## 6. Modelo de dados — migração `065_inbound_contact_webhook.sql`

> ⚠️ **Três projetos Supabase** (`vn`, `rs`, `jh`). **Confirmar com o mantenedor antes de aplicar**,
> conforme `AGENTS.md`.

### 6.1 `broadcasts` — três colunas + um contador + um status

```sql
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'dashboard',
  ADD COLUMN IF NOT EXISTS webhook_id      TEXT,
  ADD COLUMN IF NOT EXISTS webhook_name    TEXT,
  ADD COLUMN IF NOT EXISTS ingested_count  INTEGER NOT NULL DEFAULT 0;
```

- `source ∈ ('dashboard','api','webhook')` via `CHECK`. As linhas existentes ficam `'dashboard'`
  pelo `DEFAULT`, o que mantém a lista atual intacta sem backfill.
- `CHECK` de coerência: `webhook_id`/`webhook_name` são `NOT NULL` **se e somente se**
  `source = 'webhook'` — o mesmo padrão de invariante-de-forma que a migração 051 usa para as
  variantes A/B, e pela mesma razão: uma linha meio-preenchida faria a tela renderizar lixo em vez
  de falhar.
- **Índice único parcial** — é ele que garante o funil acumulativo do D-5:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_account_webhook
  ON broadcasts(account_id, webhook_id)
  WHERE source = 'webhook';
```

- **`CHECK` de `status` estendido** com `'streaming'` (D-5). Precisa ser `DROP CONSTRAINT` +
  `ADD CONSTRAINT` dentro de um `DO $$` idempotente, no mesmo formato da 051 §2 — o `CHECK` de 001
  é anônimo por posição e precisa ser localizado por `pg_constraint`.

### 6.2 `webhook_ingest_logs` (nova)

```sql
CREATE TABLE IF NOT EXISTS webhook_ingest_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id   uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  webhook_id   text,                    -- NULL quando a própria validação dele falhou
  webhook_name text,                    -- idem
  level        text NOT NULL CHECK (level IN ('error','warning')),
  code         text NOT NULL,           -- §5.3
  message      text NOT NULL,           -- inglês, como todo /api/** (AGENTS.md)
  phone        text,                    -- como recebido, sem normalizar (é o que falhou)
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  payload      jsonb,                   -- corpo recebido, ≤ 8 KB (D-13)
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_ingest_logs_account_created
  ON webhook_ingest_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_ingest_logs_webhook
  ON webhook_ingest_logs(account_id, webhook_id, created_at DESC);
```

**RLS** — espelha `webhook_endpoints` (028), que é o precedente mais próximo:

- `SELECT`: `is_account_member(account_id)` — qualquer membro vê.
- `DELETE`: `is_account_member(account_id, 'admin')` — limpar log é ação de settings.
- `INSERT`/`UPDATE`: **nenhuma policy**. A escrita só acontece pela rota, com o cliente
  `service_role` (que ignora RLS); não existe caso legítimo de um usuário logado inserir linha de
  log, e a ausência de policy torna isso impossível por construção.

### 6.3 RPC de upsert do funil — a razão de existir é a corrida

```sql
CREATE OR REPLACE FUNCTION public.upsert_webhook_funnel(
  p_account_id   uuid,
  p_user_id      uuid,
  p_webhook_id   text,
  p_webhook_name text
) RETURNS uuid …
```

Encontra-ou-cria a linha `source='webhook'` daquele `webhook_id` e incrementa `ingested_count` **na
mesma instrução**, devolvendo o `id`. Fazer isso em TypeScript (`SELECT` → `if` → `INSERT`/`UPDATE`)
tem corrida garantida: um n8n disparando 50 leads em paralelo cairia no `SELECT` vazio 50 vezes e
tentaria 50 `INSERT`s — o índice único do §6.1 barraria 49, e o código teria que tratar violação de
unique em todo POST. O `INSERT … ON CONFLICT DO UPDATE` resolve na primeira tentativa.

`webhook_name` é atualizado a cada POST (o último vence): renomear a origem no n8n renomeia o funil,
que é o comportamento esperado de um rótulo.

**`total_recipients`** é incrementado à parte, no momento em que a linha de `broadcast_recipients` é
criada — via `_bcast_bump` ou `UPDATE … SET total_recipients = total_recipients + 1`. Ele **não** é
mantido pelo trigger de 003/005 (o trigger só cuida dos cinco contadores de status), e essa é
exatamente a distinção que `createBroadcast` documenta ao semear `total_recipients` no INSERT e não
tocar nos demais.

---

## 7. Módulos novos — `src/lib/ingest/`

Toda a regra é pura ou tem I/O isolado, seguindo `AGENTS.md` (lógica em `src/lib/`, teste
co-locado).

| Arquivo                              | Responsabilidade                                                                                             | I/O |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --- |
| `validate.ts` + `.test.ts`           | `parseIngestPayload(body)` → `{ ok, value } \| { ok:false, code, message }`. `webhook_id`/`webhook_name`, telefone (delega a `normalizeContactPhone`), tags CSV→array, notas objeto→array ordenada, `custom_fields` normalizados | ❌ puro |
| `notes.ts` + `.test.ts`              | `insertContactNotes(db, {accountId,userId,contactId,notes})` — a lógica que hoje só existe em `contact-detail-view.tsx` (achado C) | ✅ |
| `custom-values.ts` + `.test.ts`      | `applyCustomValues(db, {accountId,contactId,entries})` → `{matched, skipped[], ambiguous[]}`; `upsert` com `onConflict`, nunca `DELETE`-then-`INSERT` | ✅ |
| `funnel.ts` + `.test.ts`             | `upsertFunnel` (RPC do §6.3) e `addFunnelRecipient` (linha em `broadcast_recipients` + bump de `total_recipients`) | ✅ |
| `log.ts` + `.test.ts`                | `logIngestEvent(db, …)` — best-effort, **nunca lança** (mesma disciplina de `dispatchWebhookEvent`: falha de log não pode derrubar a requisição); trunca payload em 8 KB | ✅ |
| `send.ts` + `.test.ts`               | orquestra `assertAccountCanBroadcast` → `assertTemplateApproved` → `cloudChannelContext` → `sendContentViaChannel` → carimba a linha do destinatário | ✅ |

E, fora de `ingest/` por pertencer ao domínio WhatsApp:

| Arquivo                                          | Responsabilidade                                          |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `src/lib/whatsapp/template-approval.ts` + teste  | guarda pura de status aprovado (achado E, D-9)            |

**Rota:** `src/app/api/v1/ingest/contact/route.ts` — fina, no molde de
`src/app/api/v1/broadcasts/route.ts`: `requireApiKey('ingest:write')` → `parseIngestPayload` →
escrita síncrona → `after(() => enviar)` → `ok(payload, 202)`. `export const maxDuration = 60`
pela mesma razão documentada lá.

**Rota interna da UI:** `src/app/api/account/webhook-logs/route.ts` (`GET`, paginada) — espelha
`/api/account/api-keys`, que é o que `api-keys-settings.tsx` consome.

---

## 8. UI

### 8.1 Settings → aba "Log de webhook"

Arquivos: `src/components/settings/webhook-log-settings.tsx` (novo) + 4 pontos de registro
(`SETTINGS_SECTIONS`, `SECTION_META`, o mapa `panel` em `settings/page.tsx`, e as chaves i18n).
Ícone sugerido: `ScrollText` (lucide). Grupo: `workspace`, ao lado de "API keys".

Estrutura, copiando `api-keys-settings.tsx`: `SettingsPanelHead` + `Card` + `Table`, carga por
`fetch` na rota interna, `RequireRole min="admin"` só no botão de limpar. Filtros: `webhook_id`
(select alimentado pelos distintos da conta) e nível. Paginação por cursor de `created_at`.

Texto de abertura do painel (uma linha, traduzida) precisa dizer as duas coisas que não são
óbvias: que aqui só entram **falhas** (o sucesso está em Disparos), e que **requisição com chave
inválida não aparece** (D-2).

### 8.2 Broadcasts → filtro de funis

- [`/broadcasts/page.tsx`](<../src/app/(dashboard)/broadcasts/page.tsx>): seletor segmentado
  Campanhas | Funis de webhook; a consulta atual ganha `.eq('source','dashboard')` (com
  `.or('source.is.null')` para linhas anteriores à migração, embora o `DEFAULT` já as cubra).
  Na aba de funis, as colunas mudam de `scheduled_at`/status para `webhook_id` e `ingested_count`.
- [`/broadcasts/[id]/page.tsx`](<../src/app/(dashboard)/broadcasts/[id]/page.tsx>): quando
  `source = 'webhook'`, cabeçalho com nome/ID/copiar + link para o log filtrado, e uma nota curta
  explicando que "destinatários" conta **envios**, não pessoas distintas (D-5).
- `StatCard` e `FunnelChart` não mudam.

---

## 9. i18n

`messages/en.json` é a fonte da verdade; `pt-BR.json` espelha. `npm run i18n:check` falha se
divergir.

| Namespace                         | Conteúdo                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `Settings.sections.webhook-log`   | rótulo da aba no rail                                                       |
| `Settings.webhookLog.*`           | título, descrição, colunas, filtros, estado vazio, ação de limpar           |
| `Settings.webhookLog.codes.*`     | um rótulo por `code` da §5.3 — é o que traduz o erro na tela                |
| `Settings.apiKeys.scopes.*`       | descrição do escopo `ingest:write` (se o painel já traduz descrições)       |
| `Broadcasts.sourceFilter.*`       | "Campanhas" / "Funis de webhook"                                            |
| `Broadcasts.webhookFunnel.*`      | cabeçalho do detalhe, `ingested_count`, nota sobre envios × pessoas         |

**Mensagens de `/api/**` continuam em inglês** (`AGENTS.md`) — `webhook_ingest_logs.message` guarda
o texto em inglês e a UI traduz pelo `code`, nunca pelo `message`.

---

## 10. Fases de execução

| Fase   | Entrega                                                                                                    | Depende de |
| ------ | ------------------------------------------------------------------------------------------------------------ | ---------- |
| **F1** | Migração `065` (§6) — colunas, `CHECK`s, índice único, tabela de log + RLS, RPC de upsert, função de purga  | —          |
| **F2** | `src/lib/ingest/validate.ts` + testes. Puro, zero I/O — nenhuma mudança de comportamento no app             | —          |
| **F3** | `notes.ts` + `custom-values.ts` + testes. Extrai o achado C para `src/lib/`                                | F1         |
| **F4** | `log.ts` + testes                                                                                          | F1         |
| **F5** | `template-approval.ts` + `ingest/send.ts` + testes                                                          | F2         |
| **F6** | `funnel.ts` + testes                                                                                       | F1         |
| **F7** | Escopo `ingest:write` + rota `POST /api/v1/ingest/contact`                                                  | F2–F6      |
| **F8** | Rota interna `GET /api/account/webhook-logs` + aba "Log de webhook" em Settings                            | F1, F4     |
| **F9** | Filtro de funis em `/broadcasts` + cabeçalho no detalhe                                                     | F1, F6     |
| **F10**| i18n (§9) + sequência de validação completa (§11.3)                                                         | F7–F9      |

F2 e F5 podem correr em paralelo com F1 (são puras). F8 e F9 são independentes entre si.

---

## 11. Plano de teste

### 11.1 Automatizados (Vitest, co-locados)

**`validate.test.ts`** — o coração da SPEC:

- `webhook_id`: 16 dígitos ✅ · 15 dígitos ❌ · 20 dígitos ✅ · `"1234567890123abc"` ❌ ·
  `"+551234567890123"` ❌ · ausente ❌ · número JS em vez de string (decidir: aceitar coagindo,
  para não quebrar quem manda `1234567890123456` sem aspas — **e testar isso explicitamente**)
- `webhook_name`: `""` ❌ · `"   "` ❌ · 120 chars ✅ · 121 chars (trunca ou rejeita — testar a
  escolha, não a suposição)
- telefone: um caso por `PhoneRejectReason` de `br.ts` (`invalid_ddd`, `mobile_invalid_ninth_digit`,
  `invalid_length`, `invalid_local_prefix`, `empty`), mais um estrangeiro aceito (D-2 da SPEC 050) e
  um legado de 8 dígitos aceito (D-6 da SPEC 050)
- tags: `"a, b ,, c"` → `['a','b','c']` · array aceito igual · `""` → `[]`
- notas: `nota_2` antes de `nota_10` ✅ (**é o teste que falha na implementação lexicográfica** —
  escrever antes de codificar) · chave sem sufixo vai para o fim · valor vazio vira `note_empty`
- `custom_fields`: forma errada (`{}` em vez de array) não derruba, vira aviso

**`custom-values.test.ts`** — casamento *case-insensitive*; campo inexistente → `skipped`; duas
definições diferindo só em caixa → `ambiguous` e **nenhuma** escrita; `upsert` não apaga valores de
outros campos (o teste que trava o achado C: popular 3 campos, mandar 1, assertar que os 3
continuam).

**`funnel.test.ts`** — segundo POST com o mesmo `webhook_id` **não** cria segunda linha em
`broadcasts`; `ingested_count` sobe nos dois; `total_recipients` sobe só quando há envio.

**`template-approval.test.ts`** — um caso por valor de `MessageTemplateStatus`; só `APPROVED` passa.

**`log.test.ts`** — `logIngestEvent` engole erro do banco sem lançar (asserção sobre a promessa,
não sobre o console); payload > 8 KB vira o marcador.

**`ingest/send.test.ts`** — conta só-QRCode → `channel_not_capable` e nenhuma chamada de envio;
falha da Meta → linha do destinatário em `failed` (o que faz `failed_count` subir pelo trigger).

> **Lição da SPEC 048 F4, que vale repetir aqui:** um teste escrito a partir de uma *fixture
> inventada* só reproduz a suposição de quem o escreveu. Para os casos de status da Meta e de
> resposta de envio, usar payload capturado de verdade — ou, se não houver, verificar que o teste
> **falha** contra o código antigo antes de considerá-lo verde.

### 11.2 Manuais antes do merge

1. `POST` com `webhook_id` de 15 dígitos → 400, **linha no log** com `webhook_id` em branco.
2. `POST` válido sem `template_id` → contato criado; funil aparece na aba de funis com
   `ingested_count = 1` e `total_recipients = 0`.
3. Mesmo `webhook_id`, segundo lead → **um** funil, `ingested_count = 2`.
4. `POST` com `template_id` aprovado → mensagem chega no aparelho; funil vai a `sent_count = 1`;
   **responder pelo WhatsApp** e conferir `replied_count = 1` (é o que valida o achado D ponta a
   ponta).
5. `POST` com `template_id` de template `PENDING` → 202, contato criado, log com
   `template_not_approved`, nenhuma mensagem enviada.
6. Contato com 3 campos personalizados preenchidos; `POST` mandando só 1 → os outros 2 **intactos**.
7. Contato com tag `cliente_vip`; `POST` mandando `tags: "lead"` → contato fica com **as duas**.
8. Chave sem o escopo `ingest:write` → 403, **nenhuma** linha no log.
9. Aba do log em pt-BR e en — nenhuma chave crua na tela.
10. Telefone com DDD 20 (inexistente) → 400 + log `invalid_phone`.

### 11.3 Sequência de validação (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 12. Riscos e armadilhas

| Risco                                                                    | Mitigação                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `status = 'streaming'` quebra tela que assume os 5 valores de 001        | `grep` por `getBroadcastStatus` / `broadcast-status.ts` antes da F9; adicionar o rótulo no mapa de exibição       |
| Funil acumulativo cresce sem fim em `broadcast_recipients`               | Aceito — é o mesmo volume de um broadcast grande, e o índice `idx_broadcast_recipients_broadcast` (003) já existe |
| Purga do log não roda (pg_cron ausente no `vn`)                          | D-13: só a função é criada; agendamento fica em `supabase/setup/`, explícito, para o mantenedor decidir           |
| `after()` cortado pelo `maxDuration` deixa destinatário em `pending`     | Limitação já existente e documentada em `POST /api/v1/broadcasts`; aqui é **1 envio por POST**, risco muito menor |
| Payload no log expõe dado pessoal a qualquer membro                      | D-13: mascaramento na tabela, payload atrás de clique, retenção de 90 dias                                       |
| Divergência de estritude de telefone entre `/api/v1/contacts` e `/ingest`| D-3 registra a divergência como decisão; §13 exige documentá-la em `docs/public-api.md`                           |
| Migração aplicada no projeto errado                                      | `AGENTS.md`: três projetos (`vn`, `rs`, `jh`) — **confirmar com o mantenedor antes de aplicar**                   |

---

## 13. Trabalho de acompanhamento (fora do escopo desta SPEC)

1. **`docs/public-api.md`** — seção do novo endpoint, o escopo `ingest:write` na tabela de escopos,
   e a nota de estritude do D-3. O próprio documento declara ser a fonte da verdade do contrato e
   exige atualização na mesma mudança que altera comportamento — cumprir isso é a primeira tarefa
   depois da F7.
2. **`public/openapi.json`** — hoje tem 11 caminhos (`/me`, `/messages`, `/contacts`,
   `/contacts/{id}`, `/conversations`, `/conversations/{id}`, `/conversations/{id}/messages`,
   `/broadcasts`, `/broadcasts/{id}`, `/webhooks`, `/webhooks/{id}`); passará a ter 12. Revalidar
   com `npx @redocly/cli lint` e o parser do Scalar, como a doc manda.
3. **Unificar a guarda de template aprovado** — trocar os três filtros client-side (achado E) pelo
   `template-approval.ts`, e chamá-lo também em `createBroadcast` e `send-message.ts`. Hoje é
   possível disparar campanha com template não aprovado via API pública; esta SPEC não corrige isso,
   só deixa de introduzir mais um caso.
4. **Migrar o workflow n8n** — `n8n_automation/workflow_contact_ingestion.json` passaria a chamar
   este endpoint em vez de escrever direto no Supabase, o que tira a `service_role` de circulação
   numa credencial de n8n. Decisão de operação, não de código.
5. **`GET` de notas e campos personalizados** na API pública — a escrita passa a existir com esta
   SPEC; a leitura continua sem endpoint.

---

## 14. Referências

**Código citado (verificado em 2026-08-18)**

- [`src/lib/auth/api-context.ts`](../src/lib/auth/api-context.ts) — `requireApiKey`, escopo, rate limit
- [`src/lib/api/v1/respond.ts`](../src/lib/api/v1/respond.ts) — envelope, `ApiError`
- [`src/lib/api/v1/contacts.ts`](../src/lib/api/v1/contacts.ts) — `findOrCreateContact`, `setContactTags`, `resolveAuditUserId`
- [`src/lib/api-keys/scopes.ts`](../src/lib/api-keys/scopes.ts) — `API_SCOPES`
- [`src/lib/phone/br.ts`](../src/lib/phone/br.ts) — `normalizeContactPhone`, `PhoneRejectReason`
- [`src/lib/contacts/resolve-import-tags.ts`](../src/lib/contacts/resolve-import-tags.ts) — tags aditivas
- [`src/lib/whatsapp/broadcast-core.ts`](../src/lib/whatsapp/broadcast-core.ts) — `createBroadcast`, `deliverBroadcast`, `assertAccountCanBroadcast`
- [`src/lib/whatsapp/template-status-normalize.ts`](../src/lib/whatsapp/template-status-normalize.ts) — enum de status
- [`src/lib/channels/ingest.ts`](../src/lib/channels/ingest.ts) — `flagBroadcastReplyIfAny`
- [`src/lib/webhooks/deliver.ts`](../src/lib/webhooks/deliver.ts) — webhook de **saída** (contraste)
- [`src/app/api/whatsapp/webhook/route.ts`](../src/app/api/whatsapp/webhook/route.ts) — espelhamento de status por `whatsapp_message_id`
- [`src/components/contacts/contact-detail-view.tsx`](../src/components/contacts/contact-detail-view.tsx) — escrita de notas e campos personalizados hoje
- [`src/components/settings/api-keys-settings.tsx`](../src/components/settings/api-keys-settings.tsx) — molde da aba de Settings
- [`src/components/settings/settings-sections.ts`](../src/components/settings/settings-sections.ts) — registro de abas
- [`src/components/broadcasts/funnel-chart.tsx`](../src/components/broadcasts/funnel-chart.tsx) · [`stat-card.tsx`](../src/components/broadcasts/stat-card.tsx)

**Migrações citadas**

- [`001_initial_schema.sql`](../supabase/migrations/001_initial_schema.sql) — `broadcasts`, `broadcast_recipients`, `custom_fields`, `contact_custom_values`, `contact_notes`, `message_templates`
- [`003`](../supabase/migrations/003_broadcast_recipient_wamid.sql) / [`005`](../supabase/migrations/005_broadcast_counts_incremental.sql) — trigger agregador dos contadores
- [`014_message_templates_meta_integration.sql`](../supabase/migrations/014_message_templates_meta_integration.sql) — `meta_template_id`, status da Meta
- [`017_account_sharing.sql`](../supabase/migrations/017_account_sharing.sql) — tenancy e RLS por conta
- [`028_webhook_endpoints.sql`](../supabase/migrations/028_webhook_endpoints.sql) — molde de tabela + RLS
- [`038_tags_unique_name.sql`](../supabase/migrations/038_tags_unique_name.sql) — unique *case-insensitive* de tags
- [`051_broadcast_ab_test.sql`](../supabase/migrations/051_broadcast_ab_test.sql) — molde de `CHECK` de invariante de forma

**Documentos**

- [SPEC 050 — padronização de telefone BR](./spec-050-padronizacao-telefone-br.md) (§4 D-5 é o que o D-3 desta SPEC estende)
- [SPEC 049 — inbox multicanal e motores](./spec-049-inbox-multicanal-e-motores.md) (§5.3, capacidade de disparo por canal)
- [SPEC 051 — exportação de contatos](./spec-051-exportacao-de-contatos.md) (molde de rota + lib pura + fases)
- [docs/public-api.md](./public-api.md) — contrato da API pública
- [n8n_automation/README.md](../n8n_automation/README.md) e [SPEC_contact_ingestion_workflow.md](../n8n_automation/SPEC_contact_ingestion_workflow.md) — o contrato equivalente que já roda fora do app
