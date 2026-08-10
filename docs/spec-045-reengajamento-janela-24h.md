# SPEC 045 — Reengajamento automático dentro da janela de 24h (WhatsApp Cloud API)

**Status:** 🔴 Proposta — nenhuma linha implementada ainda · **1ª revisão de arquitetura em 2026-08-09**: citações reverificadas; §5.3, §5.4, §5.5 e §5.7 retificadas; §11 adicionada · **2ª revisão em 2026-08-09 (Opus 5)**: um bug de corretude no despacho da varredura, dois de fidelidade de dados e quatro guardrails novos — sumário em §0
**Módulo:** `src/lib/automations/`, `src/components/automations/automation-builder.tsx`, `src/lib/whatsapp/` (novo: `session-window.ts`), `supabase/migrations/` (nova migração — próximo número livre: **052**; a última aplicada é `051_broadcast_ab_test.sql`)
**Desvios em relação à primeira redação:** §5.5 (a varredura passa a viver dentro de `/api/automations/cron`, e a idempotência textual em `automation_logs` foi trocada por uma tabela de claim com `UNIQUE` — ver §5.5.1 e §5.5.2) · §5.3 (colisão de `step_config` em `send_buttons`/`send_list` — ver §5.3.1) · §9 (a alegação de que as fases 1–2 "eliminam" o bug do `follow_up_reminder` foi corrigida)
**Data:** 2026-08-09
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Referências de padrão:** [spec-044-audiencia-multiformato-e-triagem.md](spec-044-audiencia-multiformato-e-triagem.md) (mesmo formato) · [src/lib/broadcasts/send-window.ts](../src/lib/broadcasts/send-window.ts) (precedente de "janela" como função pura testável) · [src/lib/contacts/consent.ts](../src/lib/contacts/consent.ts) (precedente de guardrail de opt-out)

> ⚠️ **Esta SPEC não é "adicionar um lembrete depois de X horas".** O motor de
> automações já sabe esperar (`wait` step) e já sabe mandar mensagem livre ou
> template. O que falta é a peça que hoje **não existe em lugar nenhum do
> código server-side**: saber, no momento exato do envio, se a conversa ainda
> está dentro da janela de 24h da Meta. Hoje esse cálculo só existe como
> *hint* visual no composer do inbox — o motor de automações é cego a ele.
> A §2 documenta essa lacuna com precisão de arquivo/linha antes de propor
> qualquer solução.

---

## 0. Sumário da 2ª revisão (2026-08-09, Opus 5)

Tudo o que a 1ª revisão fixou continua válido — a reverificação linha a
linha não derrubou nenhuma citação dela. O que segue é o que **a leitura
anterior não pegou**, ordenado por gravidade. Cada item vive na seção
indicada; nada aqui é redundante com o corpo da SPEC.

