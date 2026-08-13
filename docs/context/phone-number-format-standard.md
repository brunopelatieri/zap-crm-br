# Padrão de formato de número de telefone — análise e mapeamento

> Documento de referência (não é uma SPEC de feature). Objetivo: servir de insumo para um LLM
> executar, em uma tarefa futura, a padronização de todos os pontos de entrada de número de
> telefone do ZAP CRM BR. Levantado por leitura direta do código em 2026-08-13 — antes de agir
> sobre qualquer recomendação aqui, revalide os caminhos citados (arquivo:linha) contra o estado
> atual do repositório, pois o código pode ter mudado desde então.

---

## 1. Recomendação — padrão canônico

**Formato canônico: dígitos apenas, com DDI, sem `+`, sem máscara.**
Exemplo: `+55 (19) 9 9249-6598` → **`5519992496598`**.

Isso já é a saída de `sanitizePhoneForMeta()` / `normalizePhone()`
([src/lib/whatsapp/phone-utils.ts:6-18](../../src/lib/whatsapp/phone-utils.ts#L6-L18)) e é exatamente
o que a coluna gerada `contacts.phone_normalized` calcula
(`regexp_replace(phone, '\D', '', 'g')` — migração 022). **Não é uma proposta nova**: é o padrão
que 3 dos 4 caminhos de escrita já seguem hoje (API pública, webhook Meta, importação n8n) — falta
alinhar os que ainda não seguem (ver §3).

### Por que este e não E.164 com `+`

- A **Meta Cloud API** exige dígitos sem `+` no campo `to` do payload de envio — é o formato nativo
  do provedor principal do sistema.
- O **Evolution/Baileys** (canal QRCode) usa `remoteJid` no formato `<DDI+DDD+numero>@s.whatsapp.net`
  — a parte numérica também é dígitos puros, sem `+`.
- A rota de pareamento por telefone da Evolution já valida exatamente esse formato:
  `/^\d{10,15}$/` ([src/app/api/channels/evolution/instances/[id]/pair/route.ts:36](../../src/app/api/channels/evolution/instances/[id]/pair/route.ts#L36)).
- O workflow n8n de ingestão de contatos converte qualquer formato BR de entrada para
  "E.164 sem `+`" antes de gravar, deliberadamente, para casar com `phone_normalized`
  ([n8n_automation/SPEC_contact_ingestion_workflow.md:72-76](../../n8n_automation/SPEC_contact_ingestion_workflow.md#L72-L76)).
- A coluna `phone_normalized` (dedup autoritativo, migração 022) já é dígitos-only. Se `phone`
  também for dígitos-only, `phone === phone_normalized` sempre — elimina uma fonte de confusão
  ("por que salvo uma coisa e o banco mostra outra na coluna gerada?").

Guardar o `+` não agrega nada: nenhum dos dois provedores de envio aceita `+` no payload, então
guardá-lo obriga toda leitura de `phone` a re-sanitizar antes de usar — o que é exatamente o bug
que existe hoje em dois caminhos (§3).

### O que NÃO normalizar na gravação

- **Máscara de exibição** (`(19) 9 9249-6598`) é responsabilidade da camada de apresentação, não do
  dado gravado. Hoje **não existe** um formatador de exibição no código (nenhum `formatPhone` /
  `maskPhone` foi encontrado) — todo componente renderiza `contact.phone` cru
  (ex.: [src/components/contacts/contact-detail-view.tsx](../../src/components/contacts/contact-detail-view.tsx),
  [src/components/inbox/contact-sidebar.tsx](../../src/components/inbox/contact-sidebar.tsx)). Se a
  gravação virar sempre dígitos-only, um formatador de exibição BR (`+55 19 99249-6598`) passa a
  ser necessário para não piorar a legibilidade na UI — está fora do escopo deste documento, mas é
  um efeito colateral direto da padronização e deveria entrar na mesma tarefa.
- **Validação de DDD/9º dígito móvel brasileiro** — o n8n já faz essa validação completa (67 DDDs
  Anatel, regra do 9º dígito) antes de normalizar. O app Next.js **não faz essa validação hoje**;
  usa apenas `isValidE164` (7–15 dígitos, começando por não-zero) — aceita qualquer país. Decisão a
  tomar: se o app deve importar a mesma validação BR-específica do n8n, ou se continua
  intencionalmente permissivo para suportar contatos de outros países.

---

## 2. Mapa completo dos pontos de entrada

### 2.1 Utilitários centrais (a base de tudo)

| Arquivo                                                                  | Função                                                                 | O que faz                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/whatsapp/phone-utils.ts](../../src/lib/whatsapp/phone-utils.ts) | `sanitizePhoneForMeta(phone)`                                          | Remove tudo que não é dígito. Usado para preparar o `to` do envio Meta.                                                             |
| idem                                                                     | `normalizePhone(phone)`                                                | Idêntica a `sanitizePhoneForMeta` (dígitos apenas) — usada para comparação/dedup.                                                   |
| idem                                                                     | `phonesMatch(a, b)`                                                    | Compara dois números tolerando prefixo de tronco `0` (compara últimos 8 dígitos).                                                   |
| idem                                                                     | `isValidE164(phone)`                                                   | Regex `/^\+?[1-9]\d{6,14}$/` — aceita com ou sem `+`, 7–15 dígitos, não valida país/DDD.                                            |
| idem                                                                     | `phoneVariants(sanitized)`                                             | Gera variantes com/sem `0` de tronco após o DDI, para retry quando a Meta rejeita (erro 131030, sandbox).                           |
| [src/lib/contacts/dedupe.ts](../../src/lib/contacts/dedupe.ts)           | `normalizeKey`, `findExistingContact`, `isExactMatch`, `dedupeByPhone` | Camada de dedup compartilhada por webhook, formulário manual e importação CSV — chave canônica é sempre `normalizePhone` (dígitos). |

### 2.2 Banco de dados

| Onde                                                                                                                                                 | O que                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contacts.phone` — [supabase/migrations/001_initial_schema.sql:39](../../supabase/migrations/001_initial_schema.sql#L39)                             | `TEXT NOT NULL`. **Sem CHECK constraint de formato.** Aceita qualquer string.                                                                                                                               |
| `contacts.phone_normalized` — [supabase/migrations/022_contact_phone_dedup.sql:30-32](../../supabase/migrations/022_contact_phone_dedup.sql#L30-L32) | Coluna `GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED`. Sempre dígitos-only, calculada pelo Postgres a partir de `phone` — **nunca deve ser escrita diretamente** (o Postgres rejeita). |
| `idx_contacts_account_phone_normalized` — [022](../../supabase/migrations/022_contact_phone_dedup.sql#L118-L120)                                     | Índice `UNIQUE (account_id, phone_normalized) WHERE phone_normalized <> ''`. É o backstop autoritativo de dedup — qualquer caminho de escrita pode colidir aqui (SQLSTATE 23505) e precisa tratar.          |
| `broadcast_audience_staging.phone` — migração 045                                                                                                    | Sem constraint de formato; alimentado pelo pipeline de `normalize.ts` (já sanitiza antes de gravar, ver §2.4).                                                                                              |
| `whatsapp_config.phone_number_id` — 001/013                                                                                                          | **Não é o número de telefone do contato** — é o ID do número do WhatsApp Business (Meta), não confundir no mapeamento.                                                                                      |
| `evolution_instances.connected_phone` — migração 056                                                                                                 | Número da instância conectada (o WhatsApp do próprio operador, não de um contato) — [src/lib/evolution/instances.ts:131](../../src/lib/evolution/instances.ts#L131).                                        |

### 2.3 Cadastro / edição manual de contato

| Arquivo                                                                                                      | Comportamento                                                                                                                                                                         | Formato gravado                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [src/components/contacts/contact-form.tsx:151-176](../../src/components/contacts/contact-form.tsx#L151-L176) | Grava `phone.trim()` **sem nenhuma sanitização de dígitos**. O usuário digita o que quiser (com máscara, com `+`, com espaços) e isso vai direto pro banco.                           | **Texto bruto, formato livre.** ⚠️ Inconsistente com o resto do sistema. |
| idem, checagem de duplicata (linhas 87-105)                                                                  | Usa `findExistingContact` (que internamente normaliza) para checar duplicidade — então a _detecção_ de duplicata funciona mesmo com o dado bruto, mas o valor gravado continua bruto. | —                                                                        |

### 2.4 Importação de contatos via CSV (tela Contatos → Importar)

| Arquivo                                                                                                      | Comportamento                                                                                                                                                                                     | Formato gravado                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [src/lib/contacts/parse-contact-csv.ts:94-140](../../src/lib/contacts/parse-contact-csv.ts#L94-L140)         | Lê a coluna `phone` do CSV **sem sanitizar** — só faz `trim()` e remove aspas.                                                                                                                    | —                                                                             |
| [src/components/contacts/import-modal.tsx:274-281](../../src/components/contacts/import-modal.tsx#L274-L281) | Insere `row.phone` (valor bruto do CSV) diretamente em `contacts.phone`. Dedup (`dedupeByPhone`/`normalizeKey`) só é usado para decidir quais linhas pular, não para transformar o valor gravado. | **Texto bruto, formato livre.** ⚠️ Mesma inconsistência do formulário manual. |

### 2.5 Webhook de entrada — WhatsApp Cloud API (canal oficial, Meta)

| Arquivo                                                                                                  | Comportamento                                                                                                                                                | Formato gravado                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [src/app/api/whatsapp/webhook/route.ts:562](../../src/app/api/whatsapp/webhook/route.ts#L562)            | `const senderPhone = normalizePhone(message.from);` — o `wa_id` que a Meta manda já sanitizado antes de virar `fromPhone`.                                   | **Dígitos-only, sem `+`.** ✅ Consistente com o padrão canônico. |
| [src/lib/channels/ingest.ts:525-580](../../src/lib/channels/ingest.ts#L525-L580) (`findOrCreateContact`) | Recebe o `phone` já normalizado do tradutor acima e grava direto (`phone` no insert). Trata `isUniqueViolation` (23505) para re-resolver em caso de corrida. | idem                                                             |

### 2.6 Webhook de entrada — WhatsApp QRCode (Evolution/Baileys) — **ainda não implementado**

- O adaptador oficial (`whatsapp-cloud.ts`) tem `normalizeInbound()` lançando erro de propósito — a
  tradução do payload da Meta continua na rota do webhook. Para Evolution, a fase de ingestão (F4 do
  PRD 047) ainda não foi construída: não existe rota de webhook inbound para
  `src/app/api/channels/evolution/**` hoje (apenas CRUD de instância — QR, pareamento, status,
  desconexão — ver [src/app/api/channels/evolution/instances/](../../src/app/api/channels/evolution/instances/)).
- `ingest.ts` já está preparado para receber esse canal: `PROVIDERS_THAT_REDELIVER` inclui
  `'whatsapp_qr'` ([src/lib/channels/ingest.ts:95-97](../../src/lib/channels/ingest.ts#L95-L97)), e
  `event.fromPhone` é um campo genérico de `NormalizedMessage`
  ([src/lib/channels/types.ts:183,239](../../src/lib/channels/types.ts#L183)).
- **⚠️ Ponto de atenção para quando F4 for implementado:** a Evolution/Baileys entrega o remetente
  como `remoteJid` no formato `5511999999999@s.whatsapp.net` (grupos usam `@g.us`; dispositivos
  vinculados podem anexar `:12` antes do `@`). O tradutor desse canal **precisa** extrair só a parte
  numérica antes do `@` (e do `:`) e passar por `normalizePhone`/`sanitizePhoneForMeta` antes de
  preencher `fromPhone` — do contrário `contacts.phone` passa a receber um JID inteiro em vez de um
  número. Nenhum código faz isso ainda porque a rota não existe; é a primeira coisa a acertar
  quando F4 começar.

### 2.7 Pareamento de instância Evolution por telefone (não é contato — é o número do operador)

| Arquivo                                                                                                                                        | Comportamento                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/app/api/channels/evolution/instances/[id]/pair/route.ts:35-44](../../src/app/api/channels/evolution/instances/[id]/pair/route.ts#L35-L44) | Valida `^\d{10,15}$` (dígitos, 10 a 15 caracteres, sem `+`) antes de chamar `pairInstanceByPhone`. Mensagem de erro já documenta o formato esperado: "DDI+DDD+number, e.g. 5511999999999". |

### 2.8 API pública `/api/v1/contacts`

| Arquivo                                                                                                  | Comportamento                                                                                                                                                                                                                                                                   | Formato gravado                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [src/lib/api/v1/contacts.ts:109-151](../../src/lib/api/v1/contacts.ts#L109-L151) (`findOrCreateContact`) | `sanitizePhoneForMeta(input.phone)` → valida com `isValidE164` (rejeita com 400 se inválido, mensagem cita formato E.164 com exemplo `+14155550123` — **mensagem de erro um pouco inconsistente com o dado gravado**, ver §3) → grava o valor **já sanitizado** (dígitos-only). | **Dígitos-only, sem `+`.** ✅ Consistente. |

> ⚠️ **Decisão registrada (SPEC 050, D-5, 2026-08-13): a API pública NÃO valida DDD/celular×fixo
> brasileiro, de propósito — nem antes da SPEC 050, nem depois.** A [SPEC
> 050](../spec-050-padronizacao-telefone-br.md) trouxe a validação regional brasileira (DDD
> Anatel, 9º dígito) para o formulário manual e a importação CSV de contatos
> (`src/lib/phone/br.ts`), mas deliberadamente **não** a ligou aqui. Ligar quebraria integrações
> existentes que hoje criam contato com qualquer número tecnicamente E.164 — a tabela acima
> continua sendo a descrição correta do comportamento da API depois da SPEC 050, não só de
> antes. Consequência aceita: é possível criar, **pela API**, um contato com DDD brasileiro
> inexistente que o formulário recusaria. Revisitar essa decisão só faz sentido quando houver um
> consumidor real reclamando de dado sujo vindo da API — não antes.

### 2.9 Disparos em massa (broadcasts) — audiência via planilha/CSV/Google Sheets

| Arquivo                                                                                                                                                                                  | Comportamento                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/audience/parse-csv.ts](../../src/lib/audience/parse-csv.ts), [parse-xlsx.ts](../../src/lib/audience/parse-xlsx.ts), [google-sheets.ts](../../src/lib/audience/google-sheets.ts) | Extraem a coluna de telefone **crua** (aceitam cabeçalhos alternativos: `phone`, `telefone`, `celular`, `whatsapp`, `numero`).                                                                                                                 |
| [src/lib/audience/normalize.ts:59-132](../../src/lib/audience/normalize.ts#L59-L132) (`createAudienceNormalizer`)                                                                        | Pipeline fixo: `sanitizePhoneForMeta` → `isValidE164` → dedup por `normalizeKey`. Linhas inválidas são reportadas linha a linha (`invalid_phone`), nunca descartadas silenciosamente.                                                          |
| [src/lib/audience/resolve.ts:180-227](../../src/lib/audience/resolve.ts#L180-L227) e [stage.ts:198-208](../../src/lib/audience/stage.ts#L198-L208)                                       | Materializam contatos novos a partir da audiência normalizada — o `phone` gravado em `contacts` já passou pelo pipeline acima.                                                                                                                 | **Dígitos-only, sem `+`.** ✅ Consistente. |
| [src/lib/broadcasts/parse-input.ts:100-116](../../src/lib/broadcasts/parse-input.ts#L100-L116)                                                                                           | Valida a forma do JSON `csvContacts` vindo da API de disparo (`POST /api/broadcasts/send`), mas **não sanitiza o telefone em si** — confia que o valor já passou pelo pipeline de `normalize.ts` do lado do cliente/rota que montou o payload. |

### 2.10 Ingestão externa via n8n (fora do app Next.js)

| Onde                                                                                                                                                | Comportamento                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [n8n_automation/workflow_contact_ingestion.json](../../n8n_automation/workflow_contact_ingestion.json) — endpoint `POST /webhook/contact-ingestion` | Aceita **qualquer formato BR** (com máscara, com/sem `+55`, com/sem 9º dígito) e faz validação completa (67 DDDs Anatel, regra do 9º dígito celular/fixo) antes de normalizar.                                                                                                                                          |
| [n8n_automation/SPEC_contact_ingestion_workflow.md §"Formato do telefone"](../../n8n_automation/SPEC_contact_ingestion_workflow.md#L60-L78)         | Documenta a decisão de projeto: gravar `phone` = E.164 sem `+` (`5519992496598`), justamente para casar com `phone_normalized` gerada pelo Postgres. **É a referência mais completa de validação BR que existe no projeto inteiro** — vale usar como base se o app Next.js decidir importar validação de DDD/9º dígito. | **Dígitos-only, sem `+`.** ✅ Consistente — e é o caminho com a validação BR mais rigorosa. |

### 2.11 Envio (consumo do valor já gravado)

| Arquivo                                                                                                                                                | Comportamento                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/whatsapp/meta-api.ts](../../src/lib/whatsapp/meta-api.ts) (`sendTextMessage`, `sendTemplateMessage`, etc.)                                    | Espera `to` já sanitizado (dígitos-only) — não sanitiza internamente. Confia no chamador.                                                            |
| [src/lib/whatsapp/broadcast-dispatch.ts](../../src/lib/whatsapp/broadcast-dispatch.ts) / [broadcast-core.ts](../../src/lib/whatsapp/broadcast-core.ts) | Usa `phoneVariants` para retentativa com/sem tronco `0` quando a Meta rejeita por sandbox (131030) — só faz sentido porque a base já é dígitos-only. |

---

## 3. Inconsistências encontradas (o que precisa ser corrigido)

| #   | Caminho                                                                                                                   | Problema                                                                                                                                                                                                              | Impacto                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Formulário manual** ([contact-form.tsx:151-176](../../src/components/contacts/contact-form.tsx#L151-L176))              | Grava `phone.trim()` sem sanitizar dígitos. Um contato criado aqui pode ficar com `phone = "+55 (19) 9 9249-6598"` enquanto todo o resto do sistema grava `"5519992496598"`.                                          | Envio quebra se algum caminho de envio não sanitizar antes de mandar pro `meta-api.ts` (hoje `broadcast-dispatch`/`send-message` fazem isso, mas é uma dependência implícita — um novo caminho de envio que esqueça de sanitizar falha silenciosamente ou manda para o número errado). Também polui a UI, que exibe o valor cru. |
| 2   | **Importação CSV de contatos** ([import-modal.tsx:274-281](../../src/components/contacts/import-modal.tsx#L274-L281))     | Mesmo problema: grava `row.phone` bruto do arquivo, só usa a versão normalizada para decidir duplicidade, não para o valor persistido.                                                                                | Mesma classe de risco do item 1, agravada porque CSVs de clientes tendem a vir com máscara BR completa.                                                                                                                                                                                                                          |
| 3   | Mensagem de erro da API pública ([contacts.ts:117-120](../../src/lib/api/v1/contacts.ts#L117-L120))                       | Diz "E.164 format (e.g. +14155550123)" mas o valor efetivamente gravado é **sem** `+`. Não é bug funcional, mas confunde quem integra pela API.                                                                       | Baixo — só clareza de documentação/mensagem.                                                                                                                                                                                                                                                                                     |
| 4   | **Canal QRCode (Evolution) — inbound ainda não implementado**                                                             | Quando F4 for construído, é preciso lembrar de extrair o número do `remoteJid` (`@s.whatsapp.net` / `@g.us` / sufixo `:device`) antes de preencher `fromPhone`. Nenhum código faz isso hoje porque a rota não existe. | Alto se esquecido — contamina `contacts.phone` com um JID inteiro em vez de um número.                                                                                                                                                                                                                                           |
| 5   | **Sem validação de formato no banco** ([001_initial_schema.sql:39](../../supabase/migrations/001_initial_schema.sql#L39)) | `contacts.phone` é `TEXT NOT NULL` sem CHECK. Nada impede, hoje, que qualquer caminho futuro grave lixo.                                                                                                              | A padronização de código (itens 1–2) não é reforçada pelo schema — pode voltar a divergir.                                                                                                                                                                                                                                       |
| 6   | **Sem formatador de exibição**                                                                                            | Não existe função de máscara para exibir o número (ex.: `+55 19 99249-6598`) em nenhum componente de UI. Toda tela mostra `contact.phone` cru.                                                                        | Se a padronização gravar tudo como dígitos-only, a UX de leitura piora (`5519992496598` é mais difícil de ler que `+55 19 99249-6598`) a menos que um formatador de exibição seja adicionado junto.                                                                                                                              |
| 7   | **Sem validação BR-específica no app** (`isValidE164` só valida tamanho/prefixo)                                          | O n8n valida DDD Anatel + regra do 9º dígito; o app Next.js não. Dois números "tecnicamente E.164" mas foneticamente impossíveis no Brasil (ex.: DDD inexistente) passam batido no app.                               | Médio — não é dedup nem envio, é qualidade do dado. Decisão de produto: vale a pena importar essa validação do n8n para o app?                                                                                                                                                                                                   |

---

## 4. Plano de padronização sugerido (para execução por um LLM)

Ordem recomendada, do menor para o maior raio de impacto:

1. **Sanitizar na gravação dos dois pontos que ainda não sanitizam** (itens 1 e 2 da tabela acima):
   - `contact-form.tsx`: aplicar `sanitizePhoneForMeta` (ou `normalizePhone`, são idênticas) sobre
     `phone` antes de qualquer `insert`/`update`, e validar com `isValidE164` antes de enviar,
     devolvendo o mesmo erro amigável que a checagem de duplicata já usa em caso de número vazio.
   - `import-modal.tsx` (via `parse-contact-csv.ts` ou no próprio import): sanitizar `row.phone`
     assim que lido do CSV, e reportar linhas com telefone inválido em vez de deixá-las passar cru
     (mesma filosofia de `audience/normalize.ts`, que já resolve exatamente esse problema para o
     CSV de disparo — reaproveitar o padrão, não duplicar a lógica).
   - Ambos os arquivos já importam `dedupeByPhone`/`findExistingContact`/`isUniqueViolation` de
     `@/lib/contacts/dedupe` — a mudança é local, não estrutural.
2. **Corrigir a mensagem de erro** da API pública (§3 item 3) para refletir o formato real gravado.
3. **Migração de dados existentes**: qualquer `contacts.phone` já gravado fora do padrão precisa de
   um `UPDATE contacts SET phone = phone_normalized WHERE phone <> phone_normalized` — mas
   **cuidado**: isso pode colidir com o índice único `(account_id, phone_normalized)` se dois
   registros diferentes normalizarem para o mesmo valor (ex.: um com `+`, outro sem, do mesmo
   número). Rodar `merge_duplicate_contacts()` (migração 022) de novo antes do `UPDATE`, ou tratar
   colisões manualmente. **Confirmar com o mantenedor antes de aplicar em qualquer um dos três
   projetos Supabase (vn/rs/jh)** — ver `AGENTS.md`.
4. **(Opcional, decisão de produto)** Adicionar CHECK constraint em `contacts.phone` garantindo
   dígitos-only (`phone ~ '^[1-9]\d{6,14}$'` ou similar) — fecha a lacuna do item 5. Exige a
   migração de dados do passo 3 concluída primeiro, senão quebra em produção.
5. **(Opcional, decisão de produto)** Criar um formatador de exibição BR (`formatPhoneBR` ou
   similar) e aplicá-lo nos componentes que hoje mostram `contact.phone` cru, para compensar a
   perda de legibilidade do dígitos-only puro.
6. **(Opcional, decisão de produto)** Avaliar se vale portar a validação de DDD Anatel + 9º dígito
   do n8n ([SPEC_contact_ingestion_workflow.md](../../n8n_automation/SPEC_contact_ingestion_workflow.md))
   para uma função compartilhada em `src/lib/whatsapp/phone-utils.ts`, para uso tanto no formulário
   quanto na importação — hoje essa lógica só existe fora do app (n8n), duplicada se for reescrita.
7. **Quando o F4 (inbound Evolution/QRCode) for implementado**: garantir que o tradutor do payload
   Baileys extraia o número do `remoteJid` (removendo `@s.whatsapp.net`/`@g.us` e qualquer sufixo
   `:device`) e aplique `normalizePhone` antes de preencher `NormalizedMessage.fromPhone` — sem
   isso, o item 4 da tabela de inconsistências se materializa em produção.

### Testes a atualizar/criar junto com qualquer mudança de código

- `src/components/contacts/contact-form.tsx` não tem teste dedicado hoje (é componente de UI) —
  qualquer sanitização adicionada deve ser coberta pelos testes de `dedupe.ts`/`phone-utils.ts` já
  existentes, mais um teste manual do formulário.
- `src/lib/contacts/parse-contact-csv.test.ts` já existe — estender com casos de telefone com
  máscara/`+`/espaços para confirmar que a sanitização entra no lugar certo.
- `src/lib/whatsapp/phone-utils.test.ts` e `src/lib/contacts/dedupe.test.ts` já cobrem os
  utilitários centrais — reaproveitar, não recriar.

---

## 5. Resumo executivo (uma tabela)

| Caminho de entrada                                      | Formato gravado hoje                              | Está no padrão canônico?              |
| ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Formulário manual (Contatos → Novo)                     | Texto livre, como digitado                        | ❌ Não                                |
| Importação CSV (Contatos → Importar)                    | Texto livre, como veio do arquivo                 | ❌ Não                                |
| Webhook WhatsApp Cloud (Meta) — mensagem recebida       | Dígitos-only, sem `+`                             | ✅ Sim                                |
| API pública `POST /api/v1/contacts`                     | Dígitos-only, sem `+`                             | ✅ Sim                                |
| Disparo em massa — audiência CSV/Sheets/Excel           | Dígitos-only, sem `+`                             | ✅ Sim                                |
| Pareamento de instância Evolution (número do operador)  | Dígitos-only, sem `+` (validado na borda)         | ✅ Sim                                |
| Ingestão n8n (`/webhook/contact-ingestion`)             | Dígitos-only, sem `+` (com validação BR completa) | ✅ Sim — é a referência mais rigorosa |
| Webhook WhatsApp QRCode (Evolution) — mensagem recebida | **Não implementado ainda (F4)**                   | ⚠️ Ponto de atenção futuro            |

**Conclusão:** o padrão de fato já existe e está bem estabelecido (`sanitizePhoneForMeta` /
`normalizePhone`, dígitos-only sem `+`) — a tarefa de padronização é majoritariamente **fechar os
dois pontos que ainda escrevem texto livre** (formulário manual e importação CSV de contatos), não
inventar um formato novo.
