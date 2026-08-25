# SPEC 057 — Audiência persistente (tags, e-mail, empresa) e rastreabilidade da campanha no inbox

**Status:** Pronta para implementação
**Data:** 2026-08-21
**Autor da SPEC:** arquitetura (Opus 5), a partir do prompt técnico de Bruno Pelatieri
**Implementação recomendada:** Sonnet 5
**Depende de:** SPEC 044 (audiência multiformato), SPEC 050 (telefone BR), SPEC 052 (importação multiformato), migração 003 (correlação wamid)
**Migração:** `066_broadcast_message_linking.sql` — **não 065** (065 está ocupada por `065_inbound_contact_webhook.sql`)

---

## 0. Aviso de leitura — o draft partia de premissas que o código contradiz

O prompt técnico que originou esta SPEC descreve um sistema diferente do que está em `main` (482942f). Sete premissas foram verificadas contra o código e **quatro são falsas**. A SPEC abaixo é escrita sobre o código real; quem for implementar deve ler esta seção antes de qualquer outra, porque ela invalida cerca de metade do plano original.

| # | Premissa do draft | Realidade verificada | Consequência |
|---|---|---|---|
| **A-1** | Migração nova é a `065` | `supabase/migrations/065_inbound_contact_webhook.sql` já existe | Numerar **066**. Aplicar a 065 do draft sobrescreveria o webhook da SPEC 055 |
| **A-2** | "Contatos importados na audiência **não entram** em `contacts`, ficam em `staged_contacts`" | **Falso.** `resolveAudienceContacts` → `upsertImportedContacts` (`src/lib/audience/resolve.ts:160`) materializa em `contacts` no **envio**. A tabela `staged_contacts` não existe; é `broadcast_audience_staging` (migração 045) | O problema real não é "contato não existe" — é **quais campos se perdem** (§1) |
| **A-3** | `messages` tem `contact_id`, `direction`, `body`, `metadata`, `created_by` | **Falso.** Tem `conversation_id`, `sender_type` ('customer'/'agent'/'bot'), `content_text`, `template_name`, `message_id`, `template_preview`, `status`. Sem `metadata`, sem `created_by` (`supabase/migrations/001_initial_schema.sql:163`) | Todo o SQL e todos os payloads do draft para `messages` estão errados. D-5 reescrita |
| **A-4** | Não há vínculo entre broadcast e contato | **Falso.** `broadcast_recipients` tem `broadcast_id`, `contact_id`, `whatsapp_message_id` (UNIQUE), `status` com `'replied'`, `replied_at`, e trigger de agregação (migração 003) | Adicionar `broadcast_source_id` em `messages` criaria **segunda fonte de verdade** concorrente. D-3 reescrita |
| **A-5** | A audiência valida com `isValidE164` (validação "morna") | **Falso.** `createRowNormalizer` já usa `normalizeContactPhone` como padrão desde a SPEC 052 D-2 (`src/lib/audience/normalize.ts`) | **F1 do draft é no-op.** Nenhuma mudança de contrato de validação acontece nesta SPEC |
| **A-6** | Criar `src/lib/audience/resolve-audience-tags.ts` | `resolveImportTagIds` + `assignImportedContactTags` já existem, genéricos, com 3 consumidores (`src/lib/contacts/resolve-import-tags.ts`) | **Reusar, não duplicar.** F3 do draft vira integração, não módulo novo |
| **A-7** | Aviso vai no "Step 3 (triagem)", `step3-*.tsx` | `step3-personalize.tsx` é **personalização**; a triagem é rota própria `/broadcasts/new/[draftId]/triage` com componentes em `src/components/broadcasts/audience/triage/` | F6 muda de arquivo-alvo |

