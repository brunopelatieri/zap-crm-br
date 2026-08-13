# PRD 047 — Canais de comunicação e WhatsApp via QRCode (Evolution Go)

| Campo             | Valor                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| Status            | **Rascunho — aguardando aprovação das decisões da §4**                                 |
| Autor             | Elaborado com Claude Opus 5, a pedido de Bruno Pelatieri                                |
| Data              | 2026-08-12                                                                              |
| Versão do produto | ZAP CRM BR sobre Next.js 16.2.6 / React 19.2.4 / Supabase                                |
| Migrações         | A partir de **055** (a última aplicada é a 054)                                          |
| Referências       | [SPEC 045](./spec-045-reengajamento-janela-24h.md), [SPEC 046](./spec-046-agendamento-visual.md) |

---

## 1. Resumo executivo

Hoje o ZAP CRM BR fala **um único idioma**: a WhatsApp Cloud API oficial da Meta. Toda a
aplicação — inbox, contatos, funis, automações, flows, IA, disparos — assume que existe
exatamente **uma** `whatsapp_config` por conta e que toda mensagem entra e sai por ela.

Este PRD descreve duas entregas que só fazem sentido juntas:

1. **Uma camada de canais** (`channels`) que transforma "o WhatsApp da conta" em "um canal
   entre vários", com uma interface de adaptador, uma matriz de capacidades e um caminho
   único de ingestão de mensagens. É a fundação que permite, depois, plugar um segundo
   número Cloud API, Instagram Direct, Messenger ou e-mail **sem tocar no inbox de novo**.
2. **O primeiro canal novo sobre essa camada**: WhatsApp não-oficial via QRCode, através de
   uma instância **Evolution Go** rodando em VPS, consumida por API.

O critério de sucesso não é "o QRCode funciona". É: **o segundo canal novo custar uma
fração do primeiro**.

> 📘 **Fonte de verdade da API:**
> [`docs/references/EVOLUTION_GO_REFERENCE.md`](./references/EVOLUTION_GO_REFERENCE.md) —
> os 59 endpoints com schema de request/response, payloads reais de webhook por evento,
> variáveis de ambiente da VPS e bugs conhecidos, compilado das specs OpenAPI oficiais.
> Este PRD **não duplica** aquele conteúdo: referencia.
>
> ⚠️ Havia um guia antigo (`evolution_go-guide-api.md`, removido deste repositório em
> 2026-08-13 por estar desatualizado) que descrevia endpoints no formato da **Evolution API
> v2** (`/message/sendText/{instanceName}`, `/instance/{name}/qrcode`) — **incorreto** para a
> Evolution Go. A própria referência nova documenta essa divergência: os guias narrativos do
> site oficial contradizem as páginas geradas do OpenAPI, e são estas últimas que valem. A
> fase **F0** (§13) continua sendo bloqueante — documentação autoconsistente ainda não é a sua
> VPS rodando.

---

## 2. Contexto: onde o acoplamento vive hoje

Levantamento feito diretamente no código. Cada item abaixo é um ponto que **precisa mudar**
para que exista mais de um canal.