| # | Achado | Gravidade | Onde |
|---|---|---|---|
| 1 | **A varredura, como escrita em §5.5.2, dispara N² vezes.** `runAutomationsForTrigger()` executa **todas** as automações ativas daquele trigger na conta ([engine.ts:103-108](../src/lib/automations/engine.ts#L103-L108)); o loop de claim é *por automação*. Com duas automações do trigger na mesma conta, cada claim executa as duas → 4 execuções, 2 envios duplicados, e o claim não protege nada | 🔴 Corretude — envio duplicado ao cliente | §5.5.3 |
| 2 | **A âncora tem de ser o timestamp da Meta, não `now()`.** O INSERT da mensagem usa `parseInt(message.timestamp)` ([webhook:759](../src/app/api/whatsapp/webhook/route.ts#L759)) mas o UPDATE vizinho — o que §5.2 manda estender — usa `new Date()` ([webhook:773-781](../src/app/api/whatsapp/webhook/route.ts#L773-L781)). Copiar o vizinho faz o backfill e o caminho vivo divergirem, e um webhook reentregue com atraso "estende" uma janela que a Meta já fechou | 🟠 Fidelidade de dados | §5.2.1 |
| 3 | **A âncora precisa ser monotônica.** A Meta reentrega webhooks e não garante ordem; um UPDATE cego faz uma mensagem antiga sobrescrever a âncora para trás e reabrir elegibilidade já consumida | 🟠 Fidelidade de dados | §5.2.1 |
| 4 | **`/api/automations/cron` não declara `maxDuration`** — ao contrário de `/api/broadcasts/cron`, que declara 300 e faz o fan-out em `after()` ([broadcasts/cron:73](../src/app/api/broadcasts/cron/route.ts#L73)). Pendurar envios síncronos de até 200 conversas nessa rota (§5.5.1) é pendurá-los no teto **padrão** da plataforma | 🟠 Operacional | §5.5.4 |
| 5 | **`fallback_template` é um envio pago e categorizado** disparando de dentro de um step que hoje não checa nada. É exatamente o caso que `excludesOptedOut()` existe para cobrir — e §5.6 só protege a varredura, não o step | 🟠 Conformidade | §5.3.4 |
| 6 | **Reengajar com a bola do nosso lado é constrangedor.** Se a última mensagem da conversa é do cliente (ele perguntou e ninguém respondeu), o bot perguntar "posso ajudar em algo?" 20 h depois é o pior resultado possível. Dá para barrar com colunas que já existem | 🟡 Produto | §5.6, item 6 |
| 7 | **Colisão com o motor de Flows.** Um cliente no meio de um menu de flow (`flow_runs.status='active'`, [010:189](../supabase/migrations/010_flows.sql#L189)) receberia um segundo menu por cima, vindo de outro motor | 🟡 Produto | §5.6, item 7 |
| 8 | **O claim sem estado de saída torna a falha permanente.** Claim → envio falha por rede → a linha fica lá e bloqueia qualquer retentativa até o cliente escrever de novo. Também é a chance barata de medir §7 sem cruzar `automation_logs` | 🟡 Design | §5.5.5 |
| 9 | **`wait.amount` NÃO exige inteiro** ([validate.ts:135-152](../src/lib/automations/validate.ts#L135-L152) checa `Number.isFinite` e `> 0`) — §5.7.1 citava isso como precedente e o precedente não existe | 🟢 Retificação factual | §5.7.1 |
| 10 | **O hint do inbox tem dois bugs que a adoção de §5.1 conserta de graça** — thread ainda carregando conta como janela ABERTA, e o ramo de "faltam X minutos" é código morto | 🟢 Ganho colateral | §5.9 |

Duas coisas que a 2ª revisão **confirmou** e que valem estar escritas, para
ninguém refazer o trabalho: o ponto único de INSERT com
`sender_type: 'customer'` (§5.2) continua sendo um só em todo o `src/`, e
os dois outros motores que mandam mensagem de sessão (Flows e auto-resposta
de IA) são reativos ao inbound, ou seja, estão dentro da janela por
construção — o detalhamento está em §2.7.

---

## 1. Contexto e problema

Pelas regras do WhatsApp Cloud API, uma empresa só pode enviar **mensagem de
sessão** (texto livre, botões, listas — sem custo, sem aprovação prévia)
dentro de uma janela de **24 horas contadas a partir da última mensagem que o
contato enviou**. Fora dessa janela, só é possível reabrir a conversa com um
**template (HSM)** aprovado pela Meta — o que tem burocracia de aprovação e
custo por envio.

O pedido de produto: dentro dessa janela, o CRM deve conseguir automatizar um
contato com o cliente que **incentive uma resposta** (ex.: uma pergunta com
botões) — não necessariamente para vender algo, mas para manter a janela
aberta e evitar cair para o regime de template. Hoje isso não existe: o
construtor de automações (`automation-builder.tsx`) tem os blocos genéricos
(`wait`, `send_message`, `send_buttons`, `condition`), mas nenhum deles sabe
o que é a janela de 24h.

## 2. Análise do estado atual (obrigatória)

### 2.1 Há três conceitos de "janela" no código hoje — não confundir

| # | Conceito | Onde vive | O que controla |
|---|----------|-----------|-----------------|
| 1 | **Janela de sessão da Meta** (o assunto desta SPEC) | Só como *hint* de UI, client-side: [message-thread.tsx:228-257](../src/components/inbox/message-thread.tsx#L228-L257) | Se a próxima mensagem pode ser texto livre ou precisa ser template |
| 2 | **Tier de disparo em lote** (`TIER_2K` etc.) | [messaging-limit.ts:36-44](../src/lib/whatsapp/messaging-limit.ts#L36-L44), retificado no commit `f3f9ba9` | Quantos contatos cabem num **broadcast** — teto por disparo, não é uma janela de tempo |
| 3 | **Janela de horário permitido para disparo** (política do operador, ex. dia útil 09h–20h) | [send-window.ts](../src/lib/broadcasts/send-window.ts) | Quando um broadcast pode SAIR, para não queimar reputação disparando de madrugada |

Os commits recentes (`aae835c`, `f3f9ba9`) tratam do conceito #2. Esta SPEC
trata exclusivamente do conceito #1, que **não tem nenhuma implementação
server-side hoje**.

### 2.2 Cálculo atual da janela — só existe no cliente, só como hint

```
message-thread.tsx:228-257
  const sessionInfo = useMemo(() => {
    const lastCustomerMsg = [...messages].reverse()
      .find((m) => m.sender_type === 'customer');
    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;
    ...
  }, [messages, tTimer]);
```

Esse cálculo varre em memória as mensagens já carregadas no navegador do
agente. O resultado (`sessionExpired`) só desabilita o campo de texto do
composer manual ([message-composer.tsx:205-206](../src/components/inbox/message-composer.tsx#L205-L206)) e mostra o aviso
`sessionExpiredHint` (`messages/en.json:325` — *"24-hour session expired. Use
a template to re-engage."*). **Não existe coluna no banco** (`window_expires_at`
ou similar) nem função server-side equivalente.

`conversations` ([001_initial_schema.sql:140-151](../supabase/migrations/001_initial_schema.sql#L140-L151)) só guarda
`last_message_at`, sem distinguir remetente:

```sql
CREATE TABLE conversations (
  ...
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ,   -- de QUALQUER remetente, não só do cliente
  ...
);
```

`messages` ([001_initial_schema.sql:163-175](../supabase/migrations/001_initial_schema.sql#L163-L175)) tem `sender_type IN
('customer','agent','bot')`, mas não há índice/coluna dedicados a "última
mensagem do cliente" — hoje isso é sempre um scan.

### 2.3 O motor de automações não sabe que a janela existe

Arquitetura atual ([engine.ts](../src/lib/automations/engine.ts)):

- `runAutomationsForTrigger()` ([:70](../src/lib/automations/engine.ts#L70)) tem exatamente **dois** call sites no
  repositório: o webhook da Meta
  ([whatsapp/webhook/route.ts:899](../src/app/api/whatsapp/webhook/route.ts#L899)) e o entrypoint manual
  `POST /api/automations/engine` ([engine/route.ts:30](../src/app/api/automations/engine/route.ts#L30)). O webhook
  dispara os triggers `new_message_received`, `keyword_match`,
  `interactive_reply`, `new_contact_created`, `first_inbound_message`
  ([webhook/route.ts:869-897](../src/app/api/whatsapp/webhook/route.ts#L869-L897)). Três valores do union `AutomationTriggerType`
  ([types/index.ts:540-550](../src/types/index.ts#L540-L550)) — `tag_added`, `conversation_assigned`, `time_based`
  — existem no tipo e no dropdown do builder
  ([automation-builder.tsx:172-181](../src/components/automations/automation-builder.tsx#L172-L181)), mas **nenhum call site
  os dispara hoje**. Na validação de ativação, **desses três** só
  `time_based` e
  `tag_added` têm regra ([validate.ts:234-244](../src/lib/automations/validate.ts#L234-L244) — `keyword_match` e
  `interactive_reply`, que têm call site, também são validados, em
  [:205-233](../src/lib/automations/validate.ts#L205-L233) e [:245-257](../src/lib/automations/validate.ts#L245-L257)); `conversation_assigned` não
  é validado em lugar nenhum — cai no `return issues` vazio do fim de
  `validateTriggerForActivation` ([:260](../src/lib/automations/validate.ts#L260)). *(Retificado nesta revisão: a redação
  anterior citava `validate.ts:234-251` e afirmava que os três triggers
  eram validados.)*
- O step `wait` ([engine.ts:288-314](../src/lib/automations/engine.ts#L288-L314), `waitMs()` em [:787-795](../src/lib/automations/engine.ts#L787-L795)) não tem
  fila externa: grava uma linha em `automation_pending_executions`
  (schema em [006_automations.sql:119-133](../supabase/migrations/006_automations.sql#L119-L133)) com `run_at = now() +
  waitMs(cfg)`, e devolve HTTP 200 ali. Um endpoint HTTP protegido por
  segredo (`/api/automations/cron`) drena as linhas vencidas — pingado por
  `pg_cron`/`pg_net` (opção recomendada no `README.md:291-320`) a cada
  **~5 minutos**. Essa cadência de 5 min é o teto de precisão prático de
  qualquer solução baseada em `wait`.
- `send_message` ([engine.ts:374-388](../src/lib/automations/engine.ts#L374-L388)), `send_buttons`/`send_list`
  ([:390-409](../src/lib/automations/engine.ts#L390-L409)) e `send_template` ([:411-445](../src/lib/automations/engine.ts#L411-L445)) chamam a Meta
  **sem checar a janela antes**. Se ela já fechou, a Meta rejeita a chamada,
  o passo vira `status='failed'` em `automation_logs`
  ([006_automations.sql:87-97](../supabase/migrations/006_automations.sql#L87-L97)) — sem retry, sem downgrade automático
  para template.
- `evaluateCondition()` ([engine.ts:732-785](../src/lib/automations/engine.ts#L732-L785)) já resolve 4 "subjects" para o step
  `condition` (`tag_presence`, `contact_field`, `message_content`,
  `time_of_day`) — é o ponto de extensão natural para um 5º subject de
  janela (§5.4).

### 2.4 O template pronto que já carrega o bug que esta SPEC resolve

`AUTOMATION_TEMPLATES.follow_up_reminder`
([templates.ts:106-124](../src/lib/automations/templates.ts#L106-L124)):

```
trigger_type: 'new_message_received'   // dispara na mensagem do cliente
wait 1 day                              // = exatamente 24h depois
send_message (texto livre)              // exatamente no limite da janela
```

Esse template ilustra o problema de frente: a espera é ancorada na mensagem
ORIGINAL que disparou o trigger, não é recalculada contra a mensagem mais
recente do cliente (que pode ter mudado nesse meio-tempo), e o disparo do
lembrete acontece **bem no instante em que a janela fecha** — a pior hora
possível para tentar reengajar sem template.

### 2.5 Guardrail de opt-out — existe, mas o motor de automações não usa

`src/lib/contacts/consent.ts` já formaliza `contacts.opt_in_status` e o
predicado `isOptedOut()` ([consent.ts:47-52](../src/lib/contacts/consent.ts#L47-L52)), usado hoje só pelo pipeline de
broadcasts. **Nenhum step do motor de automações checa opt-out antes de
enviar.** Isso já é uma lacuna hoje (fora do escopo desta SPEC consertar
para todos os steps), mas o novo trigger orientado a reengajamento (§5.5)
precisa respeitá-la — ver §5.6.

### 2.6 Como o motor resolve a conversa de um passo (base de §5.3 e §5.4)

Todo passo de envio chama `resolveConversationId()`
([engine.ts:681-695](../src/lib/automations/engine.ts#L681-L695)), que:

1. usa `args.context.conversation_id` quando existe — é o caminho normal
   dos triggers de webhook, que injetam a conversa no contexto
   ([webhook/route.ts:899-908](../src/app/api/whatsapp/webhook/route.ts#L899-L908));
2. senão, busca a conversa do contato com `.maybeSingle()`, escopada por
   `account_id`.

Duas propriedades importam para esta SPEC:

- **O caminho de retomada não perde a conversa.** O `wait` serializa
  `context: args.context` na linha de `automation_pending_executions`
  ([engine.ts:291-304](../src/lib/automations/engine.ts#L291-L304)) e a retomada devolve esse mesmo objeto a
  `executeStepsFrom` ([engine.ts:167-176](../src/lib/automations/engine.ts#L167-L176), cron em
  [cron/route.ts:51-64](../src/app/api/automations/cron/route.ts#L51-L64)). Ou seja, `resolveConversationId()` funciona
  igual dentro de branch de `condition` e depois de um `wait` — **não é
  preciso buscar o `conversation_id` de outro lugar** no caminho retomado.
- **O `.maybeSingle()` é seguro** porque a migração 036 criou
  `UNIQUE (account_id, contact_id)` em `conversations`
  ([036_conversation_contact_dedup.sql:125-126](../supabase/migrations/036_conversation_contact_dedup.sql#L125-L126)): há no máximo uma
  conversa por contato por conta.

O detalhe que **muda o desenho de §5.4**: `resolveConversationId()`
*lança* quando não há conversa, e uma exceção dentro de
`evaluateCondition()` não vira "branch não" — ela é capturada como passo
falho e **interrompe a automação inteira** (`break` em
[engine.ts:345-356](../src/lib/automations/engine.ts#L345-L356)).

### 2.7 Quem mais manda mensagem de sessão neste repositório (e por que não entra no escopo)

*(Seção da 2ª revisão. A pergunta "a guarda de §5.3 não deveria estar mais
fundo, no `meta-send`, para valer para todo mundo?" é legítima e merece
resposta escrita, não silêncio.)*

Existem **três** motores que chamam a Meta com mensagem de sessão:

| Motor | Entrada | Está dentro da janela? |
|---|---|---|
| Automações (`src/lib/automations/engine.ts`) | Webhook **e** retomada de `wait` pelo cron | ❌ **Não garantido** — o `wait` é justamente o que atravessa a janela. É o alvo desta SPEC |
| Flows (`src/lib/flows/engine.ts`) | Só inbound, via `dispatchInboundToFlows` ([webhook:842-860](../src/app/api/whatsapp/webhook/route.ts#L842-L860)) | ✅ Por construção — todo envio é resposta imediata a uma mensagem do cliente. O `/api/flows/cron` **não envia nada**: só marca `flow_runs` parados como `timed_out` e grava um `flow_run_events` |
| Auto-resposta de IA (`src/lib/ai/auto-reply.ts`) | Só inbound, depois do runner de flows | ✅ Mesma construção |

Ou seja: **hoje o único caminho que pode enviar fora da janela é o
`wait` das automações** — e é por isso que a guarda vive em `runStep()`
(§5.3) e não em `sendViaMeta`. Colocá-la no `meta-send` compartilhado
custaria uma leitura de `conversations` em todo envio de flow e de IA
para responder sempre "sim, está aberta".

Duas consequências práticas:

1. Se um dia o motor de Flows ganhar um nó de espera (hoje ele não tem —
   a única passagem de tempo é o `on_timeout_hours` do
   `fallback_policy`, que **encerra** o run em vez de mandar mensagem),
   essa conclusão muda e a guarda precisa descer para `meta-send`. Vale
   um comentário apontando esta seção no `runStep`.
2. `computeSessionWindow` (§5.1) deve nascer em `src/lib/whatsapp/`, não
   em `src/lib/automations/` — é o diretório que os três motores já
   compartilham (`meta-api`, `interactive`, `phone-utils`), e o inbox
   (§5.9) também vai importar dali.

---

## 3. Objetivo

Permitir que uma automação, dentro do construtor existente, **detecte que a
janela de 24h de uma conversa está prestes a fechar** e reaja — tipicamente
enviando uma mensagem interativa (botões) que convide a uma resposta, mantendo
a janela de mensagem comum aberta — **sem exigir um trigger externo por
mensagem** (o motor precisa varrer conversas paradas, não só reagir a eventos
do webhook).

### Critérios de sucesso

- Uma automação pode ser configurada para disparar quando faltam **N horas**
  (configurável) para a janela de uma conversa fechar.
- O motor **nunca** tenta mandar `send_message`/`send_buttons`/`send_list`
  fora da janela sem que o autor da automação tenha decidido explicitamente
  o que fazer nesse caso (fallback de template ou pular).
- Uma conversa não recebe o mesmo lembrete de reengajamento mais de uma vez
  por janela (idempotência) — e a automação também não reenvia se o próprio
  reengajamento já funcionou (cliente respondeu).

## 4. Fora de escopo (explicitamente)

1. **Implementar o trigger genérico `time_based`** (agendamento tipo cron
   para campanhas recorrentes) — é um problema adjacente, mas não é este.
   Fica registrado como débito técnico pré-existente (§2.3), não como parte
   desta entrega.
2. **Checagem de opt-out para todos os steps do motor** — corrigido apenas
   para o novo trigger (§5.6), não para `send_message` disparado por
   `keyword_match` etc. (mudança maior, merece SPEC própria).
3. **Geração de conteúdo por IA** para a mensagem de reengajamento — o autor
   escreve o texto/botões manualmente no builder, como já funciona hoje.
4. **Mudar a lógica de tier/cota de broadcast** (§2.1, conceito #2) — não
   relacionado.
5. **Precisão sub-minuto** no disparo — o teto de ~5 min do cron (§2.3) é
   aceito como restrição de produto, não resolvido aqui.

## 5. Proposta de solução

### 5.1 Relógio da verdade: `src/lib/whatsapp/session-window.ts` (novo)

Função pura e testável, no mesmo espírito de `send-window.ts`:

```ts
export interface SessionWindowState {
  lastCustomerMessageAt: Date | null;
  isOpen: boolean;
  /** Minutos restantes até fechar; negativo se já fechada. */
  minutesRemaining: number;
}

export function computeSessionWindow(
  lastCustomerMessageAt: Date | null,
  now: Date = new Date()
): SessionWindowState;
```

Reaproveita exatamente a regra hoje duplicada em `message-thread.tsx:240-244`
— essa vira a única fonte da verdade; o componente do inbox passa a importar
daqui em vez de calcular localmente (elimina a duplicação, não é escopo
obrigatório desta entrega mas é o cleanup natural).

Uma diferença deliberada em relação ao hint atual: o cliente usa
`differenceInHours`, que **trunca para horas inteiras**
([message-thread.tsx:240-244](../src/components/inbox/message-thread.tsx#L240-L244)) — "faltam 3h" cobre de 3h00 a 3h59.
O servidor precisa de minutos (a margem de §5.5 é em minutos e o cron roda
a cada 5), então `computeSessionWindow` trabalha em milissegundos e expõe
`minutesRemaining`. Quando o inbox adotar a função, o hint fica mais
preciso — é uma melhoria, não uma regressão, mas vale saber que o número
exibido vai mudar de valor em alguns casos de borda.

### 5.2 `conversations.last_customer_message_at` — coluna dedicada (nova migração)

Hoje calcular "última mensagem do cliente" exige escanear `messages`. Para
uma automação que varre **todas** as conversas de uma conta a cada 5 min
(§5.5), isso precisa ser O(1) por conversa. Nova migração:

```sql
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_last_customer_msg
  ON conversations(account_id, last_customer_message_at)
  WHERE status = 'open';
```

**Por que a ordem das colunas é essa** (e por que a query de §5.5 precisa
acompanhá-la): `account_id` é igualdade e `last_customer_message_at` é
faixa, então a coluna de igualdade tem de vir primeiro para o índice virar
um *range seek* em vez de um scan. Isso só se sustenta se **toda** consulta
de varredura filtrar por conta — é exatamente por isso que a §5.5 foi
retificada para varrer por conta, e não globalmente. O predicado parcial
`WHERE status = 'open'` só é aproveitado se a query trouxer
`status = 'open'` literalmente.

*(2ª revisão — sobre o predicado parcial.)* `conversations.status` aceita
três valores (`'open' | 'pending' | 'closed'`, CHECK em
[001:139](../supabase/migrations/001_initial_schema.sql#L139)), e o índice acima congela uma decisão de produto
dentro de uma estrutura de dados: **conversa `pending` nunca será
reengajada**, e mudar de ideia depois exige recriar o índice. Se a
intenção for "tudo que não está encerrado" — o que é defensável, já que
`pending` costuma significar "esperando alguém", exatamente o estado que
o reengajamento atende — o predicado certo é
`WHERE status <> 'closed'`, que cobre os dois casos sem custo adicional
de tamanho relevante. Decisão de produto; registrada aqui para ser
tomada de propósito e não por inércia da primeira redação. Seja qual
for, a query de §5.5 tem de repetir o predicado **literalmente**.

O índice é aditivo: a 036 já mantém `UNIQUE (account_id, contact_id)` em
`conversations` ([036:125-126](../supabase/migrations/036_conversation_contact_dedup.sql#L125-L126)) e a 017 um
`idx_conversations_account` ([017:299](../supabase/migrations/017_account_sharing.sql#L299)); nenhum dos dois serve à
faixa de tempo.

**Como popular — decidido nesta revisão.** Existe hoje **um único** ponto
de INSERT com `sender_type: 'customer'` em todo o `src/`: o webhook
([whatsapp/webhook/route.ts:749](../src/app/api/whatsapp/webhook/route.ts#L749)) — e ele já faz, logo em seguida, um
UPDATE em `conversations` para `last_message_at`/`unread_count`
([:773-781](../src/app/api/whatsapp/webhook/route.ts#L773-L781)). Popular a coluna nova é **uma linha a mais nesse
UPDATE que já existe**, sem trigger novo e sem custo de escrita extra.
O `AFTER INSERT` trigger continua sendo a opção à prova de futuros
escritores, mas hoje não há futuro escritor a proteger: a API pública e o
motor de flows só inserem `sender_type` `agent`/`bot`. Recomendação:
escrita no webhook + um comentário no `INSERT` apontando o acoplamento.
O backfill inicial (`UPDATE conversations SET last_customer_message_at =
(SELECT max(created_at) FROM messages …)`) vai na mesma migração, para que
conversas antigas não fiquem invisíveis à varredura para sempre.

#### 5.2.1 Qual timestamp escrever — e por que o UPDATE não pode ser cego

*(Seção da 2ª revisão. A decisão "escreve no webhook" de §5.2 está certa;
o que faltava era dizer **o quê** escrever. Copiar as linhas vizinhas
produz duas divergências silenciosas.)*

**Divergência 1 — a fonte do instante.** O INSERT da mensagem grava
`created_at: new Date(parseInt(message.timestamp) * 1000)`
([webhook:759](../src/app/api/whatsapp/webhook/route.ts#L759)) — o instante **da Meta**. O UPDATE de
`conversations` logo abaixo grava `last_message_at: new Date()`
([webhook:773-781](../src/app/api/whatsapp/webhook/route.ts#L773-L781)) — o instante **do nosso servidor**. Para
`last_message_at` (rótulo de UI) a diferença é irrelevante; para a âncora
da janela não é, por dois motivos:

- **A Meta conta a janela pelo relógio dela.** Se o webhook chegar
  atrasado (fila da Meta, reentrega após um 5xx nosso, deploy no meio),
  `new Date()` produz uma âncora **no futuro** em relação à real — o CRM
  acha que ainda faltam minutos e manda texto livre numa janela que a
  Meta já fechou. É exatamente a falha que esta SPEC existe para evitar,
  reintroduzida pela linha de escrita.
- **O backfill usa `max(messages.created_at)`**, que é o instante da
  Meta. Com `new Date()` no caminho vivo, conversas antigas e novas
  passariam a ter âncoras de origens diferentes na mesma coluna.

Escrever `new Date(parseInt(message.timestamp) * 1000).toISOString()` —
literalmente a mesma expressão já calculada para o INSERT — resolve os
dois. Ideal: extrair para uma `const` acima do INSERT e usar nos dois
lugares, para que ninguém possa alterar um sem o outro.

**Divergência 2 — ordem de chegada.** A Meta reentrega webhooks e **não
garante ordem**. Um UPDATE cego (`SET last_customer_message_at = :ts`)
aceita um timestamp mais antigo que o já gravado e **puxa a âncora para
trás** — reabrindo elegibilidade de uma janela já reengajada (o claim de
§5.5.2 não protege: âncora diferente = chave diferente = novo disparo) e,
pior, encurtando artificialmente a janela vigente.

A escrita precisa ser monotônica. Duas formas, ambas de uma linha:

```ts
// (a) No webhook, via PostgREST: só atualiza se avançar.
//     Um segundo UPDATE, separado do que já existe — o filtro não pode
//     valer para last_message_at/unread_count.
await supabaseAdmin()
  .from('conversations')
  .update({ last_customer_message_at: metaTs })
  .eq('id', conversation.id)
  .or(`last_customer_message_at.is.null,last_customer_message_at.lt.${metaTs}`);
```

```sql
-- (b) Trigger AFTER INSERT ON messages, com GREATEST. Uma escrita só,
--     imune a qualquer futuro escritor, e o predicado fica no banco.
UPDATE conversations
   SET last_customer_message_at =
       GREATEST(COALESCE(last_customer_message_at, '-infinity'), NEW.created_at)
 WHERE id = NEW.conversation_id;
```

**Recomendação: (a).** Mantém a decisão de §5.2 (sem objeto de banco
novo) e o custo é um round-trip a mais por mensagem recebida, no caminho
que já faz três. Vale registrar que o argumento que fechou a pergunta 4
de §10 era "existe um único escritor" — a monotonicidade é um **eixo
diferente**, e é o único ponto que ainda joga a favor do trigger. Se a
opção (b) for escolhida depois, a mudança é aditiva: o trigger torna a
escrita do webhook redundante, não errada.

### 5.3 Guarda no motor antes de qualquer envio "de sessão"

Em `runStep()` ([engine.ts:367-668](../src/lib/automations/engine.ts#L367-L668) — a função chama-se `runStep`, não
`executeStep`; `executeStepsFrom` é a que itera a lista), antes dos casos
`send_message` ([:374-388](../src/lib/automations/engine.ts#L374-L388)) e `send_buttons`/`send_list`
([:390-409](../src/lib/automations/engine.ts#L390-L409)) — **não** `send_template` ([:411-445](../src/lib/automations/engine.ts#L411-L445)), que já é o
caminho correto fora da janela —, recalcular a janela **no momento do
envio** (não no momento em que o `wait` foi enfileirado — corrige
exatamente o bug do `follow_up_reminder`, §2.4) via
`computeSessionWindow()`, lendo `conversations.last_customer_message_at`
da conversa devolvida por `resolveConversationId()` (§2.6).

Novo campo opcional em `SendMessageStepConfig` / `SendButtonsStepConfig` /
`SendListStepConfig`: `on_window_closed?: 'skip' | 'fail' | 'fallback_template'`
(+ `fallback_template_name`/`fallback_template_language` quando
`'fallback_template'`). Comportamento por valor:

| `on_window_closed` | Comportamento quando a janela já fechou |
|---|---|
| `'fail'` (**default de leitura** — ver §5.3.2) | Passo falha com mensagem explícita (`'24h session window closed — Meta would reject a free-form message'`) em vez de um 400 opaco da Meta. Resultado no log é o mesmo de hoje (`status='failed'`), mas sem a chamada de rede |
| `'skip'` | Não envia, log com motivo `'session window closed — skipped'`, segue para o próximo step |
| `'fallback_template'` | Envia o template configurado no lugar (reusa `engineSendTemplate`, [engine.ts:435-443](../src/lib/automations/engine.ts#L435-L443)) |

#### 5.3.1 Onde guardar `on_window_closed` em `send_buttons`/`send_list`

*(Retificação desta revisão — a primeira redação tratava os três step
types como equivalentes, e eles não são.)*

Para `send_message`, `step_config` é um objeto próprio
(`SendMessageStepConfig = { text: string }`, [types/index.ts:598-600](../src/types/index.ts#L598-L600)) e
acrescentar um campo é trivial. Para os interativos **o `step_config`
INTEIRO É o payload da Meta**:

```ts
// types/index.ts:607-608
export type SendButtonsStepConfig = InteractiveMessagePayload;
export type SendListStepConfig  = InteractiveMessagePayload;
```

Isso cria três pontos de atrito, dos quais **um é um bug de verdade**:

1. **Vazamento para a Meta — não ocorre.** `engineSendInteractive` lê
   campos nomeados (`payload.body`, `payload.buttons`, …) e monta o corpo
   da requisição a partir deles ([meta-send.ts:86-104](../src/lib/automations/meta-send.ts#L86-L104)), então uma chave
   extra em `step_config` não chega à API da Meta.
2. **Validação — não rejeita.** `validateInteractivePayload()` valida
   campos conhecidos e ignora chaves desconhecidas
   ([interactive.ts:109-126](../src/lib/whatsapp/interactive.ts#L109-L126)), tanto no engine ([engine.ts:398](../src/lib/automations/engine.ts#L398)) quanto na
   validação de ativação ([validate.ts:75-84](../src/lib/automations/validate.ts#L75-L84)).
3. **UI — apaga o campo.** ⚠️ O `StepEditor` entrega a edição dos
   interativos ao `InteractiveBuilder`, que **substitui o `step_config`
   inteiro** a cada alteração:

   ```tsx
   // automation-builder.tsx:1413-1420
   <InteractiveBuilder
     value={asInteractive(cfg)}
     onChange={(payload) =>
       onChange({ ...step, step_config: toStepConfig(payload) })
     }
   />
   ```

   Com esse código, o autor escolhe "quando a janela fechar: pular",
   depois mexe no texto de um botão, e o `on_window_closed` **desaparece
   sem aviso** — voltando ao default `'fail'`. A correção é de uma linha
   (`step_config: { ...cfg, ...toStepConfig(payload) }`), mas precisa
   estar na SPEC porque é invisível em revisão de código sem este
   contexto. Um teste de regressão dedicado está listado em §11.

#### 5.3.2 Default de leitura ≠ default de escrita

Duas coisas diferentes costumam ser confundidas como "o default":

| | Onde vive | Valor | Por quê |
|---|---|---|---|
| **Default de leitura** | `cfg.on_window_closed ?? 'fail'` no engine | `'fail'` | JSONB antigo não tem o campo. Qualquer outro valor mudaria, no dia do deploy, o comportamento de automações que o autor nunca revisou |
| **Default de escrita** | `blankConfig()` no builder ([automation-builder.tsx:206-236](../src/components/automations/automation-builder.tsx#L206-L236)) | `'skip'` | Um step **criado depois** do deploy não tem legado a preservar. `'fail'` faria toda automação nova nascer com o comportamento pior (falhar) só por inércia |

Regra prática que fecha o buraco entre os dois: **`blankConfig()` grava o
valor explicitamente** (`{ text: '', on_window_closed: 'skip' }`), e a UI
renderiza `cfg.on_window_closed ?? 'fail'`. Assim o select nunca aparece
vazio, e o que o autor vê é sempre o que o engine vai executar — em
automação velha ele lê "Falhar", em automação nova lê "Pular", e os dois
estão corretos.

#### 5.3.3 O que acontece com as execuções `wait` já em voo no dia do deploy

Automações ativas hoje (o `follow_up_reminder` de §2.4 é o caso
canônico) deixam linhas `pending` em `automation_pending_executions` que
**sobrevivem ao deploy** — a fila é uma tabela, não memória de processo.
Quando o cron as drenar, elas retomam **já sob o código novo** e passam
pela guarda de §5.3.

Isso é seguro por construção, e é o motivo de o default de leitura ser
`'fail'`: para uma linha enfileirada antes do deploy, o `step_config`
gravado não tem `on_window_closed`, a guarda cai em `'fail'`, e o
resultado observável é idêntico ao de hoje (passo falho). A única
diferença é a mensagem de erro, que passa a dizer o motivo real em vez de
repetir o 400 da Meta.

**A contrapartida honesta:** isso significa que o deploy das fases 1–2
**não conserta retroativamente** nenhuma automação existente. Ele entrega
a ferramenta; a correção só vale depois que o autor abrir a automação e
escolher `'skip'` ou `'fallback_template'`. A §9 foi corrigida nesta
revisão porque afirmava o contrário.

#### 5.3.4 `fallback_template` não é "mais um valor do enum" — é um envio pago, categorizado e sem consentimento verificado

*(Seção da 2ª revisão. As três primeiras subseções de §5.3 tratam
`'skip' | 'fail' | 'fallback_template'` como um select de três opções.
As duas primeiras não fazem nada; a terceira muda de regime.)*

**Forma do config.** A redação atual acrescenta dois campos soltos
(`fallback_template_name` / `fallback_template_language`). O passo
`send_template` já tem uma forma estabelecida —
`SendTemplateStepConfig = { template_name, language?, variables? }`
([types/index.ts:610-614](../src/types/index.ts#L610-L614)) — e o engine monta os parâmetros posicionais a
partir de `variables` com uma ordenação numérica que existe por um bug
real ([engine.ts:421-434](../src/lib/automations/engine.ts#L421-L434)). Dois campos soltos jogam fora `variables`:
o fallback só conseguiria disparar templates sem variável, o que exclui
quase todo template de reengajamento útil ("Oi {{1}}, …"). Usar um
objeto aninhado resolve e reaproveita o tipo:

```ts
on_window_closed?: 'skip' | 'fail' | 'fallback_template';
/** Obrigatório quando on_window_closed === 'fallback_template'. */
fallback_template?: SendTemplateStepConfig;
```

Ganho de brinde: o step de fallback passa a poder ser executado
literalmente pelo mesmo trecho do `case 'send_template'`, extraído para
uma função, em vez de uma segunda montagem de parâmetros que pode
divergir da primeira.

**Consentimento.** §5.6 obriga a checar `isOptedOut()` na varredura do
trigger novo. O `fallback_template`, porém, dispara de dentro de um
step — e esse step pode ter sido alcançado por **qualquer** trigger
(`keyword_match`, `new_message_received`, retomada de `wait`…), nenhum
dos quais passa pela varredura. O resultado é que a única mensagem
**categorizada e cobrável** que esta SPEC introduz seria também a única
sem verificação de consentimento.

E aqui, diferente da mensagem de sessão, existe categoria formal:
`message_templates` guarda a categoria e `excludesOptedOut()`
([consent.ts:42-45](../src/lib/contacts/consent.ts#L42-L45)) já sabe decidir por ela — `utility` e
`authentication` alcançam quem optou por sair, o resto não. A regra
correta no caminho de fallback é, portanto, **mais permissiva** que a de
§5.6, e não uma cópia dela:

```
se contato.opted_out E excludesOptedOut(categoria_do_template):
    não envia; log 'opted out — template fallback suppressed'
```

Como o `send_template` de hoje também não checa isso, a mudança é maior
que esta SPEC (é o item 2 de §4). O corte defensável: **aplicar a regra
só no caminho novo** (o fallback), deixando o `send_template` manual como
está, e registrar a assimetria — o autor escolheu "quando fechar, manda
template" sem escolher "manda mesmo para quem pediu para sair".

**Custo.** `'skip'` e `'fail'` são grátis; `'fallback_template'` gasta
dinheiro por conversa, silenciosamente, num step que o autor configurou
uma vez. O select da §5.7 precisa dizer isso na própria opção
("Enviar template — cobrado pela Meta"), não num tooltip. É a diferença
entre uma automação que falha de graça e uma que sangra centavos por
conversa parada, todo dia, sem ninguém notar.

**Validação na ativação.** `validateStepsForActivation` já exige
`template_name` para `send_template` ([validate.ts:84-91](../src/lib/automations/validate.ts#L84-L91)) — o fallback precisa da mesma regra
quando `on_window_closed === 'fallback_template'`, senão a automação
ativa com um fallback vazio e só falha em produção, no momento exato em
que era para salvar o envio.

### 5.4 Novo subject de condição: `session_window`

Extensão mínima em `evaluateCondition()` ([engine.ts:732-785](../src/lib/automations/engine.ts#L732-L785)), no mesmo
formato dos 4 subjects existentes:

```ts
case 'session_window': {
  if (!args.contactId) return false;
  // resolveConversationId LANÇA quando não há conversa, e uma exceção
  // aqui aborta a automação inteira em vez de cair no branch "não"
  // (engine.ts:345-356). Uma condição precisa responder sim/não, nunca
  // explodir: contato sem conversa = janela não está aberta = false.
  let conversationId: string;
  try {
    conversationId = await resolveConversationId(args);
  } catch {
    return false;
  }
  const { data: conv } = await db.from('conversations')
    .select('last_customer_message_at')
    .eq('id', conversationId)
    .eq('account_id', args.automation.account_id) // defesa em profundidade:
                                                  // o cliente é service-role
    .maybeSingle();
  const { isOpen, minutesRemaining } = computeSessionWindow(
    conv?.last_customer_message_at ? new Date(conv.last_customer_message_at) : null
  );
  switch (cfg.operand) {
    case 'closed':       return !isOpen;
    case 'closing_soon': return isOpen && minutesRemaining <= Number(cfg.value ?? 240);
    case 'open':
    default:             return isOpen;
  }
}
```

Três amarrações com o código existente que a implementação não pode
esquecer *(detalhadas nesta revisão)*:

1. **`operand` é obrigatório na ativação.** `validateStepsForActivation`
   rejeita qualquer `condition` com `operand` vazio
   ([validate.ts:160-165](../src/lib/automations/validate.ts#L160-L165)). Como o operand deste subject é um select
   (`open`/`closed`/`closing_soon`), ele precisa nascer preenchido — o que
   já acontece se o `blankConfig()` de `condition` for respeitado e o
   select de subject gravar um operand padrão ao trocar de subject.
   Trocar de `tag_presence` (operand = id de tag) para `session_window`
   **sem limpar o operand** deixa um UUID de tag no campo, que o `switch`
   acima trataria como `open` pelo `default`. O handler
   `onChange={(e) => set({ subject: e.target.value })}`
   ([automation-builder.tsx:1546](../src/components/automations/automation-builder.tsx#L1546)) hoje só troca o subject — precisa
   passar a resetar `operand`/`value` junto.
2. **O campo "Value" só aparece para dois subjects.** O bloco que renderiza
   o input de valor está condicionado a
   `cfg.subject === 'contact_field' || cfg.subject === 'message_content'`
   ([automation-builder.tsx:1579-1588](../src/components/automations/automation-builder.tsx#L1579-L1588)). Sem incluir `session_window`
   nessa condição (ou sem um campo numérico próprio), não há como o autor
   informar os minutos de `closing_soon` — o subject cairia sempre no
   fallback de 240.
3. **Funciona igual depois de um `wait`.** Como a §2.6 mostra, o
   `conversation_id` sobrevive na `context` serializada, então este subject
   avalia corretamente tanto no disparo direto quanto na retomada — que é
   justamente o cenário em que ele é útil.

Isso dá ao autor da automação um branch **Sim/Não já existente na UI**
(`ConditionBranches`, [automation-builder.tsx:1293-1328](../src/components/automations/automation-builder.tsx#L1293-L1328)) para decidir
"se a janela está aberta, manda texto livre com botão; se não, manda
template" — reaproveitando 100% do componente de condição/branch que já
existe, sem inventar um novo tipo de step visual.

### 5.5 Novo trigger: `session_window_expiring` + varredura por cron

Diferente dos triggers atuais (todos reativos a um evento pontual do
webhook), este precisa de uma **varredura periódica** — não existe "evento"
de a janela estar fechando, é uma condição de tempo sobre conversas paradas.

- Novo `trigger_type: 'session_window_expiring'`, `trigger_config: { margin_minutes: number }` (default sugerido: 240 = 4h antes de fechar — ver §10 para confirmar o padrão com o time).
- A varredura roda **dentro de `/api/automations/cron`**, como uma segunda
  fase depois da drenagem da fila de `wait` — ver §5.5.1 para o porquê.
- Ordem da varredura: primeiro as automações elegíveis, depois as conversas
  de cada conta. Nunca o contrário.

```sql
-- Fase A — quais automações querem este trigger (uma vez por tick).
-- Usa idx_automations_active_trigger (006:31-32), que é global por
-- trigger_type — exatamente o recorte desejado aqui.
SELECT id, account_id, trigger_config
FROM automations
WHERE trigger_type = 'session_window_expiring' AND is_active = TRUE;

-- Fase B — por automação (account_id + margin_minutes vêm da fase A).
-- account_id é a coluna líder de idx_conversations_last_customer_msg
-- (§5.2); sem ele no WHERE o índice não vira range seek.
SELECT c.id, c.contact_id, c.last_customer_message_at
FROM conversations c
WHERE c.account_id = :account_id
  AND c.status = 'open'
  AND c.last_customer_message_at IS NOT NULL
  AND c.last_customer_message_at
      BETWEEN now() - interval '24 hours'
          AND now() - interval '24 hours' + (:margin_minutes || ' minutes')::interval
LIMIT 200;
```

  *(Retificado nesta revisão: a redação anterior mostrava uma varredura
  global de `conversations`, sem `account_id`. Ela é funcionalmente
  correta, mas não usa o índice de §5.2 — cuja coluna líder é
  `account_id` — e cresce com o total de conversas de TODAS as contas do
  deploy, inclusive as que não têm nenhuma automação deste trigger. Com a
  ordem acima, uma instância sem nenhuma automação de reengajamento faz
  **uma** query por tick e vai embora.)*

  O `LIMIT` por automação é um teto de segurança, não paginação: se uma
  conta tiver mais conversas elegíveis do que isso num único tick, o
  excedente entra no tick seguinte — ainda dentro da margem, que é de
  horas. Sem o teto, uma conta grande no primeiro dia (backfill de §5.2
  torna todas as conversas antigas elegíveis de uma vez) prenderia o cron.

#### 5.5.1 Onde a varredura roda: dentro de `/api/automations/cron`, não numa rota nova

*(Decisão desta revisão. A primeira redação propunha um endpoint novo.)*

O agendamento não é código: vive em
[supabase/setup/cron-jobs.sql](../supabase/setup/cron-jobs.sql), que **não é uma migração** — é
configuração de ambiente, carrega a URL e o segredo do deploy, e o próprio
arquivo instrui o operador a *preencher, rodar e descartar sem commitar*.
Um endpoint novo significa um **quarto** `cron.schedule` e, portanto, uma
ação manual de todo operador já em produção (incluindo forks). Quem não
fizer essa ação vai ter a feature aparecendo na UI, salvando automação,
ativando — e nunca disparando, sem nenhum erro em lugar nenhum. É o pior
modo de falha possível para uma feature de automação.

Rodar a varredura como fase B da rota que **já é pingada a cada 5 min**
elimina a ação do operador inteira: quem já configurou o cron ganha a
feature no deploy.

Trade-offs assumidos:

| Ponto | Avaliação |
|---|---|
| O `timeout_milliseconds := 20000` do job passa a cobrir drenagem + varredura | Aceitável: o próprio `cron-jobs.sql` documenta que o timeout corta apenas a **espera** pela resposta, não o trabalho no servidor. Uma varredura que estoure 20 s termina mesmo assim |
| Uma varredura lenta atrasa a drenagem de `wait` | Mitigado pela ordem (drenar primeiro, varrer depois) e pelo `LIMIT` da fase B |
| Menos isolamento operacional (um job, dois trabalhos) | O `README` já documenta as três rotas por nome; uma quarta linha só para isso não paga a fricção de rollout |

O `README.md:291-320` e os comentários de `cron-jobs.sql` continuam
válidos sem edição — o número de jobs não muda.

#### 5.5.2 Idempotência: tabela de claim com `UNIQUE`, não checagem textual em `automation_logs`

*(Retificação desta revisão. A proposta original — serializar a âncora da
janela dentro de `automation_logs.trigger_event` e checar existência antes
de disparar — tem dois defeitos, um de corretude e um de escala.)*

**Defeito 1 — corretude (janela de corrida).** `SELECT` seguido de
`INSERT` não é atômico. Dois pings de cron sobrepostos (o pg_net é beta
segundo o próprio `cron-jobs.sql`; um tick que demore mais de 5 min
sobrepõe o seguinte) leem "ainda não disparou" **antes** de qualquer um
dos dois gravar o log — e o contato recebe o reengajamento duas vezes. É
exatamente o cenário que o resto do repositório já resolve com claim: *"O
claim é o lock. `UPDATE … WHERE status = 'scheduled'` só casa uma vez;
duas invocações sobrepostas do cron não disparam a mesma campanha duas
vezes"* ([broadcasts/cron/route.ts:26-29](../src/app/api/broadcasts/cron/route.ts#L26-L29)); o mesmo padrão está em
[automations/cron/route.ts:42-49](../src/app/api/automations/cron/route.ts#L42-L49). A diferença é que ali existe uma linha
de fila para reivindicar, e aqui não existe — a "fila" é uma condição de
tempo sobre `conversations`. Então a linha precisa ser criada, e a criação
é que vira o lock.

**Defeito 2 — escala.** `automation_logs` é a tabela que mais cresce do
módulo (uma linha por execução de automação, de qualquer trigger) e seus
índices são `(automation_id, created_at DESC)`, `(user_id)` e
`(account_id)` ([006:99-101](../supabase/migrations/006_automations.sql#L99-L101), [017:306](../supabase/migrations/017_account_sharing.sql#L306)) — nenhum sobre
`trigger_event`, que é `TEXT` livre ([006:92](../supabase/migrations/006_automations.sql#L92)). A checagem proposta
seria um filtro textual sobre a partição de um `automation_id`, repetido
**por conversa candidata, a cada 5 minutos, para sempre**. Compare com o
padrão que a própria 006 usa quando quer uma consulta barata e recorrente:
um índice parcial dedicado (`idx_automation_pending_due`,
[006:135-136](../supabase/migrations/006_automations.sql#L135-L136)).

**Resolução — tabela dedicada na mesma migração 052:**

```sql
CREATE TABLE IF NOT EXISTS automation_window_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id)      ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES automations(id)   ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Âncora da janela: o last_customer_message_at que tornou a conversa
  -- elegível. É o que dá a idempotência POR JANELA: uma mensagem nova do
  -- cliente muda a âncora, gera uma chave nova e reabre a elegibilidade.
  window_anchor   TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (automation_id, conversation_id, window_anchor)
);

-- Só para a limpeza periódica (a UNIQUE acima já serve às consultas).
CREATE INDEX IF NOT EXISTS idx_automation_window_claims_purge
  ON automation_window_claims(created_at);

ALTER TABLE automation_window_claims ENABLE ROW LEVEL SECURITY;
-- Sem policy: acesso exclusivamente por service-role, igual a
-- automation_pending_executions (006:138-141).
```

E o disparo vira **um** statement, sem leitura prévia:

```ts
// Mesmo formato de upsert que o engine já usa para contact_tags
// (engine.ts:454-459): onConflict + ignoreDuplicates = ON CONFLICT DO
// NOTHING. Com DO NOTHING, o .select() volta VAZIO quando a linha já
// existia — é isso que distingue "reivindiquei" de "outro já tinha".
const { data: claimed } = await db
  .from('automation_window_claims')
  .upsert(
    { account_id, automation_id, conversation_id, window_anchor },
    {
      onConflict: 'automation_id,conversation_id,window_anchor',
      ignoreDuplicates: true,
    }
  )
  .select('id')
  .maybeSingle();
if (!claimed) continue;        // outro tick já reivindicou esta janela
await runAutomationsForTrigger({ /* … */ });
```

Propriedades que isso compra, e que a versão textual não tinha:

| | Checagem em `automation_logs` | Claim com `UNIQUE` |
|---|---|---|
| Dois cron sobrepostos | Envio duplicado possível | Impossível — o banco recusa a segunda inserção |
| Custo por conversa candidata | Filtro textual sem índice, a cada 5 min | Um INSERT que casa um índice único |
| Reset ao cliente responder | Sim (âncora muda) | Sim (âncora muda) |
| Retenção | Presa ao histórico de logs | Linha estreita, purgável (abaixo) |

**Retenção.** Uma linha por (automação × conversa × janela). Para uma conta
com 5 000 conversas ativas o teto teórico é uma linha por conversa por dia,
e a maioria nunca é criada (só as que entram na faixa). Ainda assim, é
crescimento monotônico: o fim da varredura roda
`DELETE FROM automation_window_claims WHERE created_at < now() - interval '30 dias'`
— seguro porque uma âncora com mais de 24 h já não pode voltar a ser
elegível (a janela dela fechou há muito).

**O que continua indo para `automation_logs`:** o registro da execução em
si, gravado por `executeAutomation()` como já acontece hoje
([engine.ts:191-207](../src/lib/automations/engine.ts#L191-L207)), com `trigger_event = 'session_window_expiring'`.
O log continua sendo a trilha de auditoria e a fonte das métricas de §7 —
só deixa de ser, também, o mecanismo de concorrência.

#### 5.5.3 ⚠️ O claim protege, mas `runAutomationsForTrigger` fura — a varredura precisa de um despacho por automação

*(Achado nº 1 da 2ª revisão. É um bug de composição: cada peça está
certa isolada, e juntas produzem envio duplicado — exatamente o que
§5.5.2 foi escrita para impedir.)*

`runAutomationsForTrigger(input)` não executa "a automação": ela
**busca todas** as automações ativas daquele `trigger_type` na conta e
executa cada uma ([engine.ts:103-123](../src/lib/automations/engine.ts#L103-L123)). É o contrato certo para um
evento de webhook — chegou uma mensagem, todo mundo que escuta reage.

Mas a varredura de §5.5 é organizada ao contrário: a fase A já
enumerou as automações, e o loop de claim roda **por automação**. Com
duas automações do mesmo trigger na mesma conta (cenário que a própria
§5.6, item 4, declara suportado):

```
automação A → conversa X → claim (A,X,âncora) OK → runAutomationsForTrigger
                                                   → executa A  ✅
                                                   → executa B  ❌ sem claim
automação B → conversa X → claim (B,X,âncora) OK → runAutomationsForTrigger
                                                   → executa A  ❌ de novo
                                                   → executa B  ✅
```

Resultado: 4 execuções para 2 pretendidas, **2 mensagens duplicadas** ao
cliente, e a tabela de claims registrando exatamente 2 linhas — ou seja,
a auditoria diz que está tudo certo. O modo de falha é invisível em
`automation_window_claims`, invisível no `EXPLAIN`, e só aparece em
conta com duas automações do trigger.

**Correção — exportar um despacho de automação única.** O engine já tem
a função internamente: `executeAutomation(automation, input)`
([engine.ts:188](../src/lib/automations/engine.ts#L188)). O que ela não tem é a checagem de posse do
contato que `runAutomationsForTrigger` faz antes ([engine.ts:83-101](../src/lib/automations/engine.ts#L83-L101)) —
e que na varredura é redundante, porque a conversa **veio** de uma query
já filtrada por `account_id`. Novo export enxuto:

```ts
/**
 * Executa UMA automação já resolvida pelo chamador. Existe para a
 * varredura de janela (SPEC 045 §5.5), que enumera as automações ela
 * mesma e faz claim por (automação × conversa × âncora): passar por
 * runAutomationsForTrigger ali dispararia todas as automações do
 * trigger a cada claim.
 *
 * O chamador é responsável pela tenancy — aqui não há checagem de
 * posse porque contato e conversa já vieram de uma query escopada
 * por account_id.
 */
export async function runSingleAutomation(
  automation: Automation,
  input: Omit<DispatchInput, 'triggerType'> & { triggerType: string }
): Promise<void>;
```

Duas amarrações que a implementação não pode esquecer:

- **`triggerMatches()` continua valendo.** Para este trigger ela cai no
  `return true` final ([engine.ts:729](../src/lib/automations/engine.ts#L729)), mas chamar mesmo assim mantém
  o novo caminho equivalente ao antigo se um dia o trigger ganhar
  `trigger_config` filtrável.
- **O `context` do despacho precisa trazer `conversation_id`.** Sem
  ele, todo step de envio cai no ramo de fallback de
  `resolveConversationId()` ([engine.ts:686-694](../src/lib/automations/engine.ts#L686-L694)) e refaz, por conversa e
  por step, um SELECT que a varredura já tinha feito. Com ele, zero
  queries extras. Sugestão de contexto:
  `{ conversation_id, vars: { hours_remaining: '4' } }` — `vars` é
  interpolável no texto pelo `{{ vars.* }}` que o engine já suporta
  ([engine.ts:797-805](../src/lib/automations/engine.ts#L797-L805)), sem uma linha de código nova. (Cuidado de
  produto: "sua janela fecha em 4h" não significa nada para o cliente
  final; o uso legítimo é interno, tipo `{{ vars.contact_name }}`.)

#### 5.5.4 Orçamento de execução do tick: `maxDuration`, `after()` e o N+1 do despacho

*(Achado nº 4 da 2ª revisão. §5.5.1 decidiu **onde** a varredura roda e
acertou; falta dizer sob que teto de tempo ela roda.)*

Comparação factual entre as duas rotas de cron que fazem envio:

| | `/api/broadcasts/cron` | `/api/automations/cron` |
|---|---|---|
| `maxDuration` | `300` declarado explicitamente ([:73](../src/app/api/broadcasts/cron/route.ts#L73)) | **Não declara nada** — vale o padrão da plataforma |
| Fan-out do envio | Dentro de `after()`, fora do caminho da resposta | Síncrono, dentro do `GET` |
| Teto de itens por tick | 5 campanhas, com o comentário explicando que cada uma tem milhares de destinatários | 50 execuções pendentes ([:34](../src/app/api/automations/cron/route.ts#L34)) |

Hoje isso não incomoda: drenar 50 retomadas é rápido porque a maioria
não envia nada. §5.5 muda o perfil da rota — passa a existir um caminho
em que **um tick manda até 200 mensagens pela Meta, em série**, cada uma
com round-trip de rede, retry de variante de telefone
([meta-send.ts:205-221](../src/lib/automations/meta-send.ts#L205-L221)), INSERT em `messages` e UPDATE em
`conversations`. A 300 ms por conversa isso é um minuto; com a variante
de telefone falhando primeiro, bem mais.

Três medidas, todas de baixo custo, e nenhuma delas exige ação do
operador (a premissa que §5.5.1 protege):

1. **Declarar `export const maxDuration = 300`** na rota de automações,
   como a de broadcasts já faz. Sem isso, o teto é o padrão da
   plataforma e o corte acontece **no meio de um envio**, deixando a
   dúvida mais cara possível: a mensagem saiu para a Meta e o INSERT
   local não aconteceu?
2. **Rodar a fase de varredura dentro de `after()`**, respondendo o HTTP
   assim que a drenagem terminar. Preserva a ordem que §5.5.1 pede
   (drenar primeiro), tira a varredura do caminho da resposta e casa
   com o `timeout_milliseconds := 20000` do `pg_cron`, que corta só a
   espera pela resposta.
3. **Baixar o `LIMIT` da fase B de 200 para ~50** e assumir que o
   excedente entra no tick seguinte — o que a própria §5.5 já declara
   ser aceitável, porque a margem é de horas. 200 era um número
   escolhido antes de contar o custo por item.

**E o N+1 do despacho.** Mesmo com §5.5.3, cada conversa custa: 1 INSERT
de claim + 1 INSERT em `automation_logs` + 1 SELECT de steps + o envio +
1 RPC de contador ([engine.ts:229-234](../src/lib/automations/engine.ts#L229-L234)). É o preço de reusar o motor
inteiro em vez de reimplementar um caminho paralelo — **é o trade certo**,
e está registrado aqui só para que o número não surpreenda em produção.
O que **não** se paga é o SELECT de `automations` por conversa, e é
exatamente ele que §5.5.3 elimina.

#### 5.5.5 Ciclo de vida do claim: sucesso, falha e a métrica de graça

*(Achado nº 8 da 2ª revisão. §5.5.2 define a criação da linha; nada é
dito sobre o que acontece depois dela.)*

**O problema.** O claim entra **antes** do envio (tem de ser: é o lock).
Se o envio falhar — token expirado, 5xx da Meta, timeout de rede — a
linha fica lá, e a conversa **nunca mais** é elegível naquela janela.
Uma indisponibilidade de 30 s da Meta durante um tick queima o
reengajamento de todas as conversas daquele lote, silenciosamente.

**A escolha explícita.** Em mensageria, *at-most-once* é o padrão certo:
um envio duplicado é visível para o cliente e não tem desfazer; um envio
perdido custa uma janela. Então o comportamento base **continua sendo
claim-e-esquece**. O que muda é ter como distinguir os dois casos:

```sql
-- Acrescentar a automation_window_claims (§5.5.2):
  sent_at    TIMESTAMPTZ,          -- preenchido após o envio bem-sucedido
  failed_at  TIMESTAMPTZ,          -- preenchido quando o despacho falhou
  reopened_at TIMESTAMPTZ          -- cliente escreveu depois: o reengajamento funcionou
```

Com isso, três coisas passam a ser possíveis e nenhuma delas antes era:

1. **Retentativa opcional e limitada.** O tick seguinte pode reprocessar
   claims com `failed_at IS NOT NULL AND sent_at IS NULL` que ainda
   estejam dentro da faixa de elegibilidade — sem risco de duplicata,
   porque `sent_at` prova que nada saiu. Fica como refinamento, não
   como requisito da entrega.
2. **A métrica de §7 vira uma query só.** `reopened_at` é preenchido
   pelo mesmo UPDATE monotônico de §5.2.1 — quando a âncora avança e
   existe um claim recente daquela conversa, o reengajamento funcionou.
   Sem isso, a "taxa de reabertura" exige cruzar `automation_logs` com
   `messages` por `contact_id` e janela de tempo, que é a consulta que
   ninguém escreve depois do deploy.
3. **A limpeza dos 30 dias fica honesta.** Um `DELETE` cego apaga junto
   a evidência de sucesso; com as colunas acima, dá para agregar antes
   de apagar (ou reter só as linhas com `reopened_at`).

Custo: três colunas anuláveis numa tabela estreita, na mesma migração.

### 5.6 Guardrails obrigatórios do novo trigger

Aplicados na varredura, antes de chamar `runAutomationsForTrigger`:

1. **`conversations.status = 'open'`** — não reengajar conversa fechada/pending.
2. **`contacts.opt_in_status != 'opted_out'`** (reusa `isOptedOut()` de
   [consent.ts:47-52](../src/lib/contacts/consent.ts#L47-L52)) — mesmo sendo mensagem de sessão (não marketing por
   template), respeitar quem pediu para não receber contato automatizado.
   Isso **não é uma escolha arbitrária**: é a mesma postura conservadora
   que o módulo de consentimento já documenta. `excludesOptedOut()` trata
   *categoria ausente ou desconhecida como marketing*
   ([consent.ts:42-45](../src/lib/contacts/consent.ts#L42-L45)) — e uma mensagem de sessão não tem categoria
   nenhuma na Meta (§8), então ela cai exatamente nesse caso.
3. **Idempotência por janela** — o claim de §5.5.2, que é também o lock de
   concorrência entre pings sobrepostos do cron.
4. **Uma automação ativa por conta para este trigger é o esperado** — se o
   usuário ativar duas automações com o mesmo trigger, ambas disparam (é o
   comportamento já existente do motor para qualquer trigger, [engine.ts:103-108](../src/lib/automations/engine.ts#L103-L108));
   vale um aviso na UI do builder, não um bloqueio no engine. Note que o
   claim de §5.5.2 tem `automation_id` na chave — de propósito: ele impede
   a **mesma** automação de disparar duas vezes na mesma janela, não duas
   automações distintas de disparar cada uma a sua. Bloquear isso no banco
   seria mudar a semântica do motor para um trigger só.
5. **Anti-fadiga (recomendado, não bloqueante nesta entrega).** O
   repositório já tem o conceito e o lugar para configurá-lo:
   `whatsapp_config.broadcast_cooldown_days`, criado pela migração 050 com
   default 7 e a justificativa de que "cooldown é uma heurística de
   qualidade de número, não uma restrição legal". Reengajamento automático
   é o caso de uso mais óbvio para fadiga depois de broadcast. Não reusar a
   coluna de broadcast (semânticas diferentes), mas seguir o padrão se e
   quando um teto de frequência for pedido.

*(Itens 6 a 9 acrescentados na 2ª revisão. Os cinco primeiros protegem o
sistema; estes protegem a conversa. Todos custam uma coluna já existente
ou uma query indexada, e nenhum deles é óbvio em revisão de código —
por isso estão aqui e não "na implementação".)*

6. **Não reengajar com a bola do nosso lado.** 🔴 O caso: o cliente
   perguntou algo às 10h, ninguém respondeu, e às 06h do dia seguinte o
   bot dispara *"Posso ajudar com mais alguma coisa?"*. Do lado de lá
   isso lê como deboche, e é o cenário **mais comum** numa conta com
   equipe pequena — justamente a que o produto atende. Janela fechando
   com mensagem do cliente sem resposta não é caso de reengajamento, é
   caso de SLA.

   O teste é barato e usa duas colunas que já existem em
   `conversations` desde a 001: se `last_customer_message_at >=
   last_message_at`, a última palavra foi do cliente (`unread_count = 0`
   chega ao mesmo lugar por outro caminho). Sugestão: filtrar na fase B
   com `AND c.last_message_at > c.last_customer_message_at` — é filtro,
   não sub-query, custo zero.

   Vale como padrão, não como lei: uma automação de "cutucar quem não
   respondeu nossa proposta" quer exatamente o oposto. Se virar
   configurável, o nome honesto do campo é
   `only_when_awaiting_customer: boolean` (default `true`), não
   "avançado".

7. **Não reengajar quem está no meio de um Flow.** O motor de Flows
   mantém no máximo um run ativo por contato (índice único parcial
   `idx_one_active_run_per_contact`, [010:189](../supabase/migrations/010_flows.sql#L189) / [017:337-338](../supabase/migrations/017_account_sharing.sql#L337-L338)) e o
   webhook suprime os triggers de conteúdo quando o run consome a
   mensagem ([webhook:876-887](../src/app/api/whatsapp/webhook/route.ts#L876-L887)) — ou seja, o repositório **já
   reconhece** que os dois motores não devem falar por cima um do outro.
   A varredura de §5.5 não passa pelo webhook e fura essa proteção: o
   cliente parado no meio de um menu receberia um segundo menu, de outro
   motor, com botões que o flow não sabe interpretar.

   Um `NOT EXISTS (SELECT 1 FROM flow_runs WHERE contact_id = c.contact_id
   AND status = 'active')` na fase B resolve, servido pelo índice parcial
   que já existe. E o filtro não prende ninguém para sempre: o
   `/api/flows/cron` encerra runs abandonados (`timed_out`, default 24 h).

8. **Conversa com dono humano é decisão de produto, não bug.** A 039 deu
   a `conversations` um `assigned_agent_id`, e a auto-resposta de IA já
   consulta esse campo antes de agir ([auto-reply.ts:73](../src/lib/ai/auto-reply.ts#L73)). Reengajar
   automaticamente uma conversa atribuída interfere no atendimento de um
   humano que pode estar prestes a responder. Pular atribuídas é
   defensável; não pular também. O que não é defensável é **não
   decidir** — o comportamento emergente hoje seria "reengaja todo
   mundo", o mais intrusivo dos dois. Sugestão: pular quando
   `assigned_agent_id IS NOT NULL`, mesmo filtro barato da fase B, e
   reavaliar com uso real.

9. **Janela de horário (`send-window.ts`) — recomendação para a pergunta
   2 de §10.** Um reengajamento às 04h é o mesmo dano de reputação que o
   broadcast às 23h, e o argumento da urgência ("a janela vai fechar") é
   fraco: se a única hora possível é de madrugada, o custo do disparo
   excede o benefício de manter aberta uma conversa que o cliente
   abandonou. Recomendação: **respeitar a janela**, reusando
   `isWithinSendWindow()` na fase B (função pura, uma linha), com a
   consequência assumida de que parte das conversas não é reengajada.
   Diferente do broadcast, aqui **não existe "adiar"** — a janela de
   24 h não espera, e é essa a diferença que torna a decisão não óbvia.
   Se o time discordar, o compromisso razoável é uma janela própria e
   mais larga para este trigger (ex. 08h–21h, todos os dias), nunca
   ignorar horário nenhum. Nota de fuso: `isWithinSendWindow` exige um
   IANA timezone e o broadcast o tira de quem agendou
   (`broadcasts.scheduled_timezone`); aqui não há "quem agendou", então
   a varredura usa `DEFAULT_TIME_ZONE` ('America/Sao_Paulo') — coerente
   com um CRM localizado para o Brasil, e o lugar certo para configurar
   por conta, se um dia for preciso, é `whatsapp_config`.

### 5.7 Mudanças de UI em `automation-builder.tsx`

| Onde | Mudança |
|---|---|
| `TRIGGER_OPTIONS` ([:172-181](../src/components/automations/automation-builder.tsx#L172-L181)) | Novo item `session_window_expiring` |
| `TriggerCard` (bloco `type === 'time_based'`, [:940-957](../src/components/automations/automation-builder.tsx#L940-L957)) | Novo bloco de config irmão: input numérico "avisar N horas antes de a janela fechar" (grava `margin_minutes`, em minutos) |
| `blankConfig()` ([:206-236](../src/components/automations/automation-builder.tsx#L206-L236)) | `send_message` passa a nascer `{ text: '', on_window_closed: 'skip' }`; idem para os payloads interativos (`blankButtonsPayload()`/`blankListPayload()` **não** mudam — o campo é acrescentado por fora, ver §5.3.1) — **default de escrita `'skip'`, diferente do default de leitura `'fail'` (§5.3.2)** |
| `StepEditor`, casos `send_message`/`send_buttons`/`send_list` ([:1398-1420](../src/components/automations/automation-builder.tsx#L1398-L1420)) | Novo campo (select) "quando a janela já tiver fechado": Pular / Falhar / Enviar template — reaproveita `SendTemplateFields` ([:597-676](../src/components/automations/automation-builder.tsx#L597-L676)) quando `'fallback_template'`. **Nos interativos, o `onChange` do `InteractiveBuilder` ([:1413-1420](../src/components/automations/automation-builder.tsx#L1413-L1420)) precisa mesclar em vez de substituir o `step_config`** — senão o campo novo é apagado a cada edição de botão (§5.3.1) |
| `StepEditor`, caso `condition` ([:1540-1590](../src/components/automations/automation-builder.tsx#L1540-L1590)) | Novo `<option value="session_window">` no subject; operand vira select (`open`/`closed`/`closing_soon`) em vez de input livre; trocar de subject passa a **resetar `operand`/`value`** ([:1546](../src/components/automations/automation-builder.tsx#L1546)); o bloco condicional do campo "Value" ([:1579-1588](../src/components/automations/automation-builder.tsx#L1579-L1588)) passa a incluir `session_window` para o autor informar os minutos de `closing_soon` (§5.4) |
| `validate.ts`, `validateTriggerForActivation` ([:234-244](../src/lib/automations/validate.ts#L234-L244)) | Validação do novo `trigger_config.margin_minutes` no mesmo `else if` onde `time_based`/`tag_added` já são validados — faixa **inteiro, ≥ 15 e ≤ 1440** (justificativa em §5.7.1) |
| `types/index.ts` | `AutomationTriggerType` ([:540-550](../src/types/index.ts#L540-L550)) ganha `'session_window_expiring'`; `ConditionSubject` ([:650-651](../src/types/index.ts#L650-L651)) ganha `'session_window'`; nova `SessionWindowExpiringTriggerConfig` no union `AutomationTriggerConfig` ([:590-596](../src/types/index.ts#L590-L596)) |
| `messages/en.json` / `messages/pt-BR.json` | Novas chaves de tradução (trigger label/hint, subject, campo de fallback). `en.json` é a fonte de verdade e `npm run i18n:check` roda no CI |

*(2ª revisão — dois detalhes de UI que só aparecem lendo o arquivo:)*

- **O campo "Value" está com o rótulo em código, não traduzido**
  (`<FieldBlock label="Value">`, [automation-builder.tsx:1580](../src/components/automations/automation-builder.tsx#L1580)) — é o
  único `FieldBlock` do editor de condição que não usa `t(...)`.
  Como §5.4 exige mexer exatamente nesse bloco para o `closing_soon`,
  o conserto sai junto: uma chave nova, zero fricção.
- **`AutomationTriggerConfig` termina em `| Record<string, unknown>`**
  ([types/index.ts:590-596](../src/types/index.ts#L590-L596)), ou seja, o union **não** força o compilador
  a cobrar a nova `SessionWindowExpiringTriggerConfig` — qualquer objeto
  passa. Ao contrário de `TemplateSlug` (§5.8), aqui não há rede de
  proteção do TypeScript: a validação de §5.7 é a única guarda real.

#### 5.7.1 Faixa de `margin_minutes`: ≥ 15, não > 0

*(Retificado nesta revisão — a redação anterior propunha `> 0`.)*

A conversa fica elegível enquanto `now - last_customer_message_at` está em
`[24h − margem, 24h)`, ou seja: **a largura da faixa de elegibilidade é
exatamente `margin_minutes`**. O cron pinga a cada 5 min (§2.3). Uma
margem de 1 minuto cria uma faixa de 1 minuto que o tick de 5 min só
acerta em ~1 de cada 5 janelas — a automação "funciona", dispara às vezes,
e o autor não tem como descobrir por quê. O valor não é apenas inútil: é
enganoso.

O piso matemático é 5 (com ticks perfeitamente periódicos, uma faixa de
5 min sempre contém um tick). O piso **prático** é maior porque os ticks
não são perfeitamente periódicos: o `pg_net` é beta por admissão do
próprio `cron-jobs.sql`, que assume que uma execução pode falhar e conta
com a seguinte. Daí **15 minutos = 3 ticks**, que tolera duas execuções
perdidas seguidas.

Também exigir inteiro (`Number.isInteger`). *(Retificado na 2ª revisão: a
redação anterior justificava isso dizendo que `wait.amount` "já faz" — e
não faz. [validate.ts:135-152](../src/lib/automations/validate.ts#L135-L152) checa `typeof number`, `Number.isFinite`
e `> 0`, nada mais: `wait 1.5 horas` passa na validação hoje e vira
`Math.max(1000, 1.5 * 3_600_000)` no `waitMs()`, o que aliás funciona.
O precedente não existe — a exigência de inteiro para `margin_minutes`
se sustenta pelo seu próprio argumento, que é o teto de precisão do cron
de §2.3, não por simetria com um step que não a tem.)*

O teto de 1440 (24 h) é um limite de sanidade, não uma recomendação:
margem = 1440 significa "elegível desde o instante em que o cliente
escreveu", o que transforma o trigger num `new_message_received` com
atraso de até 5 min. Valores acima de ~720 devem receber um aviso na UI,
não um bloqueio.

### 5.8 Template pré-configurado corrigido

Substituir (ou adicionar ao lado, mantendo compatibilidade) o
`follow_up_reminder` de [templates.ts:106-124](../src/lib/automations/templates.ts#L106-L124) por uma versão que usa o
novo trigger:

```ts
reengagement_before_window_closes: {
  trigger_type: 'session_window_expiring',
  trigger_config: { margin_minutes: 240 }, // 4h de antecedência
  steps: [{
    step_type: 'send_buttons',
    step_config: { /* pergunta + botão, on_window_closed: 'skip' */ },
  }],
}
```

Três amarrações a não perder de vista:

- `TemplateSlug` é um union literal ([templates.ts:8-9](../src/lib/automations/templates.ts#L8-L9)); o slug novo entra
  ali, e `AUTOMATION_TEMPLATES` é `Record<TemplateSlug, …>`, então o
  compilador cobra a definição — não há como esquecer metade.
- O `step_config` precisa trazer `on_window_closed` **explicitamente**,
  não confiar no default: um template é código, não passa pelo
  `blankConfig()` do builder (§5.3.2).
- Como argumentado em §8.1, este template é a principal peça pedagógica
  da feature. O texto de exemplo deve ser uma pergunta de utilidade real
  — a alternativa ("oi, ainda está aí?") é exatamente o conteúdo que
  degrada *quality rating*, e sair no template pronto o transformaria no
  padrão de fato de toda conta nova.

### 5.9 Ganhos colaterais que a coluna e a função pagam sozinhas

*(Seção da 2ª revisão. Nada aqui é requisito da entrega; tudo aqui fica
barato **depois** da fase 1 e caro se for feito separado.)*

**Os dois bugs do hint atual do inbox.** §5.1 propõe que o
`message-thread.tsx` passe a importar `computeSessionWindow` — descrito
lá como "cleanup natural, não obrigatório". A releitura do trecho mostra
que não é só limpeza; são duas correções:

1. **Thread ainda carregando conta como janela ABERTA.** A primeira
   linha do `useMemo` é `if (!messages.length) return { expired: false }`
   ([message-thread.tsx:230](../src/components/inbox/message-thread.tsx#L230)). Enquanto o fetch não volta, o array é
   vazio → `expired: false` → o composer de texto livre fica
   **habilitado** ([message-composer.tsx:205-206](../src/components/inbox/message-composer.tsx#L205-L206)). Numa conversa de janela
   fechada, o agente consegue digitar e enviar antes de o aviso
   aparecer — e leva um 400 da Meta. O default seguro para "não sei" é
   fechado, não aberto.
2. **O ramo de "faltam X minutos" é código morto.** `differenceInHours`
   trunca, então `hoursSince` é inteiro; não expirada significa
   `hoursSince <= 23`, logo `hoursLeft = 24 - hoursSince >= 1`, e a
   condição `hoursLeft >= 1` é **sempre verdadeira**
   ([message-thread.tsx:250-254](../src/components/inbox/message-thread.tsx#L250-L254)). A chave `xmRemaining` nunca é
   renderizada: o contador pula de "1h" para "expirado". Com
   `minutesRemaining` de §5.1 o ramo volta a existir — e é justamente a
   última hora, quando o agente mais precisa da informação.

Isso reposiciona a adoção da função no inbox: não é refatoração
opcional, é a correção de dois defeitos com uma importação. Vale entrar
na fase 1.

**Ordenar e filtrar o inbox por janela.** Depois de §5.2 a informação
"quanto falta" é uma coluna indexada, não uma varredura de mensagens no
navegador — o que torna barato o que hoje é impossível: ordenar a caixa
de entrada por "janela fechando primeiro", ou um filtro/aba "fechando em
até N horas". Para uma equipe pequena isso é, provavelmente, mais
valioso no dia a dia do que a automação: transforma um prazo invisível
em fila de trabalho. Cabe no quadro de atribuição da SPEC 043 pelo mesmo
motivo. Fica registrado como oportunidade, não como escopo.

**API pública.** `docs/public-api.md` expõe conversas; um campo derivado
`session_window: { is_open, minutes_remaining }` sai de graça da mesma
função e evita que todo integrador reimplemente a regra das 24 h — que
é exatamente como este repositório chegou a ter três lugares diferentes
falando de "janela" (§2.1). Também não é escopo desta entrega.

## 6. Fluxo end-to-end (exemplo de produto)

1. **Dia 1, 10:00** — cliente manda mensagem. O webhook grava
   `conversations.last_customer_message_at = D1 10:00` (§5.2). A janela
   fecha em **D2 10:00**.
2. **D1 10:05** — agente responde. Não afeta a janela: só mensagem do
   cliente conta. *(2ª revisão: mas afeta a **elegibilidade** — é esta
   resposta que satisfaz o guardrail 6 de §5.6. Se o agente não tivesse
   respondido, a conversa estaria esperando por nós, e o desfecho certo
   seria não reengajar, e sim aparecer na fila de quem deve resposta.)*
3. Cliente não escreve mais nada. Com margem de 4h, a conversa fica
   elegível a partir de **D2 06:00** (`last_customer_message_at` entre
   `now − 24h` e `now − 24h + 4h`). O primeiro tick de cron a partir daí
   — na prática entre 06:00 e 06:05 — casa o predicado da fase B.
   *(Retificado nesta revisão: a redação anterior dizia "às 20:00",
   ainda no dia 1 — nesse instante faltavam 14h para fechar, muito fora
   da margem de 4h.)*
4. Antes de disparar, a varredura tenta o claim
   `(automation_id, conversa, window_anchor = D1 10:00)`. Ele entra: é a
   primeira vez. Um segundo ping de cron sobreposto tentaria o mesmo
   claim e seria recusado pelo banco (§5.5.2) — nenhum envio duplicado.
5. A automação manda `send_buttons`: *"Ainda precisa de ajuda com algo?
   Toque em uma opção 👇"* com botões tipo "Sim, continuar" / "Não,
   obrigado". `automation_logs` recebe a linha de execução normal, com
   `trigger_event = 'session_window_expiring'`.
6. Nos ticks seguintes (06:10, 06:15, … até 10:00) a conversa **continua
   casando o predicado** — é justamente por isso que o claim existe: o
   `INSERT` falha por conflito e a varredura segue adiante sem enviar
   nada.
7a. **Cliente toca num botão às 07:30** → nova mensagem inbound →
    `last_customer_message_at` vira D2 07:30 → janela reabre por mais 24h,
    a conversa sai do predicado, e a âncora nova torna a conversa elegível
    de novo só em D3 03:30. O trigger `interactive_reply` (já existente)
    pode encadear os próximos passos.
7b. **Cliente não responde** → em D2 10:00 a janela fecha de fato. Se
    houvesse um segundo step de fallback com `send_template`, ele teria
    disparado por `on_window_closed: 'fallback_template'` — mas neste
    fluxo o autor optou por `'skip'`, então a automação termina sem
    re-tentativa. O claim daquela janela permanece até a limpeza dos 30
    dias (§5.5.2), impedindo qualquer redisparo sobre a mesma âncora.

## 7. Métricas de sucesso

| Métrica | Como medir | Fonte |
|---|---|---|
| Taxa de reabertura de janela | % de conversas com `session_window_expiring` disparado que recebem nova mensagem do cliente dentro de 24h do envio do reengajamento | Cruzar `automation_logs` com `messages.sender_type='customer'` |
| Taxa de clique nos botões | % de reengajamentos que geram um `interactive_reply` | `automation_logs` (trigger `interactive_reply`) correlacionado por `contact_id` |
| Falhas evitadas | Redução de `automation_logs.status='failed'` com erro de janela fechada. **Atenção ao ler o número:** pelo default de leitura `'fail'` (§5.3.2), a queda não vem do deploy — vem de cada autor que trocar o campo para `'skip'`/`'fallback_template'`. A métrica mede **adoção**, não a correção em si | `automation_logs.error_message` (a guarda de §5.3 grava uma mensagem estável e greppável, ao contrário do 400 opaco da Meta de hoje) |
| Templates evitados (custo) | Reengajamentos bem-sucedidos (janela reaberta) vs. quantos teriam exigido template pago se nada fosse feito | Estimativa — não há dado de custo por template no schema hoje (ver §10) |

*(2ª revisão.)* As duas primeiras linhas desta tabela descrevem consultas
que **ninguém vai escrever**: cruzar `automation_logs` com `messages` por
`contact_id` e faixa de tempo, sem índice que sirva, é caro e chato o
bastante para a métrica virar folclore ("acho que está funcionando"). As
colunas `sent_at` / `reopened_at` de §5.5.5 tornam as duas primeiras
linhas um `SELECT count(*) … WHERE reopened_at IS NOT NULL` sobre uma
tabela estreita — e a terceira linha ganha um contraponto honesto,
porque `failed_at` separa "o autor não configurou" de "a Meta recusou".
Se apenas um item desta seção for implementado, que seja esse.

Uma métrica que falta e é a mais importante das cinco: **taxa de
descadastro após reengajamento** — quantos contatos viram `opted_out`
(`contact_consent_events`, com `source = 'inbound_keyword'`) nas 24 h
seguintes a um reengajamento. É o único número que mede o risco de §8.1
antes de ele virar queda de *quality rating*, que é quando já não há o
que fazer. O dado já existe; falta só olhar para ele.

## 8. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| **Política da Meta**: mensagens cujo único propósito é "manter a janela aberta", sem valor real ao usuário, alimentam reclamações e podem afetar a *quality rating* do número. | Fora do controle técnico do CRM — registrar como orientação de produto/conteúdo: a automação deve oferecer algo de valor real (ex. "posso ajudar com mais alguma coisa?", não um botão vazio). Não é um bloqueio de implementação, é uma nota de responsabilidade a comunicar ao usuário do CRM na UI (tooltip/hint no builder). **Ver §8.1 para por que este risco é estruturalmente diferente do de um template.** |
| Precisão do cron (~5 min) faz o disparo variar dentro da margem configurada | Aceito como restrição de produto (§4); a margem padrão (4h) tem folga suficiente para isso ser irrelevante na prática |
| `wait` sem teto (§2.3) pode ser combinado incorretamente com esta feature (ex. autor encadeia `wait 2 days` depois do reengajamento) | Não é bloqueado por esta SPEC — a guarda de §5.3 protege qualquer `send_message`/`send_buttons` tardio, independente de qual trigger o originou |
| Duas automações ativas com `session_window_expiring` na mesma conta disparam ambas para a mesma conversa | Comportamento consistente com o resto do motor (§5.6, item 4); considerar um aviso na UI ao ativar uma segunda automação com o mesmo trigger — não bloqueante |
| Volume: varredura de conversas `open` a cada 5 min | Resolvido no desenho da query (§5.5): a fase A lista as automações ativas do trigger via `idx_automations_active_trigger` ([006:31-32](../supabase/migrations/006_automations.sql#L31-L32)) e a fase B só varre as contas devolvidas por ela, com `account_id` como coluna líder do índice parcial de §5.2. Um deploy sem nenhuma automação desse trigger custa **uma** query por tick |
| Envio duplicado por pings de cron sobrepostos | Resolvido em §5.5.2: o claim com `UNIQUE (automation_id, conversation_id, window_anchor)` é o lock, no mesmo espírito do claim já usado em `/api/automations/cron` e `/api/broadcasts/cron` |
| A varredura passa a compartilhar rota com a drenagem de `wait` (§5.5.1) | Drenagem primeiro, varredura depois, `LIMIT` por automação na fase B. O `timeout_milliseconds` do job corta só a espera pela resposta, não o trabalho — documentado no próprio `cron-jobs.sql` |
| **Envio duplicado por despacho amplo** (não por concorrência): com duas automações do trigger na conta, cada claim executa as duas | Resolvido em §5.5.3 com `runSingleAutomation()`. **Não** é coberto pelo claim de §5.5.2 — é o único risco desta tabela cujo modo de falha não deixa rastro anômalo em lugar nenhum |
| **Reengajar cliente que está esperando resposta humana** — o bot pergunta "posso ajudar?" 20 h depois de uma pergunta ignorada | §5.6, item 6: filtro `last_message_at > last_customer_message_at` na fase B. Risco de marca, não de sistema, e por isso o mais fácil de deixar passar numa revisão técnica |
| **Fallback de template gastando dinheiro em silêncio** | §5.3.4: rótulo explícito na opção do select, validação na ativação e checagem de opt-out pela categoria. Sem isso, o único envio cobrável da feature é também o único sem verificação |
| **Tick de cron estourando o teto de tempo no meio de um envio** | §5.5.4: `maxDuration` declarado, varredura em `after()`, `LIMIT` menor. Sem os três, o corte cai entre a chamada à Meta e o INSERT local — a mensagem sai e o CRM não sabe |

### 8.1 Mensagem de sessão × template: a diferença regulatória que importa aqui

*(Aprofundamento desta revisão. A linha da tabela acima descrevia o risco
em termos genéricos de "quality rating"; o que segue é o que torna esta
feature diferente de tudo que o CRM já manda.)*

| | Template (HSM) | Mensagem de sessão (o que esta SPEC automatiza) |
|---|---|---|
| Revisão prévia de conteúdo pela Meta | Sim — aprovação por template, antes do primeiro envio | **Nenhuma.** O texto vai como o autor escreveu |
| Categoria formal | Sim: `utility` / `marketing` / `authentication` — o projeto já modela isso em [consent.ts:36](../src/lib/contacts/consent.ts#L36) e no pipeline de templates | **Não existe.** Não há campo, não há classificação |
| Custo por envio | Sim | Não |
| Onde o erro aparece | Na aprovação — antes de qualquer envio | **Depois do fato**, como reclamação do usuário e queda de *quality rating* |

O ponto não é que mensagem de sessão seja "mais arriscada" que template —
é que **o controle muda de lugar**. No fluxo de template, a Meta é um
revisor prévio: conteúdo problemático é barrado antes de existir. Numa
mensagem de sessão não há revisor nenhum, o que é simultaneamente a
vantagem (sem burocracia, sem custo, é por isso que esta feature vale a
pena) e o risco: **nada impede o autor da automação de escrever algo que a
Meta penalize depois** — e a penalidade não é a rejeição de uma mensagem,
é a reputação do número.

E essa reputação tem consequência mensurável **dentro deste repositório**:
o *quality rating* do número alimenta o tier de mensageria da Meta, que é
exatamente o `TIER_CAPS` de [messaging-limit.ts:36-44](../src/lib/whatsapp/messaging-limit.ts#L36-L44) — o teto de
contatos por disparo em lote (§2.1, conceito #2). Uma automação de
reengajamento mal escrita não degrada só a si mesma: **ela encolhe a
capacidade de broadcast da conta inteira**, num módulo que nem sabe que
ela existe.

Consequências práticas para esta entrega, todas de baixo custo:

1. O hint no builder não deve ser genérico ("cuidado com spam"), e sim
   dizer o que está em jogo: este texto **não passa por aprovação da
   Meta** e responde pela reputação do número.
2. O template pré-configurado de §5.8 é a principal ferramenta pedagógica
   disponível — ele deve exemplificar uma pergunta de utilidade real, não
   um "oi, ainda está aí?".
3. O guardrail de anti-fadiga (§5.6, item 5) deixa de ser refinamento
   opcional e vira a mitigação mais direta que o CRM pode oferecer, se e
   quando a frequência virar problema observado.

## 9. Plano de implementação em fases

| Fase | Entrega | Depende de |
|---|---|---|
| 1 | `session-window.ts` (função pura + testes) + migração 052: coluna `last_customer_message_at`, índice parcial, backfill, tabela `automation_window_claims` (com `sent_at`/`failed_at`/`reopened_at`, §5.5.5) + escrita **monotônica com o timestamp da Meta** no webhook (§5.2.1) + adoção da função no `message-thread.tsx` (§5.9 — dois bugs, uma importação) | — |
| 2 | Guarda em `runStep()` para `send_message`/`send_buttons`/`send_list` (recálculo no momento do envio) + campo `on_window_closed` + `fallback_template` aninhado (§5.3.4) + UI correspondente (incluindo o merge de `step_config` de §5.3.1) | Fase 1 |
| 3 | Subject `session_window` no `condition` (engine + UI + validate.ts) | Fase 1 |
| 4 | Trigger `session_window_expiring` + `runSingleAutomation()` (§5.5.3) + fase de varredura dentro de `/api/automations/cron` com `maxDuration`/`after()` (§5.5.4) + claim (§5.5.2) + guardrails 6–9 (§5.6) + UI de `trigger_config` + faixa de `margin_minutes` | Fases 1–2 |
| 5 | Template pré-configurado novo (§5.8) + métricas sobre as colunas do claim (§7) | Fases 2–4 |

*(2ª revisão — o que mudou no plano.)* Nenhuma fase nova: os achados de
§0 cabem todos dentro das cinco existentes, e é assim que devem entrar.
Dois deles, porém, mudam a **ordem de risco**: `runSingleAutomation()`
(§5.5.3) é pré-requisito da fase 4 e não pode ser deixado para "depois
que funcionar", porque o bug que ele evita só aparece na segunda
automação — quer dizer, semanas depois do deploy, em produção, na conta
de um cliente. E a escrita monotônica da fase 1 (§5.2.1) precisa estar
certa **antes** do backfill: uma âncora escrita errada é dado corrompido
silenciosamente, não um comportamento errado que se conserta com deploy.

*(Retificado nesta revisão.)* As fases 1–2 **não consertam
retroativamente** o `follow_up_reminder` (§2.4) nem nenhuma outra
automação já existente: pelo default de leitura `'fail'` (§5.3.2/§5.3.3),
o comportamento delas no dia do deploy é idêntico ao de hoje, mudando
apenas a mensagem de erro no log — de propósito, para que nenhum deploy
altere silenciosamente uma automação que o autor não revisou. O que as
fases 1–2 entregam é **a ferramenta** para o autor consertar: abrir a
automação e escolher `'skip'` ou `'fallback_template'`. Ainda assim são um
corte intermediário defensável se o prazo apertar, porque destravam a
correção manual sem depender do trigger novo.

## 10. Perguntas em aberto (decisões de produto, não técnicas)

> As três primeiras seguem abertas por serem escolhas de produto — a 2ª
> revisão acrescentou recomendação escrita às perguntas 1 e 2, sem
> fechá-las. A quarta era técnica e foi resolvida na 1ª revisão — fica
> riscada aqui, em vez de apagada, para que a decisão e o motivo dela não
> se percam. As perguntas 5 a 8 são novas da 2ª revisão: nenhuma bloqueia
> a fase 1, e todas precisam de resposta antes da fase 4.

1. Margem padrão para "janela fechando" — 4h é um chute razoável (dá tempo
   de o cliente ver e responder), mas é uma decisão de produto, não técnica.
   *(2ª revisão — um argumento a favor de 4h, para a decisão não ser só
   gosto: a margem também define a **largura da faixa** em que a conversa
   fica elegível (§5.7.1), e portanto o tamanho do lote por tick. Margem
   grande = mais conversas elegíveis simultaneamente = pico de envio,
   justamente na hora em que §5.5.4 conta os milissegundos. 4h é grande o
   bastante para o cliente ver e responder e pequena o bastante para o
   lote ser plano.)*
2. O disparo de reengajamento deve respeitar o `send-window.ts` (horário
   comercial) mesmo que isso signifique perder a janela por estar fora do
   horário permitido? Ou a natureza "urgente" (janela fechando) justifica
   ignorar o horário comercial? *(2ª revisão: segue sendo decisão de
   produto, mas agora com **recomendação escrita e justificada** —
   respeitar a janela, ver §5.6, item 9. A recomendação assume que
   perder um reengajamento é mais barato que um disparo às 04h; quem
   discordar tem o caminho do meio ali descrito.)*
3. Vale, já nesta entrega, também consertar o `follow_up_reminder` existente
   (trocar seu `wait 1 day` por uma lógica que respeite a janela), ou ele
   fica como está e só o novo template (§5.8) é oferecido? *(Ganhou peso
   depois de §5.3.3: sem tocar nele, o template continua semeando
   automações com o bug em toda conta nova que o escolher.)*
4. ~~`last_customer_message_at` — popular via trigger de banco
   (`AFTER INSERT`) ou no código do webhook?~~ **Resolvido nesta revisão
   (§5.2): escrita no webhook.** Deixou de ser preferência de time quando
   se verificou que existe um único ponto de INSERT com
   `sender_type: 'customer'` em todo o `src/` ([webhook/route.ts:749](../src/app/api/whatsapp/webhook/route.ts#L749)) e
   que ele já faz um UPDATE em `conversations` logo em seguida
   ([:773-781](../src/app/api/whatsapp/webhook/route.ts#L773-L781)) — é uma linha, não um objeto de banco novo. Se
   um segundo escritor de mensagem de cliente aparecer, aí sim o trigger
   `AFTER INSERT` passa a valer o custo. *(2ª revisão: a decisão fica de
   pé, mas por pouco. O eixo que a fechou era "quantos escritores existem";
   §5.2.1 mostrou um segundo eixo — **monotonicidade e fonte do
   timestamp** — em que o trigger é naturalmente superior (`GREATEST` no
   próprio statement, `NEW.created_at` sem chance de divergir do INSERT).
   Com a escrita filtrada de §5.2.1(a) o webhook empata; sem ela, perde.)*

**Perguntas novas da 2ª revisão:**

5. **A varredura deve pular conversa atribuída a um agente humano?**
   (§5.6, item 8.) É a única das quatro novas em que as duas respostas
   são defensáveis e o repositório não tem precedente que decida — a
   auto-resposta de IA consulta `assigned_agent_id`, mas para um caso
   diferente (não falar por cima de quem está atendendo *agora*).
6. **Reengajar conversa em `pending`, ou só `open`?** (§5.2.) A resposta
   vira predicado de índice parcial, então é mais barato decidir antes
   do que depois.
7. **O `fallback_template` deve respeitar opt-out?** (§5.3.4.) A
   recomendação é sim, pela categoria do template, mas isso cria uma
   assimetria explícita com o `send_template` manual, que continua sem
   checar nada. Assumir a assimetria ou puxar o item 2 de §4 para dentro
   desta entrega é escolha de escopo.
8. **A guarda de §5.3 deve mudar o `status` do log de `failed` para algo
   como `skipped`?** Hoje `AutomationLogStatus` é
   `'success' | 'partial' | 'failed'` ([types/index.ts:567](../src/types/index.ts#L567)) e um step
   pulado por janela fechada não é nenhum dos três com honestidade —
   `'success'` mente, `'failed'` polui a métrica de §7. Acrescentar um
   valor mexe num enum lido por telas existentes; usar `'success'` com
   detalhe textual é o caminho barato. Decisão de produto sobre o que a
   tela de logs deve mostrar.

## 11. Testes e rollout

*(Seção acrescentada nesta revisão — a SPEC 044 tem uma §10 equivalente e
o padrão do repositório é ter uma.)*

### 11.1 Testes

Vitest, arquivos `*.test.ts` ao lado do código
([vitest.config.ts](../vitest.config.ts), `include: src/**/*.test.ts`), rodados por
`npm run test`. Duas peças de infraestrutura já existem e devem ser
reusadas em vez de recriadas: `src/lib/broadcasts/send-window.test.ts`
(molde de teste de função pura de janela) e
`src/lib/automations/engine.test.ts` (524 linhas, com um mock do cliente
service-role em bloco `vi.hoisted` que intercepta por tabela — basta
acrescentar `conversations` ao `resolve()` para devolver
`last_customer_message_at`).

| Alvo | Casos |
|---|---|
| `computeSessionWindow` | `null` (contato nunca escreveu) → fechada; exatamente 24 h → fechada (fechamento exclusivo, mesma convenção de `send-window`); 23 h 59 min → aberta com `minutesRemaining = 1`; janela já vencida → `minutesRemaining` negativo; travessia de horário de verão; `now` injetado (nenhum teste pode depender do relógio real) |
| Guarda de §5.3 no engine | janela aberta → envia como hoje; fechada + campo ausente no JSONB → falha **sem chamar a Meta** (o mock de `meta-send` não pode receber chamada); fechada + `'skip'` → não envia e a automação **continua** para o próximo step; fechada + `'fallback_template'` → chama `engineSendTemplate` com o nome configurado; `send_template` nunca passa pela guarda |
| Default de leitura × escrita (§5.3.2) | `step_config` sem o campo é lido como `'fail'`; `blankConfig('send_message')` devolve `'skip'` — os dois no mesmo arquivo de teste, porque o valor da asserção está na diferença |
| Merge de `step_config` interativo (§5.3.1) | Regressão dedicada: definir `on_window_closed`, aplicar uma edição do `InteractiveBuilder`, asserir que o campo **sobreviveu**. É o teste que impede o bug de voltar numa refatoração futura |
| Subject `session_window` | `open`/`closed`/`closing_soon` com âncora controlada; `closing_soon` respeita `cfg.value` e cai em 240 quando ausente; **contato sem conversa devolve `false` em vez de lançar** (§5.4); execução retomada de `wait` lê a conversa da `context` serializada |
| Claim de idempotência (§5.5.2) | Dois claims com a mesma `(automation_id, conversation_id, window_anchor)` → o segundo não dispara; âncora diferente (cliente respondeu) → dispara de novo; automações distintas com a mesma conversa → **ambas** disparam (é o comportamento desejado, item 4 de §5.6) |
| Varredura | Conta sem automação ativa do trigger não gera query de conversas; conversa `closed` não entra; contato `opted_out` não entra; `LIMIT` respeitado |
| `validateTriggerForActivation` | `margin_minutes` = 1 → rejeitado; 14 → rejeitado; 15 → aceito; 1441 → rejeitado; não inteiro → rejeitado; ausente → assume o default |

*(Casos acrescentados na 2ª revisão — cada um corresponde a um achado de
§0, e todos são de função pura ou de mock já existente:)*

| Alvo | Casos |
|---|---|
| **Despacho por automação** (§5.5.3) | Duas automações ativas do trigger na mesma conta, **uma** conversa elegível → exatamente **2** envios (um por automação), não 4. É o teste que prova o achado nº 1; sem ele a regressão volta na primeira refatoração que "simplificar" para `runAutomationsForTrigger`. O mock de `meta-send` conta chamadas — a asserção é sobre o contador, não sobre o log |
| **Âncora monotônica** (§5.2.1) | Webhook com timestamp **anterior** ao já gravado → `last_customer_message_at` **não** muda; timestamp posterior → avança; primeira mensagem (coluna `null`) → grava. E: a âncora gravada é `message.timestamp * 1000`, **não** `Date.now()` — com `vi.useFakeTimers` afastando os dois, é uma asserção de igualdade exata |
| **Guardrail "bola do nosso lado"** (§5.6, item 6) | Conversa cuja última mensagem é do cliente não entra na fase B; a mesma conversa, depois de uma resposta do agente, entra |
| **Colisão com Flow** (§5.6, item 7) | Contato com `flow_runs` ativo não entra; com run `timed_out` entra |
| **Ciclo de vida do claim** (§5.5.5) | Envio bem-sucedido preenche `sent_at`; despacho que lança preenche `failed_at` e **não** `sent_at`; mensagem do cliente depois do claim preenche `reopened_at` |
| **Hint do inbox** (§5.9) | `messages: []` (thread carregando) → tratado como **fechada**, não aberta — hoje o componente devolve `expired: false`; 30 min restantes → o rótulo de minutos aparece (hoje é ramo morto) |

Não há teste automatizado de ponta a ponta do cron (não existe hoje para
`/api/automations/cron` nem para `/api/broadcasts/cron`); a verificação da
fase 4 é manual, descrita abaixo.

### 11.2 Rollout

Não há feature flag no projeto para este tipo de mudança, e introduzir uma
não se justifica aqui — a exposição é controlada pela própria natureza do
produto: **nenhuma automação existente muda de comportamento no deploy**
(§5.3.3), e o trigger novo só age depois que alguém o escolher e ativar.

Ordem e verificação por fase:

| Fase | Verificação |
|---|---|
| 1 | Migração 052 aplicada em `vn` e `rs` (o repositório verifica migração nos dois projetos — ver o Status da SPEC 044). Conferir que o backfill preencheu `last_customer_message_at` das conversas antigas e que `EXPLAIN` da query da fase B usa `idx_conversations_last_customer_msg` |
| 2 | Uma automação de teste com `wait` curto + `send_message` em conversa com janela fechada: log deve trazer a mensagem nova, não o 400 da Meta |
| 3 | Automação com `condition session_window` nos dois branches |
| 4 | Com o cron rodando, confirmar em `net._http_response` (consulta 3 da seção de conferência de `cron-jobs.sql`) que a rota segue devolvendo 200 e que o corpo passa a reportar também o resultado da varredura. **Rodar dois pings manuais sobrepostos** (dois `curl` simultâneos com o header) e asserir que só um envio saiu — é a validação prática do claim de §5.5.2. *(2ª revisão:)* medir também **quanto tempo** o tick levou com a varredura ligada, e comparar com o `maxDuration` declarado (§5.5.4) — o corte por timeout não gera erro visível na aplicação, só uma resposta truncada em `net._http_response` |
| 5 | Template novo criado a partir da UI gera os steps esperados |

Três pontos que o rollout **não** exige, e vale registrar para ninguém
gastar tempo com eles:

- **Nenhuma ação do operador no cron** — é a razão de §5.5.1. Se em algum
  momento a decisão for revertida para um endpoint separado, esta linha
  vira o oposto: um passo obrigatório de migração operacional, para todo
  deploy e todo fork, e ele precisa entrar no `README`.
- **Nenhuma migração de dados de automações existentes** — o default de
  leitura (§5.3.2) torna o JSONB antigo válido como está. Um `UPDATE` em
  massa para "preencher" `on_window_closed` seria justamente a mudança
  silenciosa de comportamento que a §5.3.3 evita.
- **Nenhum rollback especial de banco** — a 052 só acrescenta (coluna,
  índices, tabela). Reverter o código deixa a coluna populada e a tabela
  de claims ociosas, sem efeito.

## 12. Modelo (LLM) e estratégia de sessões por unidade de trabalho

*(3ª revisão — 2026-08-09. As duas versões anteriores desta seção
recomendavam um modelo por fase; isso deixou de ser granular o
suficiente depois que §0/§9 quebraram a fase 4 em cinco sub-entregas com
uma ordem de risco própria, e depois que a 2ª revisão mostrou que os
achados mais graves são erros de composição **entre arquivos**, não
dentro de um arquivo só — o que é uma variável de *sessão* (o que o
modelo tem lido antes de escrever ou revisar aquele trecho), não só de
modelo. As duas perguntas — "qual modelo" e "que contexto essa sessão
precisa carregar antes de começar" — são respondidas juntas abaixo,
unidade por unidade, em vez de por fase inteira.)*

### 12.1 Por que "revise este diff" não basta aqui

Dos dez achados de §0, os três mais graves (nº 1, 2 e 4) têm a mesma
forma — *duas peças, cada uma correta, lidas em arquivos diferentes*:

| Achado | Peça A | Peça B | O erro só existe no encontro |
|---|---|---|---|
| nº 1 | O claim de §5.5.2 (correto) | `runAutomationsForTrigger` executa N automações do trigger, [engine.ts:103-108](../src/lib/automations/engine.ts#L103-L108) (correto) | O loop de claim é por automação → N² execuções, envio duplicado |
| nº 2 | O INSERT da mensagem usa o timestamp da Meta, [webhook:759](../src/app/api/whatsapp/webhook/route.ts#L759) | O UPDATE vizinho usa `new Date()`, [webhook:773-781](../src/app/api/whatsapp/webhook/route.ts#L773-L781) | §5.2 mandava só "estender o UPDATE que já existe" — sem dizer que ele usa outra fonte de tempo |
| nº 4 | `/api/broadcasts/cron` declara `maxDuration = 300` e faz fan-out em `after()`, [broadcasts/cron:73](../src/app/api/broadcasts/cron/route.ts#L73) | `/api/automations/cron` não declara `maxDuration` | §5.5.1 move trabalho pesado (até 200 envios síncronos) para a rota sem teto |

Uma revisão que só olha o *diff* da fase 4 nunca vê a Peça B desses três
achados — ela mora em `engine.ts` ou em `broadcasts/cron/route.ts`,
fora do diff. Uma sessão (do escritor ou do revisor) que não carregou
essas peças de antemão reproduz o mesmo ponto cego, independentemente de
qual modelo estiver rodando nela. Por isso a tabela de 12.2 tem uma
coluna de **leitura obrigatória antes de começar**, não só "qual
modelo" — é a lição prática da 2ª revisão, não uma preferência de
estilo.

### 12.2 Unidade de trabalho → modelo → sessão

| # | Unidade | Escreve | Revisa | Leitura obrigatória antes de escrever/revisar | Sessão |
|---|---|---|---|---|---|
| — | Esta SPEC (análise + redação) | Sonnet 5 (já feito) | — | — | — |
| — | 1ª e 2ª revisão arquitetural (já feitas) | — | Opus 5 | Todo `engine.ts`, `automation-builder.tsx`, migração 006, `webhook/route.ts` (blocos 749–909) | Subagente único, foreground, por revisão |
| 1a | `session-window.ts` + testes | Sonnet 5 | — | `send-window.ts` + `.test.ts` (molde) | Sessão principal |
| 1b | Migração 052 (coluna, índice, tabela de claim com `sent_at`/`failed_at`/`reopened_at`) | Sonnet 5 | — | `006_automations.sql`, `044…051` (convenção de migração idempotente do repo) | Sessão principal |
| **1c** | **Escrita monotônica da âncora no webhook (§5.2.1)** | Sonnet 5 | **Opus 5 — antes de rodar o backfill em qualquer ambiente real** | `webhook/route.ts` inteiro (não só 773–781) | Sessão principal — **não delegar a subagente isolado**: é o tipo de erro (achado nº 2) que só aparece lendo o arquivo inteiro, não o trecho vizinho ao ponto de inserção |
| 1d | Adoção de `computeSessionWindow` em `message-thread.tsx` (§5.9) | Sonnet 5 | — | — (é substituição de código já lido em 1a) | Sessão principal |
| 2 | Guarda em `runStep()` + `on_window_closed` + `fallback_template` aninhado (§5.3.4, checagem de opt-out) + UI (merge de §5.3.1) | Sonnet 5 | Opus 5, junto com a unidade 3 | `runStep()` inteiro, `consent.ts`, `InteractiveBuilder` (onde o merge de §5.3.1 acontece) | Sessão principal, sequencial após fase 1 mergeada |
| 3 | Subject `session_window` em `evaluateCondition()` + UI + `validate.ts` | Sonnet 5 | Opus 5, junto com a unidade 2 | `evaluateCondition()` inteiro | Mesma sessão da unidade 2 (funções vizinhas no mesmo arquivo — revisar as duas juntas é mais barato que duas passadas) |
| **4a** | **`runSingleAutomation()` — extração que resolve o N² do achado nº 1** | Sonnet 5 | **Opus 5 — checkpoint isolado, antes de 4b–4e** | `runAutomationsForTrigger`, `executeAutomation`, `resumePendingExecution` (as três funções de `engine.ts` que compõem o caminho hoje) | Sessão principal. Pré-requisito explícito do plano (§9): errar aqui contamina tudo que a fase 4 constrói em cima |
| 4b | Tabela de claim + `ON CONFLICT DO NOTHING` usando `runSingleAutomation()` (§5.5.2) | Sonnet 5 | — (coberto pela revisão de 4e) | — | Sessão principal |
| 4c | Varredura em `/api/automations/cron` com `maxDuration` + `after()` (§5.5.4) | Sonnet 5 | — (coberto pela revisão de 4e) | `broadcasts/cron/route.ts` inteiro (molde do `maxDuration`/fan-out) | Sessão principal |
| 4d | Guardrails 6–9 de §5.6 (bola do nosso lado, colisão com Flow ativo, opt-out, status da conversa) | Sonnet 5 | — (coberto pela revisão de 4e) | `flow_runs` ([010_flows.sql:189](../supabase/migrations/010_flows.sql#L189)), `consent.ts` | Sessão principal |
| 4e | UI de `trigger_config` (`margin_minutes` ≥ 15) | Sonnet 5 | **Opus 5 — checkpoint final da fase 4, cobre 4b–4e juntas** | Tudo que 4a–4d escreveram nesta sessão (já está no contexto) | Mesma sessão de 4a–4d |
| — | **Gate de runtime da fase 4** (não é revisão de código) | — | — | Rodar dois `curl` simultâneos contra o cron (já descrito em §11.2) e confirmar que só um envio saiu | Ambiente de teste, depois do merge de 4a–4e |
| 5a | Template pré-configurado (§5.8) | Sonnet 5 | — | — | Sessão principal ou nova — baixo acoplamento |
| 5b | Métricas sobre colunas do claim (§7) | Sonnet 5 | — | — | Mesma sessão de 5a |

### 12.3 Paralelização: o que não vale a pena tentar

Fases 2 e 3 tocam funções vizinhas no mesmo arquivo (`runStep` e
`evaluateCondition` em `engine.ts`) e **poderiam**, em tese, ir para dois
worktrees isolados e rodar em paralelo. Não é recomendado aqui: o ganho
de tempo é pequeno (são as duas menores unidades depois da 1) e o custo
é reintroduzir exatamente o modo de falha que a 2ª revisão documentou —
um agente em worktree isolado, sem o histórico da sessão principal, não
carrega de graça os comentários de segurança já existentes em
`engine.ts` (ex. [:478-496](../src/lib/automations/engine.ts#L478-L496), o aviso de *defense in depth* do
`assign_conversation`) nem o motivo pelo qual `on_window_closed` tem
default de leitura diferente do de escrita (§5.3.2) — teria que
redescobrir os dois, com o risco de redescobrir errado. A fase 4 (4a–4e)
pela mesma razão fica inteira em uma sessão só, mesmo sendo a maior: o
próprio §9 já registra que separar `runSingleAutomation()` "para depois"
é o erro, e o mesmo raciocínio vale para separá-lo numa sessão que não
viu o resto.

A única paralelização real disponível é entre **fase 1** e a preparação
de UI/textos de tradução (`messages/en.json`/`pt-BR.json`) que as fases
2–5 vão precisar — trabalho sem dependência de dado, que pode ser feito
numa sessão separada enquanto a fase 1 é revisada.

### 12.4 Resumo

Nenhuma unidade justifica Haiku (todas tocam tenant isolation,
idempotência ou fidelidade de dado — nada é texto puro ou boilerplate
repetitivo). Nenhuma unidade precisa de Opus para *escrever* — o padrão
já existe no repo para todas elas (`send-window.ts`, `broadcasts/cron`,
os quatro subjects existentes de `evaluateCondition`). Opus entra em
exatamente **quatro** checkpoints de revisão (1c, 2+3, 4a, 4e) mais o
gate de runtime da fase 4 — não em cada unidade, e nunca sem a leitura
obrigatória da coluna correspondente em 12.2, porque uma revisão sem
esse contexto tem, na prática já observada em duas rodadas desta SPEC,
o mesmo ponto cego que a escrita original.