**A descoberta que redefine a SPEC (A-8):** o disparo **nunca cria `conversations` nem `messages`**. `dispatchBroadcast` grava apenas `broadcast_recipients` (`src/lib/whatsapp/broadcast-dispatch.ts:594`) e carimba o wamid (`src/lib/whatsapp/broadcast-core.ts:408`). Quando o cliente responde, `findOrCreateConversation` abre uma conversa cujo **primeiro item é a resposta**. É exatamente essa a "conversa órfã" relatada — e a causa não é falta de contato, é **falta da mensagem enviada no histórico**.

---

## 1. Problema

Duas falhas independentes, hoje tratadas como uma só:

1. **Perda de dados na importação de audiência.** `upsertImportedContacts` grava somente `phone` e `name`. As colunas `email` e `company` — lidas da planilha, validadas e já persistidas em `broadcast_audience_staging.email/company` — são **descartadas** na materialização. As `tag_names`, idem: ficam na staging, viram filtro de triagem, e nunca chegam a `contact_tags`. O mesmo arquivo importado por Configurações → Contatos preserva os cinco campos; importado pelo passo 2 do disparo, preserva dois.

2. **Ausência de contexto na resposta.** Sem `messages` outbound, o atendente abre a conversa e vê a pergunta do cliente sem a pergunta que o CRM fez. `broadcast_recipients` sabe qual campanha e qual wamid, mas nada disso alcança o inbox.

### 1.1 Escopo

**Dentro:** persistir `email`/`company`/tags na materialização da audiência; hidratar a conversa com a mensagem de template originada por broadcast; expor a origem da campanha na UI do inbox; avisar o usuário, antes de disparar, que os contatos serão salvos.

**Fora:** alterar validação de telefone (já feita, A-5); mudar o modelo de triagem; multicanal (Evolution segue o mesmo caminho de ingestão, herda de graça); retroatividade sobre disparos já enviados (§9.3).

---

## 2. Decisões ratificadas (D-1 a D-6) e novas (D-7, D-8)

### D-1 — Criação de tags por papel: **RATIFICADA com correção de vocabulário**

Aprovada a Opção A (admin+ cria, demais ignoram com aviso), com três correções:

- O gate correto é **`canEditSettings(role)`** de `src/lib/auth/roles.ts:79`, que é o mesmo que o import de contatos usa (`src/components/contacts/import-modal.tsx:352`). Não escrever um `role === 'admin' || role === 'owner'` novo.
- Existem **quatro** papéis, não três: `owner | admin | agent | viewer`. O draft omite `viewer` em todas as assinaturas. `viewer` não dispara broadcast (`canSendMessages` é falso) e portanto nem chega aqui — mas o tipo tem de ser `AccountRole`, não a união de três literais.
- Não implementar `resolveAudienceTags`. `resolveImportTagIds({ canCreateTags })` já tem exatamente essa semântica, devolve `skippedNames` e `createdNames`, e resolve tudo em **uma** ida ao banco (o comentário do próprio arquivo explica por que uma segunda leitura seria uma corrida).

### D-2 — Dedupe por `phone_normalized`: **RATIFICADA com escopo reduzido**

Upsert lógico confirmado. Correções sobre o draft:

- O lookup **já** é por `phone_normalized` com escopo de conta e já trata `23505` como corrida (não como falha). Isso não precisa ser reescrito, apenas estendido.
- **A atualização de contato existente é `COALESCE`, não sobrescrita.** O draft propõe `UPDATE name, email, company` incondicional; isso apaga um e-mail cadastrado à mão quando a planilha traz a célula vazia. Regra: **preenche campo nulo, nunca substitui campo preenchido.** Corrigir dado existente continua sendo trabalho da tela de contato.
- Consequência: `updated` nas estatísticas significa "campos vazios preenchidos", e um reimport idêntico devolve `updated: 0` — idempotência real, não idempotência aparente.

### D-3 — Identificador do vínculo: **REFORMULADA**

O draft propõe `messages.broadcast_source_id`. A crítica é que `broadcast_recipients` **já** é a tabela de vínculo (A-4), com UNIQUE em wamid e trigger de agregação; uma segunda coluna com a mesma semântica pode divergir dela e não há quem reconcilie.