| # | Acoplamento                                                                                                                                                       | Onde                                                                                                                                                                                    |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `whatsapp_config` é **uma linha por conta** (`UNIQUE(account_id)`), lida por `account_id` em toda parte                                                            | [whatsapp-config.tsx:126](../src/components/settings/whatsapp-config.tsx#L126), [resolve-conversation.ts:58](../src/lib/whatsapp/resolve-conversation.ts#L58)                          |
| 2 | O webhook resolve a **conta** a partir do `phone_number_id` da Meta                                                                                               | [webhook/route.ts:293](../src/app/api/whatsapp/webhook/route.ts#L293)                                                                                                                    |
| 3 | `UNIQUE(account_id, contact_id)` em `conversations` — **uma conversa por contato, ponto**                                                                          | [036_conversation_contact_dedup.sql:125](../supabase/migrations/036_conversation_contact_dedup.sql#L125)                                                                                   |
| 4 | **Cinco caminhos de saída independentes**, cada um carregando `whatsapp_config` e chamando `meta-api` direto: composer/API pública, automações, flows, IA, disparos | [send-message.ts](../src/lib/whatsapp/send-message.ts), [automations/meta-send.ts](../src/lib/automations/meta-send.ts), [flows/meta-send.ts](../src/lib/flows/meta-send.ts), [broadcast-core.ts](../src/lib/whatsapp/broadcast-core.ts), [ai/auto-reply.ts](../src/lib/ai/auto-reply.ts) |
| 5 | A ingestão inbound (contato → conversa → mensagem → flows → automações → IA → webhook de saída) vive **dentro da rota** do webhook da Meta, com ~400 linhas         | [webhook/route.ts:623-1024](../src/app/api/whatsapp/webhook/route.ts#L623)                                                                                                               |
| 6 | Conceitos exclusivos do oficial estão espalhados sem guarda: templates, janela de 24h (`last_customer_message_at`), limite de mensagens, botões/listas interativos | SPEC 044, SPEC 045, `messaging-limit.ts`, `interactive.ts`                                                                                                                                |

O item **4** é a dívida central. Cada motor reimplementa "carrega config → decripta token →
tenta variantes de telefone → chama Meta → grava `messages` → atualiza `conversations`". Sem
consolidar isso, adicionar um canal significa **cinco** implementações novas, e o próximo
canal, mais cinco.

---

## 3. Princípios de design

1. **Canal é rota, contato é identidade.** O contato continua único por telefone dentro da
   conta (dedupe da migração 022 preservado). Tags, funil, notas, campos personalizados e
   histórico são **compartilhados entre canais por construção** — não há sincronização a
   escrever, porque não há duplicata a sincronizar.
2. **Capacidade é dado, não `if`.** O que um canal sabe fazer (template? botão? enquete?
   disparo?) vive numa matriz declarativa. UI, validação de automações e runtime leem a
   mesma fonte. Um canal novo declara suas capacidades e a interface se adapta sozinha.
3. **Um caminho de entrada, um caminho de saída.** Todo inbound converge para
   `ingestInboundMessage()`; todo outbound passa por `sendViaChannel()`. Webhooks de
   provedores viram **tradutores finos**.
4. **Simples é mais.** Nenhuma tabela de "unificação de contatos", nenhuma fila de
   sincronização, nenhum motor de merge. O compartilhamento entre canais é consequência do
   modelo, não uma funcionalidade.
5. **Degradar com aviso, nunca em silêncio.** Um canal que não suporta uma ação **avisa no
   editor** (antes) e **registra o motivo** (depois). A armadilha conhecida do projeto —
   "agendamento não dispara, sem erro" — não pode se repetir aqui.
6. **Não-oficial é não-oficial.** A UI diz isso na cara, com os riscos, sem eufemismo.

---

## 4. Decisões que precisam da sua aprovação

Estas três mudam schema e escopo. Estão marcadas com a recomendação assumida no restante do
documento; se você discordar de alguma, avise antes da F1.

### D-1 — Controle do limite de instâncias · **recomendação: híbrido**

Você propôs variável de ambiente e pediu alternativa melhor se houvesse. Há:

| Camada                                   | O quê                                                       | Por quê                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT`    | Teto padrão por conta (ex.: `3`)                             | Mantém o padrão do projeto: integração se configura por `.env`, como Supabase                                                |
| `accounts.evolution_instance_limit`      | Override por conta, **nullable** (NULL = usa o env)          | Libera exceção para um cliente **sem redeploy e sem reiniciar o app**. Uma coluna, um `COALESCE`.                            |
| `EVOLUTION_MAX_INSTANCES_TOTAL`          | Teto global do deployment (ex.: `20`)                        | O env por conta **não protege a VPS**: 10 contas × 3 instâncias = 30 sessões whatsmeow. Este é o único que protege o recurso. |

Regra efetiva: `limite = COALESCE(accounts.evolution_instance_limit, EVOLUTION_MAX_INSTANCES_PER_ACCOUNT)`,
e a criação também falha se o total do deployment já atingiu `EVOLUTION_MAX_INSTANCES_TOTAL`.
Custo: uma coluna na migração 056. Benefício: a exceção comercial deixa de ser um deploy.

### D-2 — Conversa quando o contato fala pelos dois canais · **recomendação: uma thread por canal**

Uma conversa por **(conta, contato, canal)** — troca do índice `UNIQUE(account_id, contact_id)`
por `UNIQUE(account_id, contact_id, channel_id)`.

Motivo: responder é uma ação **roteada**. Numa thread única intercalada, "responder" fica
ambíguo (por qual canal?), e a janela de 24h — que só existe no oficial — passaria a ser
calculada sobre mensagens que não a abrem. Com thread por canal, cada thread tem uma resposta
óbvia, um badge, e as regras do seu canal. O contato continua um só, então o operador vê o
histórico completo na ficha lateral.

Custo: a migração precisa **relaxar** o índice da 036, não removê-lo — a proteção contra
duplicatas continua valendo dentro de cada canal.

> **Impacto na SPEC 045 (janela de 24h): mapeado e coberto na [§7.1](#71-garantias-sobre-a-janela-de-24h-spec-045).**
> São 8 pontos de contato; 4 quebram sem guarda — e o pior deles **não é o índice**: é o
> `checkWindowGuard`, que hoje roda antes de todo envio de automação e reprovaria 100% dos
> envios no canal QR. A §7.1 traz a correção (uma função, não quatro `if`s), o filtro da
> varredura, a asserção na migração e os 5 critérios de aceite verificáveis.

### D-3 — Histórico do aparelho ao parear (`HISTORY_SYNC`) · **recomendação: ignorar no MVP**

Ao parear, o WhatsApp sincroniza histórico do celular. Consumir isso criaria centenas ou
milhares de contatos e conversas de uma vez — com risco real de **disparar automações e IA
retroativamente**. No MVP o evento é recebido, contado numa métrica e descartado. Importação
de histórico vira um recurso próprio depois, com teto configurável e supressão explícita de
motores.

---

## 5. Escopo

### 5.1 Dentro

- Camada `channels` + adaptadores + matriz de capacidades + ingestão unificada.
- Gerenciamento pleno de instâncias Evolution Go: criar, conectar (QRCode **e** código de
  pareamento), status, desconectar, deslogar, excluir, editar rótulo e proxy, re-registrar
  webhook.
- Aba dedicada **"WhatsApp QRCode"** em Configurações (`/settings?tab=whatsapp-qrcode`).
- Mensageria completa no canal QR: texto, mídia (imagem/vídeo/áudio/documento), localização,
  enquete, reação, resposta citada, indicador de digitação, marcar como lida.
- Inbox multicanal: filtro por canal, badge de canal, composer sensível a capacidade.
- Automações, flows, agentes de IA, funis, notificações e contatos operando em canal QR.
- API pública `/api/v1` e webhooks de saída cientes de canal (aditivo, sem quebra).

### 5.2 Fora

- **Disparo em massa em canal QR** — proibido por regra de produto, com guarda em UI e runtime.
- **Templates da Meta em canal QR** — não existe o conceito.
- Grupos, comunidades, newsletters, labels do WhatsApp (a Evolution Go oferece; não é escopo).
- Importação de histórico do aparelho (D-3).
- Segundo número Cloud API, Instagram, Messenger, e-mail — a fundação prepara, este PRD não entrega.
- Balanceamento/failover automático entre instâncias.

---

## 6. Arquitetura alvo

### 6.1 Modelo de canais

```
accounts
   └── channels                       registro único de todo canal da conta
         ├── (type='whatsapp_cloud')  → whatsapp_config     (1:1, tabela existente)
         └── (type='whatsapp_qr')     → evolution_instances (1:1, tabela nova)
                                          └── evolution_instance_secrets (tokens, service_role)
conversations.channel_id → channels.id
```

`channels` é o **registro**; a configuração específica do provedor fica na tabela dele. Isso
mantém `whatsapp_config` intacta (zero regressão no oficial) e evita um `jsonb` genérico que
ninguém consegue validar.

### 6.2 Matriz de capacidades — `src/lib/channels/capabilities.ts`

```ts
export interface ChannelCapabilities {
  text: boolean;
  media: { image: boolean; video: boolean; audio: boolean; document: boolean };
  ptt: boolean;                 // áudio "gravado na hora"
  location: boolean;
  poll: boolean;
  interactiveButtons: boolean;
  interactiveList: boolean;
  templates: boolean;
  reactions: boolean;
  replyQuote: boolean;
  editMessage: boolean;
  deleteForEveryone: boolean;
  typingIndicator: boolean;
  markRead: boolean;
  deliveryReceipts: boolean;
  broadcast: boolean;           // disparo em massa
  sessionWindow24h: boolean;    // regra de janela da Meta
  messagingLimit: boolean;      // tier de limite da Meta
}
```

| Capacidade          | `whatsapp_cloud` | `whatsapp_qr` | Observação                                              |
| ------------------- | ---------------- | ------------- | ------------------------------------------------------- |
| Texto, mídia        | ✅               | ✅            | `/send/text`, `/send/media`                             |
| PTT (áudio gravado) | ✅               | ⚠️ validar F0 | **Não há endpoint dedicado** — `/send/media` com `type: audio`; confirmar se sai como PTT ou como arquivo |
| Localização         | ✅               | ✅            | `/send/location`                                        |
| Enquete             | ❌               | ✅            | Único mecanismo interativo nativo do QR                 |
| Link com preview    | ❌ (inline)      | ✅            | `/send/link`, com Open Graph automático                 |
| Contato (vCard)     | ✅               | ✅            | `/send/contact`                                         |
| Figurinha           | ❌               | ✅            | `/send/sticker`, converte para WebP sozinho             |
| Botões / Lista      | ✅               | ❌ **testado**    | Os endpoints **existem** (`/send/button`, `/send/list`, `/send/carousel`), mas o WhatsApp **recusa**: `500 {"error":"server returned error 405"}` em teste real, determinístico. Ver [SPEC 048 §1.1-bis](./spec-048-canal-whatsapp-qrcode.md) |
| Templates           | ✅               | ❌            | Conceito exclusivo da Meta                              |
| Editar / Apagar     | ❌               | ✅            | `/message/edit`, `/message/delete`                      |
| Reação              | ✅               | ✅            | `/message/react`                                        |
| Digitando…          | parcial          | ✅            | `/message/presence` (`composing`/`recording`/`paused`)  |
| Marcar como lida    | ✅               | ✅            | `/message/markread`                                     |
| Verificar número    | ❌               | ✅            | `/user/check` — pode alimentar `contacts.whatsapp_status` (SPEC 049) |
| Disparo em massa    | ✅               | ❌            | **Regra de produto**, não limitação técnica             |
| Janela 24h / tier   | ✅               | ❌            | SPEC 045 e limite de mensagens não se aplicam ao QR     |

### 6.3 Adaptador — `src/lib/channels/`

```
src/lib/channels/
  types.ts             ChannelType, ChannelAdapter, NormalizedInbound, SendResult
  capabilities.ts      matriz + helpers (can(channel, 'poll'))
  registry.ts          getAdapter(type) — o único switch por tipo do sistema
  resolve.ts           resolveChannel(db, accountId, channelId?) → canal + credenciais
  ingest.ts            ingestInboundMessage() — caminho único de entrada
  send.ts              sendViaChannel() — caminho único de saída
  adapters/
    whatsapp-cloud.ts  embrulha o lib/whatsapp/meta-api.ts que já existe
    evolution.ts       cliente HTTP da Evolution Go
```

```ts
export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;

  sendText(ctx: ChannelContext, p: SendTextParams): Promise<SendResult>;
  sendMedia(ctx: ChannelContext, p: SendMediaParams): Promise<SendResult>;
  sendLocation?(ctx: ChannelContext, p: SendLocationParams): Promise<SendResult>;
  sendPoll?(ctx: ChannelContext, p: SendPollParams): Promise<SendResult>;
  sendTemplate?(ctx: ChannelContext, p: SendTemplateParams): Promise<SendResult>;
  sendInteractive?(ctx: ChannelContext, p: SendInteractiveParams): Promise<SendResult>;
  sendReaction?(ctx: ChannelContext, p: SendReactionParams): Promise<SendResult>;
  markRead?(ctx: ChannelContext, p: MarkReadParams): Promise<void>;
  setTyping?(ctx: ChannelContext, p: TypingParams): Promise<void>;

  /** Traduz o payload cru do provedor em eventos normalizados. */
  normalizeInbound(raw: unknown): NormalizedInbound[];
}
```

`ChannelContext` = `{ accountId, channel, credentials }` — credenciais já decriptadas pelo
`resolve.ts`, que é o **único** lugar que toca `ENCRYPTION_KEY` para canais.

### 6.4 Ingestão unificada — `ingest.ts`

Extração literal (sem mudança de comportamento) de `processMessage()` do webhook da Meta:

```
NormalizedInbound
  → findOrCreateContact(accountId, phone, name)          [dedupe 022 inalterado]
  → findOrCreateConversation(accountId, contactId, channelId)
  → idempotência: já existe messages(conversation_id, message_id)? → sai
  → insert messages
  → update conversations (last_message_*, unread_count)
  → âncora de janela 24h                                 [SÓ se capabilities.sessionWindow24h]
  → flagBroadcastReplyIfAny                              [SÓ se capabilities.broadcast]
  → detectOptOut / setContactOptIn                       [todos os canais]
  → dispatchInboundToFlows
  → runAutomationsForTrigger
  → dispatchInboundToAiReply
  → dispatchWebhookEvent('message.received', { …, channel_id, channel_type })
```

As duas rotas de webhook viram cascas: verificam autenticidade, chamam `normalizeInbound()`,
iteram `ingestInboundMessage()` dentro de `after()`.

> **Idempotência é requisito novo, não opcional.** O webhook da Meta é assinado por HMAC; o da
> Evolution Go **não tem assinatura nenhuma** e pode reentregar. A checagem por
> `(conversation_id, message_id)` antes do INSERT passa a valer para os dois canais.

### 6.5 Roteamento de saída — `send.ts`

```ts
sendViaChannel({ accountId, conversationId, channelId?, message })
  1. resolve o canal (explícito > canal da conversa > canal padrão da conta)
  2. valida a capacidade exigida pelo tipo de mensagem → SendMessageError('unsupported_by_channel')
  3. valida regras do canal (janela 24h só onde existe)
  4. adapter.sendX()
  5. persiste messages + atualiza conversations   [código único, hoje repetido 5×]
  6. pausa flow ativo se agente humano interveio
```

Os cinco caminhos da §2/#4 passam a chamar isto. `lib/automations/meta-send.ts` e
`lib/flows/meta-send.ts` viram invólucros finos e depois somem.

---

## 7. Modelo de dados

### Migração 055 — fundação de canais

```sql
CREATE TABLE channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id),          -- auditoria
  type          text NOT NULL CHECK (type IN ('whatsapp_cloud','whatsapp_qr')),
  name          text NOT NULL,                                     -- rótulo do usuário
  identifier    text,                                              -- E.164 conectado
  status        text NOT NULL DEFAULT 'disconnected'
                CHECK (status IN ('disconnected','connecting','connected','error','disabled')),
  status_detail text,
  is_default    boolean NOT NULL DEFAULT false,
  connected_at  timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Um canal Cloud API por conta enquanto whatsapp_config for singleton.
CREATE UNIQUE INDEX idx_channels_one_cloud_per_account
  ON channels (account_id) WHERE type = 'whatsapp_cloud';
-- Exatamente um padrão por conta.
CREATE UNIQUE INDEX idx_channels_one_default
  ON channels (account_id) WHERE is_default;

ALTER TABLE whatsapp_config ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE CASCADE;

-- Backfill: toda whatsapp_config existente vira um canal 'whatsapp_cloud' padrão.
-- conversations.channel_id entra na 057, já com o backfill possível.
```

RLS: `SELECT` para membros da conta; `INSERT/UPDATE/DELETE` para `admin+`, seguindo
`whatsapp_config_update` da 017.

### Migração 056 — instâncias Evolution

```sql
CREATE TABLE evolution_instances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id           uuid NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_instance_id   text,                    -- id devolvido pela Evolution
  remote_instance_name text NOT NULL UNIQUE,    -- namespaced (§8.3)
  connected_phone      text,
  connected_jid        text,
  proxy_host           text,
  proxy_port           integer,
  subscribed_events    text[] NOT NULL DEFAULT ARRAY['MESSAGE','SEND_MESSAGE','READ_RECEIPT','CONNECTION','QRCODE'],
  last_qr_at           timestamptz,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Segredos numa tabela à parte: SEM policy de SELECT para usuários.
-- Só o service_role lê. Um SELECT * na UI nunca pode devolver um token.
CREATE TABLE evolution_instance_secrets (
  instance_id             uuid PRIMARY KEY REFERENCES evolution_instances(id) ON DELETE CASCADE,
  instance_token_encrypted text NOT NULL,   -- AES-256-GCM com ENCRYPTION_KEY
  webhook_secret           text NOT NULL,   -- 32 bytes hex, path do webhook
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_evolution_secrets_webhook ON evolution_instance_secrets (webhook_secret);
ALTER TABLE evolution_instance_secrets ENABLE ROW LEVEL SECURITY;  -- nenhuma policy = ninguém, exceto service_role

-- D-1: override por conta. NULL = usa EVOLUTION_MAX_INSTANCES_PER_ACCOUNT.
ALTER TABLE accounts ADD COLUMN evolution_instance_limit integer
  CHECK (evolution_instance_limit IS NULL OR evolution_instance_limit BETWEEN 0 AND 50);
```

### Migração 057 — conversas por canal

```sql
ALTER TABLE conversations ADD COLUMN channel_id uuid REFERENCES channels(id);

UPDATE conversations c SET channel_id = ch.id
  FROM channels ch
  WHERE ch.account_id = c.account_id AND ch.type = 'whatsapp_cloud'
    AND c.channel_id IS NULL;

ALTER TABLE conversations ALTER COLUMN channel_id SET NOT NULL;

-- D-2: relaxa o índice da 036 — a proteção continua, agora por canal.
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel_id);

CREATE INDEX idx_conversations_channel ON conversations (channel_id, last_message_at DESC);
```

**Notas de modelagem**

- `messages` **não** ganha `channel_id`. A mensagem herda o canal da conversa — princípio 4.
  Consultas por canal fazem `JOIN conversations`, coberto pelo índice acima.
- `contacts` **não** ganha canal. Contato é identidade (princípio 1).
- **Ponto de extensão futuro:** quando chegar o primeiro canal sem telefone (Instagram, e-mail),
  entra `contact_identities (contact_id, channel_type, external_id)`. Está fora deste PRD, mas
  o modelo acima não cria nada que precise ser desfeito para acomodá-la.
- **`conversations.channel_id` é imutável após a criação.** Uma conversa não migra de canal.
  Garantido por trigger `BEFORE UPDATE` que rejeita a alteração — sem isso, a âncora da janela
  (§7.1) e o histórico de entrega passariam a descrever um canal que não é mais o da thread.

---

## 7.1 Garantias sobre a janela de 24h (SPEC 045)

> Esta seção existe porque a D-2 mexe na tabela que a SPEC 045 usa como relógio. **Nada aqui é
> opcional**: os itens marcados 🔴 quebram a SPEC 045 ou o canal QR se forem omitidos.

A SPEC 045 apoia-se em `conversations.last_customer_message_at` e em quatro consumidores.
Mapeamento completo do impacto:

| # | Consumidor                                                                 | O que acontece sem guarda                                                                                                  | Guarda |
| - | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 | 🔴 `checkWindowGuard()` — [engine.ts:746](../src/lib/automations/engine.ts#L746) | Roda antes de **todo** `send_message`/`send_buttons`/`send_list`. Em conversa QR a âncora é NULL → `isOpen=false` → default `'fail'` → **toda automação de envio no canal QR lança "24h session window closed"**. O canal fica inútil. | §7.1.1 |
| 2 | 🔴 Condição `session_window` — [engine.ts:961](../src/lib/automations/engine.ts#L961) | Responderia sempre "fechada" em QR → automações e flows com ramificação por janela tomam o **ramo errado, em silêncio**.        | §7.1.1 |
| 3 | 🔴 `scanForAutomation()` — [window-scan.ts:213](../src/lib/automations/window-scan.ts#L213) | Varre `conversations` só por `account_id`. Se uma conversa QR tiver âncora, entra na varredura e recebe reengajamento — normalmente um template, que não existe no QR. | §7.1.2 |
| 4 | 🔴 Faixa da janela no inbox — [message-thread.tsx:244](../src/components/inbox/message-thread.tsx#L244) | `computeSessionWindow(null)` devolve `isOpen:false`, e a thread QR exibiria **"janela fechada"** — um alarme falso sobre uma regra que não existe ali. | §7.1.1 |
| 5 | ✅ Âncora monotônica — [webhook/route.ts:810](../src/app/api/whatsapp/webhook/route.ts#L810) | O UPDATE condicional migra para `ingest.ts`; passa a rodar só onde a capacidade existe.                                      | §7.1.3 |
| 6 | ✅ `automation_window_claims`                                               | `UNIQUE(automation_id, conversation_id, window_anchor)`. Como a D-2 dá **um `conversation_id` por canal**, o lock continua correto **sem nenhuma mudança de schema**. | — |
| 7 | ✅ `reopened_at` — [webhook/route.ts:844](../src/app/api/whatsapp/webhook/route.ts#L844) | Só executa quando a âncora avança; em QR a âncora nunca avança, então a métrica nunca é poluída.                              | — |
| 8 | ✅ `idx_conversations_last_customer_msg` (052)                              | Índice parcial sobre `(account_id, last_customer_message_at) WHERE status='open'`. Inalterado pela 057.                        | §7.1.4 |

O item **6** merece destaque: ele é um **argumento técnico a favor da D-2**. Com thread única
intercalada (a alternativa rejeitada), o claim `(automação × conversa × âncora)` passaria a
representar duas janelas diferentes na mesma linha, e o lock que impede envio duplicado
deixaria de ser confiável. A separação por canal é o que mantém a SPEC 045 correta sem tocá-la.

### 7.1.1 Um relógio só, agora ciente de canal

A `session-window.ts` já declara no cabeçalho a razão de existir: ser *"o relógio da verdade
único"* em vez de cada consumidor recalcular do seu jeito. A correção estende esse mesmo
argumento — os quatro consumidores **não** ganham um `if` de canal cada um. Ganha-se **uma**
função em `src/lib/channels/session-window.ts`:

```ts
export interface ChannelSessionWindow extends SessionWindowState {
  /** false = o canal não tem regra de janela (a restrição é da Meta). */
  applicable: boolean;
}

export function resolveSessionWindow(
  channel: Pick<Channel, 'type'>,
  lastCustomerMessageAt: Date | null,
  now: Date = new Date()
): ChannelSessionWindow {
  if (!can(channel.type, 'sessionWindow24h')) {
    // Ausência de restrição ≠ restrição violada. Sem Meta, não há
    // rejeição possível — logo, sempre enviável.
    return {
      applicable: false,
      isOpen: true,
      minutesRemaining: Infinity,
      lastCustomerMessageAt: null,
    };
  }
  return { applicable: true, ...computeSessionWindow(lastCustomerMessageAt, now) };
}
```

**Sobre o "falha fechada" da casa.** O projeto trata "não sei" como fechado, e com razão. Aqui
o caso é diferente e a distinção importa: não é *desconhecimento* do estado da janela — é a
**ausência da regra**. A janela de 24h é uma restrição da Meta; num canal que não fala com a
Meta, "fechada" não é o padrão conservador, é uma afirmação falsa que bloqueia 100% dos envios
legítimos. Por isso o retorno carrega `applicable: false` explicitamente, em vez de fingir uma
janela aberta: cada consumidor decide o que fazer com a informação.

Uso nos quatro pontos:

| Consumidor              | Comportamento com `applicable: false`                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `checkWindowGuard`      | Retorna `{ kind: 'send' }` de imediato — sem guarda, sem fallback de template      |
| Condição `session_window` | `open` → `true`; `closed` → `false`; `closing_soon` → `false`                    |
| `message-thread.tsx`    | Não renderiza a faixa (nem aberta, nem fechada)                                    |
| `window-scan`           | A conversa nunca chega até aqui — ver §7.1.2                                       |

### 7.1.2 A varredura filtra por capacidade, não por acaso

Com a §7.1.3, conversas QR ficam com `last_customer_message_at` NULL para sempre, e um range
seek `> closesNow` **nunca casa NULL** — na prática a varredura já as ignora. Isso não basta:
depender de "a coluna estará NULL" é uma invariante frágil, que o próximo desenvolvedor quebra
sem perceber ao adicionar um backfill. A fase B ganha o filtro explícito:

```ts
// Fase A já devolveu as automações; resolve os canais COM janela dessas
// contas uma vez, fora do loop, e restringe a fase B a eles.
.in('channel_id', channelsWithSessionWindow)
```

Custo: uma query por tick, fora do laço. Benefício: a exclusão vira **intenção declarada e
testável**, não efeito colateral de um NULL.

### 7.1.3 A âncora só é escrita onde a janela existe

No `ingest.ts` (§6.4), o bloco da âncora passa a ser condicional:

```ts
if (adapter.capabilities.sessionWindow24h) {
  // UPDATE monotônico — preservado LITERALMENTE do webhook atual,
  // incluindo o filtro .or(is.null, lt) e o .select('id') que sinaliza
  // se a âncora avançou (é ele que decide o bloco de reopened_at).
}
```

Preservar **literalmente** é requisito, não estilo: o filtro monotônico existe porque a Meta
reentrega webhooks fora de ordem, e um UPDATE cego puxaria a âncora para trás, reabrindo
elegibilidade de uma janela já reengajada. O teste de paridade da F2 cobre exatamente isto.

### 7.1.4 Migração 057 com asserção

Seguindo o padrão de [041_assert_039_intact.sql](../supabase/migrations/041_assert_039_intact.sql)
e dos blocos `DO $$` da 052, a 057 termina verificando que não desfez a SPEC 045 — e **falha
alto** se desfez:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='conversations' AND column_name='last_customer_message_at')
  THEN RAISE EXCEPTION '057: coluna da SPEC 045 desapareceu.'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='conversations' AND indexname='idx_conversations_last_customer_msg')
  THEN RAISE EXCEPTION '057: idx_conversations_last_customer_msg da SPEC 045 nao sobreviveu.'; END IF;

  -- A 057 troca o índice da 036 por um mais amplo. Se o novo não existir,
  -- a conta ficou sem proteção contra conversas duplicadas.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='conversations' AND indexname='idx_conversations_account_contact_channel')
  THEN RAISE EXCEPTION '057: dedupe de conversas ficou sem indice.'; END IF;
END $$;
```

### 7.1.5 Aviso no editor de automações

Uma automação com gatilho `session_window_expiring` numa conta que só tem canal QR **nunca
dispara**. Isso é a armadilha "agendamento não dispara, sem erro" do `AGENTS.md` se repetindo.
O editor exibe, ao selecionar esse gatilho: *"Este gatilho depende da janela de 24h e só vale
para canais WhatsApp Oficial. Sua conta não tem nenhum canal compatível."*

### 7.1.6 Critério de aceite verificável

A F6 só fecha com estes cinco resultados demonstrados:

1. Automação com `send_message` dispara **normalmente** numa conversa QR sem âncora — sem
   erro de janela, sem fallback de template.
2. Automação com `send_message` numa conversa Cloud **fora** da janela continua respeitando
   `on_window_closed` (`fail` por padrão) — comportamento **idêntico ao de hoje**.
3. Condição `session_window: open` → verdadeira em QR; em Cloud, decidida pela âncora.
4. Reengajamento de janela (`session_window_expiring`) **nunca** seleciona conversa QR, mesmo
   com âncora forçada manualmente no banco.
5. Thread QR no inbox **não** exibe faixa de janela; thread Cloud exibe, exatamente como hoje.

---

## 8. Integração com a Evolution Go

### 8.1 Autenticação — o detalhe que muda o desenho

A Evolution Go **não identifica a instância por path**. Operações de instância e de mensagem
usam o header `apikey` carregando o **token daquela instância**:

| Operação                                       | `apikey`                |
| ---------------------------------------------- | ----------------------- |
| `POST /instance/create`, `GET /instance/all`, `DELETE /instance/delete/{id}` | chave **global** |
| `connect`, `qr`, `pair`, `status`, `disconnect`, `logout`, `/send/*`, `/message/*` | **token da instância**  |

Consequência prática: o token de cada instância é **credencial de acesso ao WhatsApp daquele
cliente**. Ele nunca chega ao browser, nunca sai da `evolution_instance_secrets`, e só é
decriptado dentro de `resolve.ts` no servidor.

### 8.2 Ciclo de vida

```
criar   POST /instance/create      { name, token?, proxy? }   [apikey global]
conectar POST /instance/connect    { immediate, phone?, subscribe[], webhookUrl }  [token]
QR      GET  /instance/qr          → { qrCode (base64), Code }                     [token]
pareio  POST /instance/pair        { phone, subscribe[] } → { pairingCode }        [token]
status  GET  /instance/status      → { Connected, LoggedIn, Name }                 [token]
pausar  POST /instance/disconnect                                                   [token]
sair    DELETE /instance/logout    (desvincula o aparelho)                          [token]
apagar  DELETE /instance/delete/{instanceId}                                       [apikey global]
```

O `webhookUrl` e os eventos são registrados **no `connect`**, não no `create` — a rotina de
criação do CRM sempre encadeia create → connect.

### 8.3 Nomeação de instâncias (multi-tenant)

A VPS é compartilhada entre todas as contas do deployment e `remote_instance_name` é global
nela. Nome escolhido pelo usuário **nunca** vai cru:

```
<EVOLUTION_INSTANCE_PREFIX>_<8 primeiros hex do account_id>_<slug do rótulo>_<4 hex aleatórios>
ex.: zapcrm_a3f91b2c_vendas_7d1e
```

Impede colisão entre contas e entre deployments que compartilhem a mesma VPS, e o prefixo
permite auditar na Evolution o que é nosso.

### 8.4 Webhook inbound

**Rota:** `POST /api/channels/evolution/webhook/[secret]`

Como a Evolution Go **não assina** as entregas, a autenticidade se apoia em três verificações
em cadeia — todas obrigatórias:

1. `secret` do path casa com `evolution_instance_secrets.webhook_secret` (32 bytes hex,
   comparação **timing-safe**);
2. `instanceId` do payload casa com `evolution_instances.remote_instance_id`;
3. `instanceToken` do payload casa com o token decriptado da instância.

Falhou qualquer uma → `401`, sem processar. Igual ao Cloud, responde `200` imediatamente e
processa em `after()` (a rota está em Vercel; promessa solta é congelada — ver o comentário
em [webhook/route.ts:231](../src/app/api/whatsapp/webhook/route.ts#L231)).

**Eventos assinados no MVP:** `MESSAGE`, `SEND_MESSAGE`, `READ_RECEIPT`, `CONNECTION`, `QRCODE`.
Assinar `ALL` traz `HISTORY_SYNC`, `PRESENCE` e `GROUP` em volume alto e sem uso — não fazer.

| Evento         | Tratamento                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `MESSAGE`      | Ingestão normal como `sender_type='customer'`                                                  |
| `SEND_MESSAGE` | Mensagem **enviada pelo celular do operador** → ingere como `sender_type='agent'`, `sender_id` nulo. **Suprime o eco** das mensagens que nós mesmos enviamos, casando pelo `messageId` devolvido no envio |
| `READ_RECEIPT` | Atualiza `messages.status` (`delivered` / `read`), respeitando a escada anti-regressão que já existe |
| `CONNECTION`   | Atualiza `channels.status` — é o que faz o card na aba mostrar "Conectado" sem polling          |
| `QRCODE`       | Atualiza `last_qr_at`; **o QR nunca é persistido**                                              |

O `SEND_MESSAGE` é um ganho real que o canal oficial não tem: o que o time responde pelo
celular aparece no CRM.

### 8.5 Envio

| Ação        | Endpoint         | Corpo (campos principais)                          |
| ----------- | ---------------- | -------------------------------------------------- |
| Texto       | `POST /send/text` | `number`, `text`, `delay?`, `quoted?`             |
| Mídia       | `POST /send/media` | `number`, `url`, `type`, `caption?`, `filename?` |
| Enquete     | `POST /send/poll` | `number`, `question`, `options[]`, `maxAnswer`    |
| Localização | `POST /send/location` | `number`, coordenadas                         |
| Reação      | `POST /message/react` | `number`, `id`, `reaction`                    |
| Lida        | `POST /message/markread` | `number`, `id[]`                           |
| Digitando   | `POST /message/presence` | `number`, `state`, `isAudio`               |

**Mídia:** o bucket `chat-media` é privado (SPEC 040). O envio assina uma URL temporária com
`resolveMediaUrlForServer()` — o mesmo caminho que o oficial já usa — e passa a URL assinada
em `url`. Nada de base64 no MVP.

**Formato de número:** DDI+DDD+número sem `+` (`5511999999999`), enquanto o Cloud usa E.164.
A normalização fica **dentro do adaptador**; o núcleo continua falando E.164.

### 8.6 Envelope de resposta e mapeamento de erro

Sucesso: `{ "message": "success", "data": { … } }` — **confirmado** na sondagem
(`GET /instance/all` → chaves de topo `data`, `message`).

🔴 **Erro: a referência está errada.** Ela documenta
`{success:false, error:{code,message}, meta:{…}}`, mas o servidor real devolve **string
plana** — e 404 nem é JSON:

```
401 → {"error":"not authorized"}          (observado em go.local.ia.br)
404 → 404 page not found                  (text/plain, ServeMux do Go)
```

O adaptador lê os dois formatos defensivamente. Mapeamento em
[SPEC 048 §6.1](./spec-048-canal-whatsapp-qrcode.md).

⚠️ A referência avisa que, em alguns endpoints, o nome da propriedade no **schema** diverge do
`example`, e manda confiar no `example`. Caso concreto já identificado: o QR volta como
`data.Qrcode` (com essa capitalização), não `qrCode`. O adaptador lê defensivamente
(`data.Qrcode ?? data.qrCode ?? data.qrcode`) e a F0 confirma qual é o real.

### 8.7 🔴 Transporte de mídia recebida — decisão de infraestrutura

Com `WEBHOOK_FILES=true` (**o padrão** da Evolution Go), a mídia recebida vem **em base64
dentro do payload do webhook**. Isso colide com um limite duro do nosso deploy:

> **A Vercel rejeita corpo de requisição acima de ~4,5 MB.** Base64 infla ~33%. Um vídeo de
> 4 MB chega como ~5,3 MB e **o webhook falha** — e, pela política de retentativa (§8.8), o
> evento é descartado depois de 5 tentativas. Perda silenciosa de mensagem, exatamente o que
> este PRD existe para evitar.

Três saídas, em ordem de recomendação:

| # | Estratégia                                                     | Custo                                | Veredito                    |
| - | -------------------------------------------------------------- | ------------------------------------ | --------------------------- |
| 1 | **MinIO/S3 na VPS** (`MINIO_ENABLED=true`) → webhook traz `mediaUrl` | Um container a mais no docker-compose | ✅ **Recomendado.** Payload fica pequeno; baixamos a mídia server-side e subimos ao bucket privado `chat-media`, igual ao Cloud (SPEC 040) |
| 2 | `WEBHOOK_FILES=true` com teto de tamanho                       | Zero infra                           | Aceitável só para contas de baixo volume de mídia; exige recusar mídia grande com aviso |
| 3 | `WEBHOOK_FILES=false` + `POST /message/downloadimage`          | Zero infra                           | ❌ A referência documenta **bug conhecido**: 500 com "download failed 429". Não depender disso |

**Decisão adotada:** opção 1, documentada como pré-requisito de VPS. A opção 2 fica como
fallback automático — se o payload trouxer `base64` em vez de `mediaUrl`, o adaptador aceita
e sobe ao bucket do mesmo jeito. O runbook da VPS ganha a configuração do MinIO.

### 8.8 🔴 Retentativa de webhook: 5 tentativas, depois descarte

| Item                 | Valor                             |
| -------------------- | --------------------------------- |
| Máximo de tentativas | **5**                             |
| Intervalo            | **30 s**                          |
| Resposta esperada    | HTTP `2xx` em até **30 s**        |
| Esgotou              | **Evento descartado** + log na VPS |

Duas consequências que viram requisito:

1. **Não existe dead-letter.** A janela total de tolerância é de ~2,5 minutos. Um deploy que
   derrube a rota por mais que isso **perde mensagens para sempre**. O runbook precisa dizer
   isso, e a rota de webhook não pode depender de nada que reinicie a frio.
2. **Reentrega é certa, não hipotética.** Um `2xx` que demore >30 s é tratado como falha e o
   evento volta — com a mensagem já gravada por nós. A idempotência da §6.4 deixa de ser
   defesa em profundidade e passa a ser caminho quente. O `after()` do Next resolve o lado do
   ack (respondemos em ms), mas a checagem por `(conversation_id, message_id)` é obrigatória.

⚠️ **`WEBHOOK_URL` global na VPS dispara EM PARALELO ao webhook por instância.** Se o operador
configurar as duas coisas, recebemos cada evento **duas vezes**. O runbook manda deixar
`WEBHOOK_URL` vazio; a idempotência cobre o caso de ele ignorar.

### 8.9 🔴 LID — o identificador que não é telefone

Os payloads trazem `Info.SenderAlt` com sufixo `@lid`, e `/user/check` devolve `LID` ao lado
de `JID`. O WhatsApp está migrando para **LID** (Linked ID) como identificador de usuário, em
vez do número de telefone.

Isso atinge o coração do nosso modelo: `contacts` é deduplicado por telefone
(migração 022), e `findExistingContact` casa por sufixo de 8 dígitos. Um remetente que
chegue **só** como LID não casa com contato nenhum e criaria um contato órfão a cada mensagem.

**Requisito para o adaptador (F4):** resolver sempre o telefone real antes de chamar
`ingestInboundMessage` — preferir `Info.Chat` / `Info.Sender` quando forem `@s.whatsapp.net`,
e cair em `/user/info` para traduzir um `@lid`. Se não der para resolver, **descartar com log
alto** em vez de criar contato com identificador sintético — um contato que não dá para
responder é pior que mensagem nenhuma. A F0 precisa registrar em que casos o `@lid` aparece
sozinho.

### 8.10 Configuração exigida na VPS

Pré-requisitos que não são código nosso, e sem os quais o canal funciona pela metade:

| Variável na VPS           | Valor              | Por quê                                                    |
| ------------------------- | ------------------ | ---------------------------------------------------------- |
| `MINIO_ENABLED`           | `true`             | §8.7 — evita estourar o limite de corpo da Vercel           |
| `WEBHOOK_URL`             | **vazio**          | §8.8 — senão todo evento chega duplicado                    |
| `DATABASE_SAVE_MESSAGES`  | `true`             | Sem isso, `/message/status` responde vazio                  |
| `CONNECT_ON_STARTUP`      | `true`             | Instâncias voltam sozinhas após restart do serviço          |
| `EVENT_IGNORE_GROUP`      | `true`             | Não suportamos grupos; filtrar na origem é mais barato      |
| `EVENT_IGNORE_STATUS`     | `true`             | Stories não interessam ao CRM                               |
| `GLOBAL_API_KEY`          | segredo forte      | Nunca o valor padrão                                        |

### 8.11 O que "editar instância" realmente permite

🔴 **Correção (12/08).** A referência afirma não haver endpoint para alterar as flags da
instância. O Swagger do servidor real desmente: **`GET` e `PUT /instance/{id}/advanced-settings`
existem**, e há mais controle do que o documentado. "Editar instância" é viável de verdade:

| Ação                     | Como                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| Renomear (rótulo no CRM) | Local — `channels.name`, não toca a VPS                          |
| Trocar webhook / eventos | Re-executar `POST /instance/connect`                             |
| **Flags de comportamento** | ✅ `PUT /instance/{id}/advanced-settings` — `alwaysOnline`, `rejectCall`, `msgRejectCall`, `readMessages`, `ignoreGroups`, `ignoreStatus` |
| **Definir proxy**        | ✅ `POST /instance/proxy/{instanceId}` — não exige recriar        |
| Remover proxy            | `DELETE /instance/proxy/{instanceId}`                            |
| **Reconectar**           | ✅ `POST /instance/reconnect` · `POST /instance/forcereconnect/{id}` |
| **Diagnóstico**          | ✅ `GET /instance/logs/{instanceId}` — logs por instância na UI    |

Falta confirmar (F0 `--lifecycle`) se `advanced-settings` aceita o token da instância ou exige
a chave global.

---

## 9. Experiência do usuário

### 9.1 Nova aba: "WhatsApp QRCode" (`/settings?tab=whatsapp-qrcode`)

Entra em `SETTINGS_SECTIONS` e `SECTION_META` ([settings-sections.ts](../src/components/settings/settings-sections.ts)),
grupo `workspace`, logo abaixo de "WhatsApp", ícone `QrCode`. Componente:
`src/components/settings/whatsapp-qrcode-config.tsx`.

**Topo — aviso permanente, não dispensável.** Cartão âmbar explicando, sem rodeios:

> Conexão não oficial. Este canal usa a mesma tecnologia do WhatsApp Web e **não é
> homologado pela Meta**. Riscos: o número pode ser **bloqueado ou banido** a qualquer momento,
> sem aviso e sem recurso; não há SLA nem suporte da Meta; atualizações do WhatsApp podem
> derrubar a conexão. **Não use em número principal da empresa.** Neste canal não existem
> templates, botões, listas nem disparo em massa. O celular pareado precisa ter bateria e
> internet — se ele cair, o canal cai.

**Contador de uso:** `2 de 3 instâncias usadas` (barra), com a origem do limite explícita
quando é override da conta.

**Lista de instâncias** (cards): rótulo, número conectado, badge de status
(🟢 Conectado / 🟡 Conectando / 🔴 Desconectado / ⚫ Erro), última atividade e ações
`Conectar` · `Ver QR` · `Desconectar` · `Deslogar` · `Editar` · `Excluir`.

**Fluxo de conexão** (dialog):
1. QR renderizado do base64, com **contagem regressiva de ~60s** e botão "Gerar novo QR";
2. polling de `GET /instance/status` a cada 3s **enquanto o dialog está aberto** (o evento
   `CONNECTION` fecha antes, quando chega);
3. aba alternativa **"Conectar por código"**: informa o telefone, recebe código de 8 dígitos
   para digitar no aparelho — resolve o caso de quem não consegue escanear;
4. sucesso → mostra o número/JID vinculado e fecha.

**Exclusão** exige digitar o rótulo da instância (padrão do projeto para ação destrutiva) e
avisa explicitamente: **as conversas do canal são preservadas**, ficam somente-leitura e
recebem o badge "canal removido". Nunca apagar histórico junto com a instância.

**Permissão:** tudo gated em `canEditSettings` (admin+). Agente e viewer veem status,
não mexem.

**Sem `EVOLUTION_API_URL` configurada:** a aba aparece, **desabilitada**, com a instrução de
quais variáveis definir. Não some da navegação e não devolve 503 silencioso — a armadilha
"agendamento não dispara, sem erro" do AGENTS.md é exatamente o que se está evitando aqui.

### 9.2 Inbox

- **Seletor de canal** ao lado dos filtros existentes: `Todos os canais` · `WhatsApp Oficial` ·
  `[cada instância pelo rótulo]`. Persistido na URL, como as abas já fazem.
- **Badge de canal** em cada linha da lista e no cabeçalho da thread. Cor e ícone vêm de
  `channels`, não hard-coded.
- **Composer sensível a capacidade**: botão de template e de interativo desaparecem em canal QR;
  botão de enquete aparece. Nada de botão que erra ao clicar.
- **Sem faixa de janela de 24h** em canal QR — não existe janela ali. Mostrar apagado
  confundiria mais do que ajuda.
- Contato com thread nos dois canais: a ficha lateral lista **"Também neste contato: WhatsApp
  Oficial (3 mensagens)"** com link para a outra thread. É todo o "compartilhamento entre
  canais" que o modelo precisa (princípio 4).

### 9.3 Contatos

- Filtro **"Canal"**: mostra contatos com conversa no canal escolhido.
- Coluna/chip de canais do contato na listagem.
- Importação CSV e criação manual **não** escolhem canal — só a primeira mensagem define rota.
- Ao iniciar conversa com um contato sem thread e havendo mais de um canal ativo, um seletor
  pergunta por qual canal falar. Com um canal só, vai direto.

---

## 10. Impacto por módulo

| Módulo             | Impacto                                                                                                                                                | Esforço |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Inbox**          | Filtro + badge + composer por capacidade. Consulta ganha `channel_id`.                                                                                   | Médio   |
| **Contatos**       | Filtro por canal, chips na ficha. Dedupe inalterado.                                                                                                     | Baixo   |
| **Funis**          | Nenhum — `deals` aponta para conversa, que já carrega o canal.                                                                                           | Nenhum  |
| **Notificações**   | Nenhum — são por conversa. Título ganha o rótulo do canal.                                                                                               | Baixo   |
| **Automações**     | `send_message` roteia pelo canal do gatilho. `send_template`/`send_buttons`/`send_list` **inválidos** em QR → aviso no editor + `automation_logs` com motivo no runtime. Gatilho de reengajamento de janela (SPEC 045) e "baseado em horário" com envio de template: só oficial. | **Alto** |
| **Flows**          | `send_message`, `send_media`, `collect_input`, `condition` funcionam. `send_buttons`/`send_list` em QR **degradam para texto numerado** + `collect_input` casando número ou rótulo (ver §10.1). | **Alto** |
| **Agentes de IA**  | Rascunho e auto-resposta funcionam (texto puro). Só troca o caminho de envio.                                                                             | Baixo   |
| **Disparos**       | **Bloqueado em QR**: seletor de canal do disparo lista apenas canais com `capabilities.broadcast`; runtime recusa com erro explícito.                     | Médio   |
| **API pública v1** | `POST /api/v1/messages` aceita `channel_id` opcional (default = canal padrão). `resolveConversationByPhone` recebe `channelId`. Aditivo, sem quebra.      | Médio   |
| **Webhooks saída** | Todo payload ganha `channel_id` e `channel_type`. Aditivo.                                                                                               | Baixo   |
| **Dashboard**      | Filtro por canal nas métricas. Métricas de janela/template continuam exclusivas do oficial, rotuladas como tal.                                           | Médio   |

### 10.1 Menus de flow em canal QR

O canal QR não tem botões. O nó `send_buttons` degrada, no adaptador, para:

```
Como posso ajudar?

1️⃣ Falar com vendas
2️⃣ Segunda via de boleto
3️⃣ Outro assunto
```

e o `collect_input` seguinte casa **o número, o emoji ou o texto do rótulo**. Determinístico,
zero dependência de enquete, funciona no primeiro dia.

**Por que não enquete no MVP:** o voto chega como `pollUpdateMessage` referenciando a chave da
mensagem original — casar isso com a execução do flow exige persistir a chave da enquete e um
caminho de resolução novo. É a evolução natural (v2), não o ponto de partida.

> ✅ **Confirmado em teste real (12/08):** `/send/poll` entrega normalmente no canal QR,
> enquanto `/send/button` e `/send/list` são recusados pelo WhatsApp com 405. A enquete é,
> de fato, o único caminho interativo nativo — e o servidor ainda expõe
> `GET /polls/{id}/results`, que resolve a leitura dos votos sem depender de decifrar
> `pollUpdateMessage`. Isso torna a v2 bem mais barata do que este PRD supunha.

### 10.2 Desvio de canal quando a janela de 24h fecha — `fallback_channel`

> **Status: lógica de decisão, tipos, validação e UI implementados** (commit desta entrega).
> O envio propriamente dito depende do adaptador da Evolution — **F4**.

O caso de uso que mais justifica o canal QR: o contato começou a conversa **no número
oficial**, ficou 24h em silêncio, e reengajá-lo pela Cloud API custa um **template pago**.
Pelo canal QR, o mesmo texto sai livre.

O `on_window_closed` dos steps `send_message` ganha uma quarta opção, ao lado de
`skip` / `fail` / `fallback_template`:

```jsonc
{
  "text": "Oi {{contact.name}}, conseguiu ver o orçamento?",
  "on_window_closed": "fallback_channel",
  "fallback_channel_id": "<channels.id de uma instância QRCode conectada>"
}
```

**Onde a decisão vive.** Em [`window-fallback.ts`](../src/lib/automations/window-fallback.ts) —
módulo puro, sem banco, com as doze rotas cobertas por teste. O motor só reúne os fatos e
executa o veredito. Regras, em ordem:

| Ordem | Condição                                             | Rota                                        |
| ----- | ---------------------------------------------------- | ------------------------------------------- |
| 1     | Canal da conversa não tem janela (§7.1.1)            | `send` — não há restrição a contornar       |
| 2     | Janela aberta                                        | `send`                                      |
| 3     | Sem `fallback_channel_id`                            | `fail` — erro de configuração               |
| 4     | **Contato `opted_out`**                              | `skip` — suprime                            |
| 5     | Canal não encontrado / de outra conta                | `fail`                                      |
| 6     | **Canal escolhido também tem janela de 24h**         | `fail`                                      |
| 7     | Canal não está `connected`                           | `fail` (com o status no motivo)             |
| 8     | —                                                    | `fallback_channel`                          |

**Os dois guardrails que o `fallback_template` não tem, e por quê:**

- **Regra 4 (opt-out bloqueia).** Um template de utilidade tem categoria aprovada pela Meta e
  alcança um opted-out por regra conhecida — é o que `fallbackTemplateAllowed` já faz. Uma
  mensagem livre saindo de um número não-oficial **não tem categoria nenhuma**: ela é, por
  definição, contato automatizado não solicitado, de um remetente que a pessoa não reconhece.
  Suprimir é o único resultado defensável.
- **Regra 6 (canal com janela é recusado).** Escolher um segundo número Cloud API como desvio
  **não escapa da janela** — ele carrega a mesma restrição da Meta. Sem esta checagem o
  operador configuraria o desvio, veria a automação "funcionar" e colheria rejeição no envio.

**Restrição de tipo de step.** `fallback_channel` vale só para `send_message`. Uma instância
QR não renderiza botões nem listas (§6.2), então `send_buttons` / `send_list` rejeitam a opção
**na ativação** (`validate.ts`), com backstop no runtime para um `step_config` escrito à mão
direto no banco.

**A opção só aparece quando existe instância conectada.** O `<select>` do construtor lê
[`useFallbackChannels()`](../src/hooks/use-fallback-channels.ts), que filtra por
`eligibleFallbackChannels` (conectado **e** sem janela). Hoje a lista é vazia — a tabela
`channels` só nasce na 055 — então **a interface atual não muda em nada**. Quando a migração
rodar e uma instância for pareada, a opção acende sozinha, sem alteração de código.

**Aviso obrigatório na UI**, ao lado do seletor:

> O contato vai receber de um número diferente daquele para o qual escreveu. Instâncias não
> oficiais têm risco real de banimento — use para retomada legítima, nunca para abordagem fria.

**O que falta para funcionar ponta a ponta (F4):** `sendViaFallbackChannel()` no motor hoje
**lança** com motivo explícito em vez de devolver sucesso — um "enviado" que não entregou é a
pior falha possível num CRM de atendimento. Na F4 o corpo vira uma chamada a
`sendViaChannel({ channelId, … })` (§6.5).

### 10.3 Teto de envio frio — o antispam da instância não-oficial

> **Status: política, parsing, cálculo, rota e exibição implementados.** Falta a contagem
> (tabela + wiring), que depende do caminho de envio — **F4**.

Abrir o desvio da §10.2 sem teto seria entregar uma metralhadora. Este é o freio.

**Só envio frio conta.** Responder alguém dentro de uma conversa viva tem risco zero — a
pessoa iniciou e espera resposta. O que derruba número é o oposto: mensagem automatizada para
quem **não** está falando com você. Um envio é **frio** quando a última mensagem do contato é
mais antiga que `silenceHours` (padrão 24 h) ou quando ele nunca escreveu. Atendimento normal
não consome cota nenhuma.

**Três tetos, porque um só não descreve comportamento humano:**

| Variável (`.env`)                            | Padrão | O que trava                                                    |
| -------------------------------------------- | ------ | -------------------------------------------------------------- |
| `EVOLUTION_COLD_SEND_PER_DAY`                | `60`   | Volume — últimas **24 h corridas**, por instância               |
| `EVOLUTION_COLD_SEND_PER_HOUR`               | `12`   | **A rajada** — o eixo que realmente evita banimento             |
| `EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS`   | `45`   | Metralhadora dentro da hora                                     |
| `EVOLUTION_COLD_SEND_SILENCE_HOURS`          | `24`   | O que conta como "frio"                                         |
| `EVOLUTION_COLD_SEND_WARMUP_DAYS`            | `14`   | Rampa da cota diária para instância nova                        |

**Por que não bastava "por dia".** Um teto diário sozinho permite mandar as 60 mensagens em
cinco minutos — que é exatamente a rajada que o antispam do WhatsApp detecta. O diário limita
volume; o horário limita ritmo; o intervalo limita cadência. Os três juntos parecem uma
pessoa; qualquer um sozinho, não.

**Por que 24 h corridas e não o dia do calendário.** Contagem que zera à meia-noite deixa
mandar 2× o limite na virada — 60 às 23h50 e 60 às 00h10, o pior padrão possível.

**Aquecimento.** Instância nova mandando volume máximo no dia 1 é o retrato do número
descartável. A cota diária cresce linearmente até `warmupDays`; o operador não faz nada, e o
teto que ele configurou continua sendo o teto. A interface mostra a **cota efetiva de hoje**,
não o `perDay` cru, com o rótulo de "aquecendo".

**Falha fechada.** Valor ausente, não-inteiro ou negativo cai no padrão — um `.env` com erro
de digitação nunca vira "sem limite". `0` em `perDay` ou `perHour` é aceito e **desliga** o
envio frio, que é como o dono do sistema encerra o recurso sem mexer em código.

**Quem configura vs. quem vê.** Os valores vivem no `.env` do deployment (dono do sistema). O
cliente **consulta** via `GET /api/channels/cold-send-limits` — cinco números, sem segredo,
piso `viewer`. Uma rota, e não `NEXT_PUBLIC_`, porque variável pública congela no build:
trocar um teto exigiria rebuild. A interface mostra:

- no construtor de automações, sob o seletor de canal de desvio: *"Limite de segurança
  definido pelo administrador do sistema: até 60 mensagens por dia e 12 por hora em cada
  instância, com pelo menos 45s entre elas. Só contam mensagens para contatos em silêncio há
  mais de 24h."*
- na aba **WhatsApp QRCode** (F3): consumo × cota por instância, com barra e selo de
  aquecimento.

**Ao bater o teto, `skip` — nunca `fail`.** Cota estourada é adiamento, não defeito: falhar
marcaria automações inteiras como quebradas em cascata. O motivo vai literal para
`automation_logs` (`describeDenial()`), então o operador vê *"cold-send daily limit reached
(60/24h)"* — a armadilha "não dispara, sem erro" continua fechada.

**O que falta (F4): a contagem.** É preciso saber quantos envios frios saíram. Tabela
append-only, barata, na migração que acompanhar a F4:

```sql
CREATE TABLE channel_cold_sends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cold_sends_channel_time ON channel_cold_sends (channel_id, sent_at DESC);
```

Linha gravada **depois** da entrega confirmada; expurgo em 30 dias, como
`automation_window_claims`. Contar direto em `messages` não serve: "era frio no momento do
envio" não é reconstituível depois que o contato responde.

---

## 11. Segurança e multi-tenancy

| Risco                                        | Mitigação                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Chave global da Evolution vazar para o browser | Sem `NEXT_PUBLIC_`. Toda operação passa por rota server-side com sessão validada. Nenhum componente cliente fala com a VPS. |
| Token de instância vazar por `SELECT *`       | Vive em `evolution_instance_secrets`, com RLS ligada e **nenhuma policy** — só `service_role` lê.               |
| Webhook forjado (não há assinatura)           | Secret de 32 bytes no path + `instanceId` + `instanceToken` conferidos, comparação timing-safe. §8.4.           |
| Conta A gerenciar instância da conta B        | Toda rota resolve `account_id` da sessão e filtra por ele; RLS reforça. Nome namespaced impede colisão na VPS.   |
| Mensagem duplicada por reentrega              | Idempotência por `(conversation_id, message_id)` antes do INSERT — §6.4.                                        |
| SSRF por URL de mídia recebida                | Reutiliza a guarda que já existe em [lib/webhooks](../src/lib/webhooks/); mídia baixada via proxy autorizado.    |
| Abuso do painel derrubando a VPS              | Rate limit em criar instância e gerar QR, com [lib/rate-limit.ts](../src/lib/rate-limit.ts).                     |
| QR interceptado = sequestro da sessão WhatsApp | QR nunca persistido, nunca logado, nunca cacheado; TTL curto; só admin+ visualiza.                              |

---

## 12. Variáveis de ambiente

Adicionar em `.env.local.example`, seção **OPCIONAIS**:

```bash
# ------------------------------------------------------------------
# WhatsApp via QRCode — Evolution Go (opcional)
# ------------------------------------------------------------------
# URL base da Evolution Go rodando na sua VPS (sem barra no final).
# Sem esta variável, a aba "WhatsApp QRCode" aparece desabilitada com
# instruções — o restante do CRM não é afetado.
# EVOLUTION_API_URL=https://evo.seudominio.com.br

# Chave global da Evolution (GLOBAL_API_KEY do .env da VPS). Usada só
# para criar, listar e excluir instâncias. NUNCA prefixar com
# NEXT_PUBLIC_ — ela dá controle total sobre todas as instâncias.
# EVOLUTION_GLOBAL_API_KEY=

# Teto padrão de instâncias por conta. Pode ser sobrescrito por conta
# em accounts.evolution_instance_limit (NULL = usa este valor).
# EVOLUTION_MAX_INSTANCES_PER_ACCOUNT=3

# Teto global do deployment inteiro — protege a VPS. É este, e não o
# limite por conta, que impede 10 contas × 3 instâncias derrubarem o
# servidor. Padrão 20.
# EVOLUTION_MAX_INSTANCES_TOTAL=20

# Prefixo dos nomes de instância criados na VPS (auditoria e para
# evitar colisão entre deployments que compartilhem a mesma Evolution).
# EVOLUTION_INSTANCE_PREFIX=zapcrm

# Origem pública para montar a URL de webhook registrada na Evolution.
# Só necessária se diferir de NEXT_PUBLIC_SITE_URL (ex.: túnel em dev).
# EVOLUTION_WEBHOOK_PUBLIC_URL=

# Timeout por chamada à Evolution, em ms. Padrão 15000.
# EVOLUTION_REQUEST_TIMEOUT_MS=15000

# ---- Teto de ENVIO FRIO (antispam) — §10.3 -----------------------
# Só contam mensagens para quem NÃO está conversando com você. Valor
# inválido cai no padrão, nunca em "sem limite"; zerar perDay ou
# perHour DESLIGA o envio frio. Mostrados ao cliente na interface.
# EVOLUTION_COLD_SEND_SILENCE_HOURS=24
# EVOLUTION_COLD_SEND_PER_DAY=60
# EVOLUTION_COLD_SEND_PER_HOUR=12
# EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS=45
# EVOLUTION_COLD_SEND_WARMUP_DAYS=14
```

Nenhuma variável nova é obrigatória: sem `EVOLUTION_API_URL`, o comportamento atual do sistema
permanece **byte a byte** o mesmo.

---

## 13. Plano de entrega

Cada fase é entregável e validável sozinha. **F1 e F2 não mudam nada visível** — são a
fundação, e é aí que está o valor de longo prazo.

| Fase   | Entrega                                                                                                   | Critério de aceite                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **F0** | **Spike de validação** — `scripts/evolution-probe.mjs` exercitando create → connect → qr → status → send → webhook → delete contra a VPS real | Ver a lista fechada de perguntas abaixo, todas respondidas com evidência |
| **F1** | Migração 055; `src/lib/channels/` (types, capabilities, registry, resolve, **session-window** §7.1.1); adaptador `whatsapp-cloud` embrulhando `meta-api`; backfill do canal Cloud | Suite verde; nenhuma mudança de comportamento observável; canal Cloud existe em `channels` para toda conta; **os 4 consumidores da janela migrados para `resolveSessionWindow`, com resultado idêntico ao atual** |
| **F2** | `ingest.ts` + `send.ts`; webhook da Meta reescrito como tradutor fino; os 5 caminhos de saída migrados      | **Testes de regressão do oficial idênticos**; `automations/meta-send.ts` e `flows/meta-send.ts` reduzidos a invólucros              |
| **F3** | Migração 056; rotas `/api/channels/evolution/*`; aba "WhatsApp QRCode" completa                             | Criar, conectar por QR **e** por código, ver status, desconectar, deslogar, excluir. Limite respeitado nas três camadas (D-1)        |
| **F4** | Adaptador `evolution.ts`; webhook inbound; envio de texto/mídia/localização/enquete/reação; status         | Mensagem enviada do celular chega no inbox; resposta pelo inbox chega no celular; recibo de leitura reflete; reentrega não duplica     |
| **F5** | Migração 057; filtro e badge de canal no inbox; composer por capacidade; ficha de contato multicanal        | Contato que fala nos dois canais tem 2 threads e 1 ficha; filtro funciona; composer não oferece o que o canal não faz                  |
| **F6** | Automações, flows (com degradação §10.1), IA, guardas de disparo, API v1, webhooks de saída, dashboard      | Automação e flow completos rodando ponta a ponta em canal QR; disparo em massa **recusado com mensagem clara**; **os 5 critérios da §7.1.6 demonstrados** |
| **F7** | i18n (`en` + `pt-BR`), documentação, observabilidade, `README`                                              | `npm run i18n:check` verde; `docs/` e `AGENTS.md` atualizados                                                                        |

**Ordem inegociável:** F0 antes de F4, F2 antes de F4 (senão nasce o sexto caminho de envio),
F1 antes de F3.

### O que a F0 tem de responder

Com a referência nova (§1), a F0 deixou de ser "descobrir a API" e virou uma lista fechada de
incertezas — todas de coisas que documentação nenhuma resolve:

1. O QR volta em `data.Qrcode`, `qrCode` ou outro nome? (§8.6)
2. `/send/media` com `type: audio` sai como **PTT** ou como arquivo anexado? (§6.2)
3. Em que situações `Info.Sender` chega **só** como `@lid`, e `/user/info` resolve o telefone? (§8.9)
4. Com `MINIO_ENABLED=true`, o webhook traz `mediaUrl` em vez de `base64` — e a URL é
   acessível a partir do nosso servidor? (§8.7)
5. Qual o **tamanho máximo real** de payload observado com `WEBHOOK_FILES=true`? (§8.7)
6. `/instance/connect` reexecutado em instância já conectada troca o webhook **sem derrubar a
   sessão**? (§8.11 — é disso que depende "editar instância")
7. O Swagger da sua versão (`{baseUrl}/swagger/index.html`) expõe algo além dos 59
   documentados — em especial, alteração das flags da instância? (§8.11)
8. `/instance/status` distingue `Connected` de `LoggedIn` como esperado quando o celular
   perde internet?

### Modelo recomendado por fase

Conforme sua preferência de sempre avaliar o LLM por tarefa:

| Fase                      | Recomendação   | Motivo                                                                          |
| ------------------------- | -------------- | ------------------------------------------------------------------------------- |
| F0 (spike)                | **Sonnet 5**   | Script HTTP direto, muita iteração, baixo custo                                  |
| **F2 (refactor ingest)**  | **Opus 5**     | Mexe no caminho crítico de receita; um erro aqui perde mensagem em silêncio      |
| F1, F3, F4, F5            | **Sonnet 5**   | Padrões já definidos por este PRD; execução mecânica                             |
| F6 (motores)              | **Opus 5**     | Interações sutis entre capacidades, degradação e supressão de gatilhos           |
| F7 (i18n, docs)           | **Sonnet 4.6** | Volume, baixa complexidade                                                       |

---

## 14. Testes

Co-locados, seguindo a convenção do projeto:

| Arquivo                                              | Cobre                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `src/lib/channels/capabilities.test.ts`              | Matriz completa; nenhum tipo com capacidade indefinida             |
| `src/lib/channels/registry.test.ts`                  | Todo `ChannelType` resolve um adaptador                            |
| `src/lib/channels/resolve.test.ts`                   | Precedência explícito > conversa > padrão; tenancy cruzada negada  |
| `src/lib/channels/ingest.test.ts`                    | **Paridade com o comportamento pré-refactor** + idempotência       |
| `src/lib/channels/send.test.ts`                      | Capacidade ausente → `unsupported_by_channel`; persistência única  |
| `src/lib/channels/adapters/evolution.test.ts`        | Normalização de número, tradução de payload, mapeamento de erro    |
| `src/lib/channels/adapters/evolution-inbound.test.ts` | `MESSAGE`, `SEND_MESSAGE` (incl. supressão de eco), `READ_RECEIPT`, `CONNECTION` |
| `src/lib/channels/limits.test.ts`                    | D-1 nas três camadas, incluindo `COALESCE` do override             |
| `src/app/api/channels/evolution/webhook/route.test.ts` | 401 em secret/instanceId/token inválidos; timing-safe             |
| **`src/lib/channels/session-window.test.ts`**         | **§7.1** — `applicable:false` em QR; paridade exata com `computeSessionWindow` em Cloud |

**Testes de não-regressão da SPEC 045** (§7.1.6), obrigatórios na F6:

| Arquivo                                         | Verifica                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/automations/engine.window.test.ts`     | `checkWindowGuard` libera em QR; em Cloud fora da janela mantém `fail`/`skip`/`fallback_template` **byte a byte** |
| `src/lib/automations/engine.condition.test.ts`  | Condição `session_window` em QR: `open`→true, `closed`→false, `closing_soon`→false |
| `src/lib/automations/window-scan.test.ts`       | Conversa QR **com âncora forçada** não é selecionada pela fase B                |
| `src/lib/channels/ingest.session-window.test.ts` | Âncora escrita só onde há capacidade; monotonicidade e `reopened_at` preservados |

**Manual, obrigatório antes do merge de F4:** parear um número real, trocar mensagens nos dois
sentidos, responder pelo celular e ver aparecer no CRM, derrubar a internet do aparelho e
confirmar que o status vira "Desconectado" na aba.

---

## 15. Riscos

| Risco                                                             | Prob. | Impacto | Mitigação                                                                                  |
| ----------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------ |
| Número banido pela Meta                                           | Alta  | Alto    | Aviso não-dispensável na UI; sem disparo em massa; `delay` nos envios; nunca número principal |
| Atualização do WhatsApp quebra o whatsmeow                        | Média | Alto    | Status visível na aba; canal degrada isolado, o oficial continua; plano de atualização da VPS |
| VPS cai → canal inteiro fora                                      | Média | Alto    | Health check + badge de erro; envio falha com mensagem clara, não em silêncio                |
| **Guia local desatualizado gerar adaptador errado**               | Média (mitigado) | Médio | Resolvido pela referência nova (§1); **F0 continua bloqueante** para validar contra a VPS   |
| **Mídia em base64 estourar o limite de corpo da Vercel (~4,5 MB)** | **Alta sem MinIO** | **Alto** | §8.7 — MinIO na VPS como pré-requisito; fallback com teto de tamanho e recusa explícita |
| **Evento descartado após 5 tentativas (sem dead-letter)**         | Média | **Alto** | §8.8 — janela de ~2,5 min; runbook de deploy e ack imediato via `after()`                  |
| **Remetente identificado só por LID, sem telefone**               | Média | **Alto** | §8.9 — resolver via `/user/info`; descartar com log alto em vez de criar contato órfão      |
| **`WEBHOOK_URL` global duplicar todo evento**                     | Média | Médio | §8.8/§8.10 — runbook manda deixar vazio; idempotência cobre o descuido                      |
| Refactor da F2 introduzir perda silenciosa de mensagem            | Média | **Crítico** | Testes de paridade; F2 sozinha em PR; Opus 5; canário em produção antes da F4           |
| **D-2 quebrar a janela de 24h da SPEC 045**                       | **Alta se ignorado** | **Crítico** | **§7.1 inteira**: um `resolveSessionWindow` ciente de canal, filtro de capacidade na varredura, âncora condicional, asserção na 057 e 5 critérios de aceite. Sem isso, ou o canal QR não envia nada, ou o Cloud reengaja errado |
| Mensagem duplicada por reentrega sem assinatura                   | Média | Médio   | Idempotência por `(conversation_id, message_id)` — §6.4                                     |
| Licença da Evolution Go vinculada a e-mail dificultar migração    | Baixa | Médio   | Documentar o e-mail de ativação junto do runbook da VPS                                     |
| Custo de manter dois caminhos de mensageria                       | Alta  | Médio   | É exatamente o que a camada de canais amortiza: um caminho, dois adaptadores                |

---

## 16. Anexo — superfície da API

Os **59 endpoints** com schema de request/response, os payloads reais de webhook por evento,
as variáveis de ambiente da VPS e os bugs conhecidos estão em
[`docs/references/EVOLUTION_GO_REFERENCE.md`](./references/EVOLUTION_GO_REFERENCE.md). Este
PRD não os duplica de propósito — duas listas de endpoints divergem na primeira correção.

O que este documento decide sobre aquela superfície:

| Área                          | Decisão                                                      | Seção  |
| ----------------------------- | ------------------------------------------------------------ | ------ |
| Instância                     | `create` · `connect` · `qr` · `pair` · `status` · `disconnect` · `logout` · `delete` · `proxy` | §8.2, §8.11 |
| Envio                         | `text` · `media` · `location` · `poll` · `link` · `contact` · `sticker` | §6.2, §8.5 |
| Mensagem                      | `react` · `markread` · `presence` · `edit` · `delete`         | §6.2   |
| Eventos assinados             | `MESSAGE` · `SEND_MESSAGE` · `READ_RECEIPT` · `CONNECTION` · `QRCODE` — **nunca `ALL`** | §8.4 |
| Grupos, comunidades, canais, etiquetas do WhatsApp | **Fora de escopo** — a Evolution Go oferece, o CRM não usa | §5.2 |
| `downloadimage`               | **Não usar** — bug conhecido (429). Ver estratégia de mídia   | §8.7   |

**Envelope de webhook:** `{ event, data, instanceId, instanceToken }` — **sem assinatura
HMAC**, daí o desenho de autenticação da §8.4.


## 17. Métricas de sucesso

| Métrica                                                        | Alvo                            |
| -------------------------------------------------------------- | ------------------------------- |
| Tempo do "conectar" até a primeira mensagem no inbox           | < 3 minutos                     |
| Mensagens perdidas no canal oficial durante a F2               | **0**                           |
| Regressões na SPEC 045 após a F6 (§7.1.6)                      | **0**                           |
| Mensagens duplicadas no canal QR (7 dias)                      | 0                               |
| Esforço estimado do **próximo** canal, medido em arquivos novos | ≤ 1 adaptador + 1 rota de webhook |
| Automações e flows funcionando em canal QR sem alteração de autoria | 100% dos passos suportados |

---

## 18. Fontes

- [Evolution Go — documentação oficial](https://docs.evolutionfoundation.com.br/evolution-go)
- [OpenAPI — instâncias](https://docs.evolutionfoundation.com.br/api-reference/openapi/Evolution-Go/evo-go-instance.yaml)
- [OpenAPI — mensagens](https://docs.evolutionfoundation.com.br/api-reference/openapi/Evolution-Go/evo-go-message.yaml)
- [Webhooks](https://docs.evolutionfoundation.com.br/evolution-go/webhooks.md)
- [evolution-foundation/evolution-go](https://github.com/evolution-foundation/evolution-go)