**Decisão:** o vínculo canônico permanece `broadcast_recipients`. A coluna nova em `messages` é uma **desnormalização de leitura explícita**, com nome que não compete com a canônica:

- `messages.broadcast_id UUID REFERENCES broadcasts(id) ON DELETE SET NULL`

Ela existe para o inbox resolver "de qual campanha veio esta bolha" em um join direto, em vez de `messages.message_id = broadcast_recipients.whatsapp_message_id` a cada render. É **derivável** (o wamid reconcilia), portanto uma divergência é reparável — o critério que a torna aceitável.

### D-4 — Timing da criação: **REFORMULADA — hidratação preguiçosa**

As três opções do draft (stage / before send / after send) compartilham um defeito que ele não considera: **todas criam uma `conversations` por destinatário**. Um disparo de 5.000 contatos passa a produzir 5.000 conversas abertas no inbox, das quais tipicamente 3–8% respondem. Isso não é um efeito colateral — é a destruição da caixa de entrada, e nenhum item do plano de teste do draft o detectaria.

**Decisão: hidratar na resposta (lazy).** O disparo continua gravando só `broadcast_recipients`. Quando um inbound chega e `flagBroadcastReplyIfAny` (`src/lib/channels/ingest.ts:822`) **já identifica** o `broadcast_recipients` correspondente, a mesma passagem insere retroativamente a mensagem de template na conversa recém-criada, com `created_at = recipient.sent_at`.

| Critério | Eager (draft) | **Lazy (decidido)** |
|---|---|---|
| Linhas escritas por disparo de 5.000 | 10.000 (5k conv + 5k msg) | 0 |
| Conversas abertas no inbox | 5.000 | apenas quem respondeu |
| Custo | O(audiência) | O(respostas) |
| Contexto na resposta | sim | sim |
| Histórico de quem **não** respondeu no inbox | sim | não — fica em `broadcast_recipients` e na tela da campanha |

O trade-off aceito é a última linha, e ele é reversível: migrar para eager depois é mudar o ponto de chamada, sem alterar schema. O caminho inverso exigiria apagar mensagens já gravadas.

A ordenação funciona porque `messages` é ordenada por `created_at`: a bolha do template carrega o timestamp do envio e aparece **acima** da resposta, mesmo tendo sido inserida depois.

### D-5 — Schema de `messages`: **RATIFICADA na forma (colunas explícitas), REJEITADA no conteúdo**

Colunas explícitas confirmadas sobre JSONB (a justificativa do draft — índice e custo de query — está correta, e `messages` sequer tem `metadata`, A-3).

**`broadcast_imported` é rejeitada.** Três razões: (1) a informação não é sobre a mensagem, é sobre a origem do contato, e portanto seria um atributo desalinhado da entidade; (2) `broadcast_audience_staging` já registra `existing_contact_id IS NULL`, que é exatamente "foi criado por esta importação", com mais precisão e sem coluna nova; (3) o filtro que ela serviria — "respostas a este broadcast" — é atendido por `broadcast_id IS NOT NULL` sozinho.

Fica **uma** coluna: `messages.broadcast_id`.

### D-6 — Onde validar permissão: **RATIFICADA com ponto adicional**

Validação antecipada no stage, confirmada. Mas o draft valida no lugar errado para a criação de contatos: propõe rejeitar `agent` com 403 em `/audience/stage`. Isso **quebraria o produto** — hoje um `agent` dispara por planilha e os contatos são materializados no envio; um 403 no stage regride uma capacidade existente sem que a SPEC peça isso.

Regra final:

| Ponto | Verificação | Falha |
|---|---|---|
| `POST /api/broadcasts/audience/stage` | `canSendMessages(role)` — já é pré-requisito do wizard | 403 |
| Criação de **tags** (materialização) | `canEditSettings(role)` | não falha: `skippedNames` + aviso |
| Criação de **contatos** (materialização) | nenhuma além da RLS de `contacts` | RLS decide |
| `POST /api/broadcasts/send` | inalterado | inalterado |

### D-7 (nova) — Materialização move-se do envio para o stage?

**Não.** Manter em `resolveAudienceContacts` (envio). Materializar no stage gravaria contatos que a triagem ainda vai descartar — o usuário analisa 5.000, seleciona 800, e ficaria com 5.000 na base. A triagem existe precisamente para ser o ponto de decisão; escrever antes dela anula seu propósito. As estatísticas exibidas no stage passam a ser **projeção** ("2 serão criados"), não fato consumado — e o texto de UI (F6) tem de dizer isso no futuro do indicativo.

### D-8 (nova) — Como a bolha hidratada renderiza sem `template_preview`?

`messages.template_preview` (migração 037) é o que o inbox usa para desenhar a bolha de template com botões. O disparo não o produz hoje. Hidratar com `content_type='template'` e `template_preview` nulo produziria uma bolha vazia.

**Decisão:** a hidratação grava `template_name` e reaproveita o **construtor já existente** de preview usado por `send-message.ts`; se a resolução falhar (template removido da Meta, componentes indisponíveis), grava `content_text` com o corpo resolvido e `template_preview` nulo — bolha simples, legível, sem botões. Nunca uma bolha vazia. Isto é requisito de aceitação, não detalhe de implementação.

---

## 3. Fluxo (corrigido)

```
PASSO 2 — step2-select-audience.tsx
  planilha → useSpreadsheetParser → createRowNormalizer
             (normalizeContactPhone, SPEC 050 — JÁ É ASSIM, A-5)
  [Analisar audiência] → POST /api/broadcasts/audience/stage
         │
         ▼
STAGE — stageAudience()                              (LEITURA + staging)
  cria broadcasts(status='draft') + broadcast_audience_staging
  cruza phone_normalized com contacts → existing_contact_id
  ┌ NOVO: projeta e devolve { willCreate, willUpdate, tagsToCreate,
  └        tagsSkipped }  — projeção, não fato (D-7)
         │
         ▼
TRIAGEM — /broadcasts/new/[draftId]/triage           (A-7: rota própria)
  ┌ NOVO: aviso "estes contatos serão salvos na sua base"
  └        + etiquetas que serão criadas / ignoradas
         │
         ▼
PASSOS 3–4 — personalize → schedule-send → POST /api/broadcasts/send
         │
         ▼
ENVIO — resolveAudienceContacts → upsertImportedContacts   (ESCRITA)
  ┌ MUDA: grava email + company (COALESCE, D-2)
  ├ NOVO: resolveImportTagIds(canCreateTags) + assignImportedContactTags
  └ inalterado: broadcast_recipients + wamid
         │
         ▼
RESPOSTA — ingest.ts → findOrCreateConversation → messages(inbound)
  flagBroadcastReplyIfAny() já acha o broadcast_recipients
  ┌ NOVO: hidrata a conversa com a mensagem de template retroativa
  │        (created_at = recipient.sent_at, broadcast_id = ..., D-4)
  └ NOVO: inbox exibe "Campanha X • enviada em DD/MM"
```

---

## 4. Migração `066_broadcast_message_linking.sql`

```sql
-- ============================================================
-- 066_broadcast_message_linking.sql — SPEC 057
--
-- messages.broadcast_id: desnormalização de LEITURA (SPEC 057 D-3).
-- A fonte de verdade do vínculo continua sendo broadcast_recipients
-- (migração 003, UNIQUE em whatsapp_message_id). Esta coluna existe
-- para o inbox resolver a origem da bolha em um join direto, e é
-- reconciliável por messages.message_id = recipients.whatsapp_message_id.
--
-- ON DELETE SET NULL: apagar uma campanha nunca pode apagar o histórico
-- de conversa do cliente.
--
-- Idempotente.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS broadcast_id UUID
    REFERENCES broadcasts(id) ON DELETE SET NULL;

-- Parcial: a esmagadora maioria das mensagens não vem de broadcast, e
-- um índice cheio de NULLs paga escrita em todo inbound sem servir
-- nenhuma leitura.
CREATE INDEX IF NOT EXISTS idx_messages_broadcast
  ON messages (broadcast_id)
  WHERE broadcast_id IS NOT NULL;

-- Guarda de coerência: só mensagem de saída pode ter origem em
-- campanha. Sem isto, um bug de hidratação carimbaria a resposta do
-- cliente como se ela fosse a campanha.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_broadcast_outbound_only;
ALTER TABLE messages
  ADD CONSTRAINT messages_broadcast_outbound_only
  CHECK (broadcast_id IS NULL OR sender_type <> 'customer')
  NOT VALID;   -- NOT VALID: não varre linhas antigas (todas têm NULL);
               -- vale para toda escrita nova. Validar depois, se desejado.

COMMENT ON COLUMN messages.broadcast_id IS
  'Campanha que originou esta mensagem de saída (SPEC 057 D-3). Desnormalização de leitura; o vínculo canônico é broadcast_recipients.';
```

**O que a migração deliberadamente NÃO faz:**

- Não cria `broadcast_imported` (D-5).
- Não toca em RLS: `messages` herda de `conversations` via policy existente, e a coluna nova não muda quem enxerga a linha.
- Não cria índice em `(contact_id, ...)`: `messages` **não tem** `contact_id` (A-3).
- Não altera `broadcast_recipients`: já tem tudo o que a SPEC precisa.

**Aplicação:** `vn` primeiro (dev). `rs` e `jh` **somente após confirmação explícita de Bruno** — três projetos Supabase, regra do AGENTS.md.

---

## 5. Fases

Dependências: **F1 → F2 → {F3, F4} → F5 → F6**; F7 em paralelo a partir de F3; F8 fecha.

| Fase | Entrega | Arquivos | Critério de conclusão |
|---|---|---|---|
| **F1** | Migração 066 aplicada em `vn` | `supabase/migrations/066_broadcast_message_linking.sql` | `list_migrations` mostra 066; `messages.broadcast_id` existe; reaplicar não erra |
| **F2** | `upsertImportedContacts` persiste `email`/`company` com COALESCE | `src/lib/audience/resolve.ts` | Novo contato recebe os 4 campos; contato existente com e-mail preenchido **não** é sobrescrito por célula vazia nem por valor diferente; teste cobre os dois |
| **F3** | Tags da planilha materializadas | `src/lib/audience/resolve.ts` (reusa `resolve-import-tags.ts`) | admin+ cria tags ausentes e vincula; `agent` vincula só as existentes e devolve `skippedNames`; reimport não duplica `contact_tags` |
| **F4** | Projeção de estatísticas no stage | `src/lib/audience/stage.ts`, `src/app/api/broadcasts/audience/stage/route.ts` | `StageAudienceSummary` ganha `willCreate`/`willUpdate`/`tagsToCreate`/`tagsSkipped`; nenhuma escrita em `contacts`/`tags` no stage (D-7) |
| **F5** | Hidratação da conversa na resposta | `src/lib/channels/ingest.ts` (+ helper novo em `src/lib/broadcasts/`) | Resposta a um disparo produz 2 linhas: template (`created_at = sent_at`, `broadcast_id` setado) e a resposta; sem resposta, 0 linhas; falha na hidratação **não** derruba o inbound (best-effort, como o `flagBroadcastReply` vizinho) |
| **F6** | UI: aviso na triagem + origem no inbox | `src/components/broadcasts/audience/triage/*`, componentes do inbox | Aviso no futuro ("serão salvos"); banner de origem com nome da campanha e data; legível em tema claro e escuro |
| **F7** | i18n | `messages/en.json`, `messages/pt-BR.json` | `npm run i18n:check` verde |
| **F8** | Docs + validação completa | `AGENTS.md`, esta SPEC | Suíte completa verde; testes manuais §7 executados |

---

## 6. Riscos

Os quatro do draft, mais nove que ele não previu. Ordenados por severidade.

| # | Risco | Por que é real | Mitigação |
|---|---|---|---|
| **R-1** | **Inundação do inbox** | Materialização eager cria 1 conversa por destinatário; 5.000 conversas abertas tornam o inbox inutilizável e nenhum teste do draft pegaria isso | D-4 (lazy). Se algum dia migrar para eager, `conversations.status` precisa nascer fora de `open` |
| **R-2** | **Sobrescrita silenciosa de dados curados** | `UPDATE name/email/company` incondicional apaga e-mail digitado à mão quando a planilha traz célula vazia; a perda é invisível e não tem desfazer | D-2: COALESCE. Teste dedicado (§7 item 2) |
| **R-3** | **Migração numerada 065** | Colidiria com `065_inbound_contact_webhook.sql` (SPEC 055); em repositório sem CI, ninguém barra | A-1: numerar 066. Conferir `ls supabase/migrations/` antes de criar |
| **R-4** | **Poluição de taxonomia por planilha suja** | Uma coluna `tags` livre em arquivo de 5.000 linhas pode gerar centenas de tags por erro de digitação ("vip", "VIP ", "vips"); `resolveImportTagIds` casa case-insensitive mas não corrige typo | Teto de tags **novas** por importação (sugerido: 50); acima disso, materializa contatos, ignora as excedentes e reporta. Decisão de produto — confirmar valor com Bruno |
| **R-5** | **Escrita síncrona longa no envio** | F2+F3 adicionam lookups de tag e writes de `contact_tags` ao caminho de envio, que já é o mais lento; 5.000 × N tags pode estourar o timeout da rota | `assignImportedContactTags` já chunka de 100. Resolver **todos** os nomes de tag em uma chamada antes do loop (é como `resolveImportTagIds` foi desenhada), nunca por contato — o pseudocódigo do draft chama dentro do `for`, o que seria N round-trips |
| **R-6** | **Bolha de template vazia** | `template_preview` nulo em `content_type='template'` renderiza bolha sem conteúdo | D-8: fallback para `content_text`; nunca bolha vazia |
| **R-7** | **Atribuição errada da campanha** | `flagBroadcastReplyIfAny` usa "o recipient mais recente não respondido". Quem recebeu duas campanhas em 24h e responde uma vez é atribuído à mais recente, que pode não ser a que motivou a resposta | Herdado, não introduzido. A hidratação **usa a mesma** heurística — documentar no banner como "campanha mais recente", e não afirmar causalidade. Melhoria futura: correlacionar por `context.id` do inbound, que a Meta envia quando o cliente responde citando |
| **R-8** | **Duplicação de bolha em replay de webhook** | Meta reentrega webhooks; duas entregas do mesmo inbound hidratariam duas vezes | Guarda por `message_id` (wamid do recipient) antes de inserir — `messages.message_id` já é indexado |
| **R-9** | **`viewer` fora dos tipos** | Assinaturas com `'owner' \| 'admin' \| 'agent'` quebram no `typecheck` ou forçam cast | Usar `AccountRole` em toda assinatura nova (D-1) |
| **R-10** | **RLS bloqueando a hidratação** | `messages` tem policy de INSERT permissiva para service role, mas a leitura é via `conversations.user_id`. Hidratar com o cliente errado grava linha invisível | Usar o mesmo cliente que `ingest.ts` já usa no inbound; não introduzir cliente novo |
| **R-11** | **Corrida entre materialização e resposta** | Cliente responde antes do fan-out terminar; a hidratação não acha `sent_at` ainda | Best-effort: sem `sent_at`, não hidrata. A resposta continua chegando — perde-se o banner, não a mensagem |
| **R-12** | **Contadores de campanha divergindo** | `broadcasts.*_count` são de propriedade do trigger da 003. Qualquer escrita manual é sobrescrita | Não tocar nos contadores. F5 escreve só em `messages` |
| **R-13** | **Regressão silenciosa em `agent`** | Um 403 no stage para não-admin (como o draft propõe) removeria capacidade existente | D-6: gate é `canSendMessages`, e tags degradam em aviso |

---

## 7. Testes

### 7.1 Unitários (Vitest, co-locados)

| Arquivo | Casos |
|---|---|
| `src/lib/audience/resolve.test.ts` (estender) | contato novo grava 4 campos; existente com e-mail preenchido não é sobrescrito por vazio; nem por valor diferente; `company` vazia não apaga; ordem do arquivo preservada; `23505` continua tratado como corrida |
| `src/lib/audience/resolve.test.ts` (tags) | admin+ cria ausentes e vincula; `agent` vincula existentes e devolve `skippedNames`; reimport não duplica `contact_tags`; **resolução de tags acontece uma vez, não por contato** (R-5) |
| `src/lib/audience/stage.test.ts` (estender) | projeção `willCreate`/`willUpdate` bate com o cruzamento; stage **não** escreve em `contacts` nem `tags` (D-7) |
| novo: hidratação | insere template com `created_at = sent_at`; sem `sent_at` não insere (R-11); segunda chamada com mesmo wamid não duplica (R-8); erro não propaga (best-effort) |

Suítes esperadas: **4** (3 estendidas, 1 nova).

### 7.2 Manuais (contra número real, antes do merge)

1. **Planilha completa, admin.** 3 linhas com `phone,name,email,company,tags` → dispara → Configurações → Contatos mostra os 4 campos e as etiquetas.
2. **Não-sobrescrita (R-2).** Contato existente com e-mail curado; reimportar com célula de e-mail vazia e com e-mail diferente → e-mail original intacto nos dois casos.
3. **Papel `agent`.** Mesma planilha com etiqueta inexistente → contatos criados, etiqueta ignorada, aviso visível listando o nome ignorado.
4. **Rastreabilidade (o item que justifica a SPEC).** Disparar para número real → responder do celular → abrir o inbox: a conversa mostra a bolha do template **acima** da resposta, com a origem da campanha e a data.
5. **Não-inundação (R-1).** Disparar para 3 contatos, **nenhum** responde → o inbox não ganha nenhuma conversa nova.
6. **Rejeitados (SPEC 050).** 3 válidos + DDD 10 + célula vazia → triagem lista os inválidos com linha e motivo; só 3 materializam.
7. **Replay (R-8).** Reentregar o mesmo webhook de resposta → a bolha do template não duplica.
8. **Tema.** Aviso da triagem e banner do inbox legíveis em claro e escuro.
9. **Regressão.** Audiência por etiqueta (sem planilha) segue idêntica ponta a ponta.

### 7.3 Validação obrigatória (sem CI no repositório)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 8. i18n

Chaves novas em `messages/en.json` (fonte) espelhadas em `pt-BR.json`. Mensagens de `/api/**` permanecem em inglês.

| Namespace | Chave | pt-BR |
|---|---|---|
| `Broadcasts.triage` | `contactsWillBeSaved` | "{count} contatos serão salvos na sua base ao disparar." |
| `Broadcasts.triage` | `tagsWillBeCreated` | "{count} etiquetas novas serão criadas." |
| `Broadcasts.triage` | `tagsSkippedNoPermission` | "Você não tem permissão para criar etiquetas. Estas serão ignoradas: {names}" |
| `Broadcasts.triage` | `repliesWillShowCampaign` | "Quando os contatos responderem, a conversa mostrará esta campanha." |
| `Inbox.message` | `broadcastOrigin` | "Campanha: {name}" |
| `Inbox.message` | `broadcastOriginDate` | "Enviada em {date}" |

Verbo no **futuro** em toda a triagem — a materialização acontece no envio (D-7).

---

## 9. Rollback

### 9.1 Por fase, antes do deploy

Cada fase é um commit isolado e revertível. F2–F7 são código puro: `git revert` restaura o comportamento anterior integralmente. A única fase com efeito persistente é F1.

### 9.2 Reverter a migração 066

A coluna é aditiva, opcional e não lida por nenhum código anterior — deixá-la no lugar após um revert de código é **inofensivo** e é o caminho recomendado (evita perder o vínculo já gravado se a feature voltar). Se ainda assim for preciso remover:

```sql
-- Rollback 066 — destrutivo: apaga os vínculos já gravados.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_broadcast_outbound_only;
DROP INDEX IF EXISTS idx_messages_broadcast;
ALTER TABLE messages DROP COLUMN IF EXISTS broadcast_id;
```

O vínculo é **reconstruível** a partir de `broadcast_recipients.whatsapp_message_id = messages.message_id` — é por isso que D-3 aceitou a desnormalização. Reconstrução:

```sql
UPDATE messages m SET broadcast_id = r.broadcast_id
FROM broadcast_recipients r
WHERE r.whatsapp_message_id = m.message_id
  AND m.broadcast_id IS NULL
  AND m.sender_type <> 'customer';
```

### 9.3 Dados já escritos por F2/F3/F5

| Efeito | Reversível? | Como |
|---|---|---|
| `email`/`company` preenchidos em contatos | Não automaticamente | Só preenche campo vazio (D-2) — nada foi perdido, então não há o que restaurar. Aceitável sem rollback |
| Tags criadas | Sim | Configurações → Etiquetas, exclusão manual; `contact_tags` cai por CASCADE |
| Vínculos `contact_tags` | Sim | `DELETE` por `tag_id` |
| Bolhas de template hidratadas | Sim, cirurgicamente | `DELETE FROM messages WHERE broadcast_id IS NOT NULL AND content_type = 'template'` — o `broadcast_id` é justamente o que torna essas linhas identificáveis |

Nenhuma fase apaga ou sobrescreve dado preexistente do usuário. Essa é a propriedade que torna o rollback viável, e ela é consequência direta de D-2 (COALESCE) e D-4 (lazy).

### 9.4 Gatilhos de rollback

Reverter imediatamente se, em produção: conversas novas aparecerem para quem não respondeu (falha de D-4); qualquer contato perder e-mail ou empresa (falha de D-2); a taxa de erro de `/api/broadcasts/send` subir (R-5); ou bolhas de template duplicarem (R-8).

---

## 10. Perguntas pendentes para Bruno

Nenhuma bloqueia o início: F1–F3 podem começar já.

1. **R-4** — teto de tags novas por importação: 50 é razoável, ou o produto prefere sem teto?
2. **D-4** — confirma que "quem não respondeu não aparece no inbox" é o comportamento desejado? É o único trade-off deliberado da SPEC.
3. **Migração 066 em `rs` e `jh`** — aplicar junto com `vn` ou só depois do teste manual?
4. **R-7** — vale investir em correlação por `context.id` da Meta agora, ou aceitar a heurística "campanha mais recente" nesta versão?

---

## 11. Rastreabilidade das afirmações

| Afirmação | Evidência |
|---|---|
| Contatos já são materializados | `src/lib/audience/resolve.ts:160`, `:323` |
| Só `phone` e `name` são gravados | `upsertImportedContacts`, montagem do `chunk` |
| `messages` não tem `contact_id`/`direction`/`body` | `supabase/migrations/001_initial_schema.sql:163` |
| `broadcast_recipients` já vincula campanha↔contato↔wamid | `001_initial_schema.sql:321`, `003_broadcast_recipient_wamid.sql` |
| Disparo não cria `conversations`/`messages` | ausência de `from('messages')` em `broadcast-dispatch.ts` e `broadcast-core.ts` |
| Resposta já é ligada ao recipient | `src/lib/channels/ingest.ts:822` |
| Audiência já valida com SPEC 050 | `src/lib/audience/normalize.ts`, `createRowNormalizer` |
| Resolução de tags já existe e é genérica | `src/lib/contacts/resolve-import-tags.ts` |
| Gate de tags é `canEditSettings` | `src/components/contacts/import-modal.tsx:352` |
| 065 está ocupada | `supabase/migrations/065_inbound_contact_webhook.sql` |
