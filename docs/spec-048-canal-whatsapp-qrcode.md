# SPEC 048 — Canal WhatsApp QRCode (Evolution Go): fundação, adaptador e mensageria

| Campo         | Valor                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status        | **F0 a F4 CONCLUÍDAS** — adaptador, webhook e mensageria testados contra número real (§6.6, §6.7). Código ainda não commitado quando este trecho foi escrito. |
| PRD           | [PRD 047](./prd-047-canais-e-whatsapp-qrcode.md) — esta SPEC cobre as fases **F0 a F4**                                              |
| Escopo fora   | Inbox multicanal (F5) e motores (F6) → SPEC 049. **Duas peças do PRD §10.2/§10.3, marcadas ali como "falta F4", na prática são de motor e migraram para a 049**: `sendViaFallbackChannel` ([engine.ts:975](../src/lib/automations/engine.ts#L975)) ainda lança erro em vez de enviar; `channel_cold_sends` (tabela de contagem do teto de envio frio) não existe. |
| Migrações     | **055** (canais) · **056** (instâncias) · **059** (conversa por canal — renumerada de 057; ver §3) · **060** (merge por canal, §6.6) |
| Servidor alvo | `https://go.local.ia.br` — Evolution GO v1.0, **91 endpoints**                                                                       |
| Data          | 2026-08-14                                                                                                                           |

---

## 1. O que a sondagem do servidor real mudou

A F0 foi executada em modo somente-leitura contra `go.local.ia.br`
(`node scripts/evolution-probe.mjs`). **Cinco fatos contradizem os dois documentos de
referência do repositório** e alteram decisões já tomadas no PRD.

| #   | Documentação dizia                                     | Servidor real                                                                                                  | Impacto                            |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | 59 endpoints                                           | **91**                                                                                                         | Superfície maior; ver §2           |
| 2   | **Botões e listas não existem** no Evolution Go        | `POST /send/button`, `/send/list`, `/send/carousel` **existem, com schema completo** — inclusive botão **Pix** | 🔴 Muda §6.2 e §10.1 do PRD        |
| 3   | Sem endpoint para alterar flags da instância           | `GET`/`PUT /instance/{id}/advanced-settings`                                                                   | 🔴 "Editar instância" é viável     |
| 4   | Erro padronizado `{success,error:{code,message},meta}` | **`{"error":"not authorized"}`** — string plana. 404 é `text/plain`                                            | 🔴 Mapeamento de erro do adaptador |
| 5   | `/message/downloadimage` (com bug 429)                 | O path é **`/message/downloadmedia`**                                                                          | Nome corrigido                     |

Confirmados como previsto: envelope de sucesso `{ data, message }`; escopo de chave (a chave
global responde **401** em `/instance/status` — só vale para `all`/`create`/`delete`/`proxy`);
webhook sem assinatura.

**Evidência:** `scripts/.evolution-probe-result.json` e `scripts/.evolution-endpoints.txt`
(ambos gerados pela sonda, fora do versionamento).

### 1.1 Consequência que exige decisão empírica

O endpoint `/send/button` **existir** não prova que o WhatsApp **renderiza** o botão numa
conexão não-oficial. A restrição citada nas referências é de protocolo (Multi-Device), não de
API — a Evolution pode aceitar a requisição e o aparelho do destinatário exibir apenas o
texto, ou nada.

### 1.1-bis 🔴 VEREDITO: botões e listas **não funcionam** no canal QR

Teste executado contra número real (`5519992876519`), pela instância `deploy`, em 12/08:

| Endpoint       | Resultado                                          |
| -------------- | -------------------------------------------------- |
| `/send/text`   | ✅ 200 — entregue                                  |
| `/send/poll`   | ✅ 200 — entregue                                  |
| `/send/button` | ❌ **500 `{"error":"server returned error 405"}`** |
| `/send/list`   | ❌ **500 `{"error":"server returned error 405"}`** |

O `405` não é da Evolution: é o que **o servidor do WhatsApp** devolve ao `whatsmeow`. A
Evolution monta e envia a mensagem; a Meta recusa. Repetido duas vezes com payloads diferentes
(3 botões e 1 botão), mesmo resultado — é determinístico, não transitório.

**Confirmado no aparelho** (mantenedor, 12/08): texto e enquete chegaram; botão e lista não
chegaram. A evidência é ponta a ponta — não apenas código de resposta da API. Um `200` da
Evolution significa entrega real, e o `405` significa mensagem que **nunca sai**; não há
entrega silenciosa nem degradação automática pelo lado da Meta.

**Conclusões que ficam fechadas:**

1. `interactiveButtons: false` e `interactiveList: false` para `whatsapp_qr`. Não é
   conservadorismo: é o comportamento medido.
2. O guard em [`validate.ts`](../src/lib/automations/validate.ts) que bloqueia
   `fallback_channel` em `send_buttons`/`send_list` **está correto e permanece**. Sem ele, a
   automação falharia com um 500 opaco no meio do atendimento.
3. **Enquete é o único mecanismo interativo nativo** do canal QR — o que reabilita o plano de
   menus via `/send/poll` + `GET /polls/{id}/results` como evolução (SPEC 049), ao lado da
   degradação para texto numerado (PRD §10.1) no MVP.
4. O botão **Pix** (§2.1), por depender do mesmo transporte interativo, quase certamente cai
   no mesmo 405. Não vale investimento até que a Meta mude a regra.

Endpoint existir na API ≠ WhatsApp aceitar. Foi exatamente por isso que a §1.1 travou a
decisão até o teste real.

### 1.2 Sondagem contra instância conectada — o que só o servidor respondeu

Segunda rodada, com a instância real **"deploy"** (`5519992496598`, conectada). Somente
leitura. Fecha as quatro perguntas que faltavam e levanta três requisitos novos.

| Pergunta F0                       | Resposta do servidor                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Campos de `/instance/status`      | `{"data":{"Connected":true,"LoggedIn":true,"Name":"<nome do perfil>"},"message":"success"}`                                |
| Shape da instância                | `/instance/all` e `/instance/info/{id}` devolvem o registro completo — inclusive o **token em texto claro**                |
| `advanced-settings` aceita token? | **Sim, e SÓ token** — com a chave global responde `401`                                                                    |
| Campo do QR                       | Instância conectada → **`400 {"error":"session already logged in"}`**. O nome do campo só aparece em instância nova (§8.2) |

#### 🔴 R1 — O escopo de chave é por endpoint, não por regra

Não existe "rotas administrativas usam a global". É endpoint a endpoint:

| Endpoint                                                      | Chave que funciona | Observado      |
| ------------------------------------------------------------- | ------------------ | -------------- |
| `/instance/all`, `/instance/info/{id}`, `/instance/logs/{id}` | **global**         | token → `401`  |
| `/instance/{id}/advanced-settings`                            | **token**          | global → `401` |
| `/instance/status`, `/send/*`, `/user/*`                      | **token**          | global → `401` |

O adaptador carrega um **mapa explícito de escopo por rota**. Deduzir a chave pelo prefixo do
path produz `401` intermitente e difícil de diagnosticar.

#### 🔴 R2 — O envelope não é uniforme

Três formatos convivem:

```jsonc
{"data": {...}, "message": "success"}   // /instance/all, /status, /user/check, /user/info
{"alwaysOnline": false, ...}            // /instance/{id}/advanced-settings — objeto CRU
[{"timestamp": "...", "level": "INFO"}] // /instance/logs/{id} — array CRU
```

O adaptador **nunca** assume `body.data`. Um helper `unwrap(body)` devolve `body.data ?? body`,
e cada chamada declara a forma que espera.

#### 🔴 R3 — `/user/info` NÃO traduz LID em telefone

A mitigação que o PRD §8.9 previa **não funciona**. Consultando o LID diretamente:

```jsonc
// POST /user/info  {"number":["226559659127039@lid"]}
{
  "data": {
    "Users": {
      "226559659127039@lid": {
        "VerifiedName": null,
        "LID": null,
        "Devices": [
          "226559659127039@lid",
          "226559659127039:11@lid",
          "226559659127039:12@lid",
        ],
      },
    },
  },
  "message": "success",
}
```

Nenhum telefone, nenhum JID. O caminho **inverso** existe — `/user/check` com um telefone
devolve o LID:

```jsonc
{
  "Query": "+5519992496598@s.whatsapp.net",
  "IsInWhatsapp": true,
  "JID": "5519992496598@s.whatsapp.net",
  "LID": "226559659127039@lid",
  "VerifiedName": "Bruno Pelatieri Goulart",
}
```

**Consequência de projeto:** a tabela `contact_identities` que o PRD §7 adiava para "quando
chegar um canal sem telefone" passa a ser **necessária já na F4**:

```sql
CREATE TABLE contact_identities (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type text NOT NULL,
  external_id text NOT NULL,          -- ex.: '226559659127039@lid'
  PRIMARY KEY (account_id, channel_type, external_id)
);
```

`account_id` entra na PK (revisão pré-aplicação da 056): o LID identifica quem enviou a
mensagem, não a conta que a recebeu — o mesmo contato externo pode falar com duas contas
diferentes na mesma VPS compartilhada. PK global colidiria (ou vazaria `contact_id` de um
tenant para outro); escopando por conta cada tenant grava seu próprio vínculo sem conflito.

Estratégia: ao criar/atualizar um contato no canal QR, resolver o LID uma vez via
`/user/check` e gravar o vínculo. Um inbound que chegue **só** como LID casa por esta tabela.
Sem vínculo conhecido → **descartar com log alto**, nunca criar contato com identificador
sintético.

#### 🔴 R4 — O JID carrega sufixo de dispositivo

`"jid": "5519992496598:12@s.whatsapp.net"` — o `:12` é o número do dispositivo. A extração do
telefone precisa remover **`:NN` antes do `@`**, senão o dedupe da migração 022 nunca casa.
Teste unitário obrigatório no adaptador.

#### R5 — `subscribe` vazio entrega quase nada

A instância "deploy" foi conectada sem `subscribe`, e o servidor registrou
`"events": "MESSAGE"`, `"webhook": ""`. Confirma que o default é mínimo: nosso fluxo de
criação **sempre** envia a lista completa de eventos e a `webhookUrl` no `connect`.

#### R6 — `/instance/info/{id}` devolve o token em texto claro

Rota útil no servidor, **proibida** de ser proxiada ao browser em qualquer circunstância.

### 1.3 Ciclo de vida completo — as duas últimas respostas

Terceira rodada, com `--lifecycle`: instância `probex2` criada, conectada, QR capturado e
**apagada** (VPS confirmada limpa). F0 **fechada**.

#### 🔴 R8 — `token` é OBRIGATÓRIO no `create`

Os dois documentos de referência afirmam que o token é "gerado automaticamente se omitido". É
falso:

```
POST /instance/create {"name":"probex1"}   → 400 {"error":"token is required"}
POST /instance/create {"name":"probex2","token":"<uuid>"}  → 200
```

**Isso é bom para nós.** O token nasce do nosso lado (`randomUUID()`), é cifrado com
`ENCRYPTION_KEY` antes de tocar o banco, e não dependemos de parsear a resposta para
descobrir o segredo. O fluxo de criação da F3 gera o UUID, envia, e só então persiste.

Resposta do `create` (envelope `{data, message}`):

```jsonc
{"data":{"id":"294425af-…","name":"probex2","token":"<o que enviamos>","webhook":"",
  "jid":"","qrcode":"","connected":false,"events":"","proxy":"null",  // string "null", não null
  "createdAt":"2026-08-12T17:16:23-03:00","alwaysOnline":false,…},"message":"success"}
```

#### 🔴 R9 — O campo do QR é `qrcode`, minúsculo — e vem pronto para renderizar

```jsonc
// GET /instance/qr numa instância recém-conectada
{
  "data": {
    "qrcode": "data:image/png;base64,iVBORw0KGgo…", // 1862 chars — data URI COMPLETO
    "code": "https://wa.me/settings/linked_devices#2@WlQc5u/gdHz…", // 277 chars
  },
  "message": "success",
}
```

Duas correções: a referência documenta `Qrcode` (maiúsculo) — é **`qrcode`**; e `code` não é
a string `2@…` crua, é uma **URL `wa.me` completa**.

Ganho de UX inesperado: como `code` é um deep link, a aba pode oferecer **"abrir no celular"**
além de escanear — resolve quem está acessando o CRM pelo próprio telefone e não tem uma
segunda tela para escanear.

`qrcode` já é `data:image/png;base64,…`, então o `<img src>` recebe o valor direto, sem
montagem de prefixo.

#### R10 — `connect` devolve a lista de eventos aceita

```jsonc
{
  "data": {
    "eventString": "MESSAGE,SEND_MESSAGE,READ_RECEIPT,CONNECTION,QRCODE",
    "jid": "",
    "webhookUrl": "https://example.invalid/probe",
  },
  "message": "success",
}
```

O `eventString` é o **eco do que foi aceito** — a F3 compara com o que enviou e alerta se
divergir, em vez de assumir que registrou.

#### R7 — `GET /instance/qr` custa ~3 s, sempre

Medido repetidamente: **3,0 s** de latência fixa, inclusive no caminho de erro
(`400 session already logged in`). Todo o resto responde em 10–250 ms, então não é rede — é
espera interna da Evolution.

Impacto no desenho do diálogo de conexão (F3):

- o QR **não** pode ser buscado em polling curto — a cada 3 s a chamada anterior ainda estaria
  aberta. O ciclo de atualização do QR nunca desce de ~5 s;
- quem confirma o pareamento é o evento `CONNECTION` do webhook, **não** o polling. O polling
  de `/instance/status` (rápido, ~10 ms) existe só como rede de segurança;
- a UI mostra estado de carregamento desde o primeiro clique: 3 s de tela parada leem como
  travamento.

---

**Postura desta SPEC:** o guard conservador já implementado em
[`validate.ts`](../src/lib/automations/validate.ts) — que bloqueia `fallback_channel` em
`send_buttons`/`send_list` — **permanece** até que a F0-completa (§8.2) demonstre renderização
num aparelho real. Só então a capacidade `interactiveButtons` do canal QR muda para `true` e o
guard é removido. Prometer botão que não aparece é pior que não oferecer.

---

## 2. Superfície adotada

Dos 91 endpoints, esta SPEC usa **16**. O restante fica fora de escopo (grupos, comunidades,
newsletters, etiquetas do WhatsApp, status/stories, passkey, licença).

| Uso                        | Endpoint                                                | Chave     |
| -------------------------- | ------------------------------------------------------- | --------- |
| Listar instâncias          | `GET /instance/all`                                     | global    |
| Criar                      | `POST /instance/create`                                 | global    |
| Excluir                    | `DELETE /instance/delete/{instanceId}`                  | global    |
| Definir/remover proxy      | `POST`/`DELETE /instance/proxy/{id}`                    | global    |
| Conectar (webhook+eventos) | `POST /instance/connect`                                | instância |
| QR                         | `GET /instance/qr`                                      | instância |
| Código de pareamento       | `POST /instance/pair`                                   | instância |
| Status                     | `GET /instance/status`                                  | instância |
| Desconectar / deslogar     | `POST /instance/disconnect` · `DELETE /instance/logout` | instância |
| Reconectar                 | `POST /instance/reconnect`                              | instância |
| Flags da instância         | `GET`/`PUT /instance/{id}/advanced-settings`            | instância |
| Diagnóstico                | `GET /instance/logs/{instanceId}`                       | instância |
| Envio                      | `POST /send/{text,media,location,poll}`                 | instância |
| Mensagem                   | `POST /message/{react,markread,presence}`               | instância |
| Mídia recebida             | `POST /message/downloadmedia`                           | instância |

**Reservados para a SPEC 049** (dependem de validação de renderização): `/send/button`,
`/send/list`, `/send/carousel`, `GET /polls/{id}/results`, `POST /chat/history-sync`.

### 2.1 Achado de produto: botão Pix

`Button.type` aceita `reply | copy | url | call | **pix**`, com `keyType` em
`phone|email|cpf|cnpj|random`, `key`, `currency` e `name` do recebedor. Num CRM feito para o
mercado brasileiro isso é diferencial de peso — cobrança dentro da conversa, sem link externo.
**Não entra nesta SPEC** (depende da mesma validação de renderização), mas fica registrado
como candidato prioritário da 049.

---

## 3. Modelo de dados

Idêntico ao PRD 047 §7 — reproduzido aqui apenas no que a implementação precisa decidir.

### Migração 055 — `channels`

Registro único de canal por conta, com `type ∈ {whatsapp_cloud, whatsapp_qr}`, `status`,
`is_default`, índices únicos parciais (um Cloud por conta, um padrão por conta). Backfill:
toda `whatsapp_config` existente vira um canal `whatsapp_cloud` padrão. RLS: `SELECT` para
membros, escrita `admin+`.

### Migração 056 — `evolution_instances` + segredos + `contact_identities`

`evolution_instances` (1:1 com `channels`), mais `evolution_instance_secrets` com
`instance_token_encrypted` (AES-256-GCM via `ENCRYPTION_KEY`) e `webhook_secret` — tabela
**sem nenhuma policy**, só `service_role` lê. `accounts.evolution_instance_limit` (nullable).

Campo adicional confirmado pela sondagem: `advanced_settings jsonb` espelhando
`AdvancedSettings` (`alwaysOnline`, `rejectCall`, `msgRejectCall`, `readMessages`,
`ignoreGroups`, `ignoreStatus`), para a UI mostrar sem ir à VPS a cada render.

**`contact_identities` entra aqui, não depois** (§1.2 R3): sem ela não há como casar um
inbound que chegue só com LID, e `/user/info` não resolve o caminho inverso.

### Migração 059 — conversa por canal

`conversations.channel_id NOT NULL`, troca do índice `UNIQUE(account_id, contact_id)` por
`UNIQUE(account_id, contact_id, channel_id)`, mais o bloco de asserção da SPEC 045
(PRD §7.1.4). `channel_id` **imutável** por trigger.

> ⚠️ **Renumerada de 057 para 059** (2026-08-14). O PRD 047 ainda descreve esta migração como
> "057" — os números 057 e 058 foram consumidos por dois commits não-relacionados
> (`057_notification_text_ptbr`, `058_message_delivery_error`) antes desta rodar. O conteúdo é
> o mesmo; só o número e os textos de asserção (`'059: ...'`) mudaram. Aplicada em `vn`, `rs` e
> `jh` em 2026-08-14 — ver [`059_conversation_channel.sql`](../supabase/migrations/059_conversation_channel.sql).

---

## 4. Camada de canais (F1)

```
src/lib/channels/
  types.ts            ChannelType · ChannelAdapter · NormalizedInbound · SendResult
  capabilities.ts     matriz declarativa + can()
  registry.ts         getAdapter(type) — o único switch por tipo do sistema
  resolve.ts          resolveChannel() — único ponto que decripta credencial
  session-window.ts   resolveSessionWindow() — PRD §7.1.1
  cold-send-limit.ts  ✅ JÁ IMPLEMENTADO (27 testes)
  ingest.ts           caminho único de entrada (F2)
  send.ts             caminho único de saída (F2)
  adapters/
    whatsapp-cloud.ts embrulha lib/whatsapp/meta-api.ts
    evolution.ts      cliente HTTP (F4)
```

**F1 não muda comportamento observável.** Critério de aceite: suíte verde, canal Cloud
existente em `channels` para toda conta, e os quatro consumidores da janela de 24h migrados
para `resolveSessionWindow` com resultado idêntico ao atual.

---

## 5. Ingestão unificada (F2)

Extração de `processMessage()` do webhook da Meta para `ingest.ts`, **sem mudança de
comportamento**. A ordem das etapas, os comentários explicativos e o UPDATE monotônico da
âncora são preservados literalmente; o que muda é que passam a ser condicionais à capacidade
do canal.

Requisito novo e obrigatório: **idempotência** por `(conversation_id, message_id)` antes do
INSERT — deixa de ser defesa em profundidade e vira caminho quente, porque a Evolution
reentrega (§6.3).

> ⚠️ Fase de maior risco do projeto. PR isolado, sem nenhuma outra mudança, revisado com
> testes de paridade. Um erro aqui perde mensagem no canal oficial, em silêncio.

---

## 6. Adaptador Evolution (F4)

### 6.1 Cliente HTTP

Um `evolutionRequest(path, { method, key, body })` central, com:

- **Timeout** de `EVOLUTION_REQUEST_TIMEOUT_MS` (padrão 15 s) via `AbortController`;
- **Mapeamento de erro** contra o formato REAL observado, não o documentado:

```ts
// O servidor devolve {"error":"not authorized"} (string plana) em 401,
// e text/plain em 404. O envelope {success,error:{code,message},meta}
// da referência NÃO foi observado. Ler defensivamente os dois.
const message =
  typeof body?.error === 'string'
    ? body.error
    : (body?.error?.message ?? body?.message ?? `HTTP ${status}`);
```

| HTTP          | Tratamento                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| 401/403       | `channel_auth_failed` — marca `channels.status = 'error'` com detalhe; token provavelmente rotacionado na VPS |
| 400           | `bad_request` — erro de payload nosso, não do operador                                                        |
| 404           | `recipient_not_found`                                                                                         |
| 5xx / timeout | `channel_unavailable` — elegível a retry                                                                      |

- **Mapa explícito de escopo de chave por rota** (§1.2 R1) — deduzir pelo prefixo do path
  produz `401` intermitente;
- **`unwrap(body)` = `body.data ?? body`** (§1.2 R2) — três formatos de envelope convivem;
- **Leitura defensiva de campo**: o Swagger tipa as respostas como mapa genérico. Verificado:
  o QR vem em **`data.qrcode`** (minúsculo, já como `data:image/png;base64,…`) e o deep link em
  **`data.code`** (URL `wa.me` completa). O adaptador lê
  `data.qrcode ?? data.Qrcode ?? data.qrCode` — a referência documenta a grafia errada.
- **`GET /instance/qr` em instância conectada devolve `400 "session already logged in"`** — a
  UI trata como estado, não como erro: significa "já pareado", e o dialog deve fechar.

### 6.2 Envio

Normalização de número dentro do adaptador (o núcleo continua em E.164; a Evolution quer
`5511999999999` sem `+`). Mídia: URL assinada do bucket privado via
`resolveMediaUrlForServer()`, igual ao Cloud.

### 6.3 Webhook inbound

Rota `POST /api/channels/evolution/webhook/[secret]`. Três verificações **em cadeia**, todas
obrigatórias, antes de qualquer processamento: `secret` do path (comparação timing-safe) →
`instanceId` do payload → `instanceToken` do payload. Qualquer falha → `401`.

Responde `200` imediatamente e processa em `after()` — a política de retentativa da Evolution
é **5 tentativas de 30 s e depois descarte**, sem dead-letter.

⚠️ **O que se ASSINA e o que CHEGA usam vocabulários diferentes** — ver §6.7. A tabela abaixo
traz os dois; `EVENT_KINDS` aceita as duas grafias.

| Família assinada | `event` recebido                           | Tratamento                                                                                                                                      |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESSAGE`        | `Message`                                  | Ingestão como `customer`                                                                                                                        |
| `SEND_MESSAGE`   | `SendMessage`                              | Mensagem enviada pelo celular do operador → `agent` com `sender_id` nulo; **suprimir o eco** dos nossos envios casando pelo `Info.ID` devolvido |
| `READ_RECEIPT`   | `Receipt`                                  | `messages.status` (`state` do ENVELOPE: `Delivered`/`Read`/`ReadSelf`), respeitando a escada anti-regressão                                     |
| `CONNECTION`     | `Connected`, `LoggedOut`, `PairSuccess`, … | `channels.status` — vem do NOME do evento, não de booleanos; é o que dispensa polling na aba                                                    |
| `QRCODE`         | `QRCode`                                   | `last_qr_at`; **o QR nunca é persistido**                                                                                                       |

### 6.4 Identidade: telefone, LID e sufixo de dispositivo

Ordem de resolução ao ingerir, na sequência exata (§1.2 R3/R4):

1. `Info.Chat` / `Info.Sender` no formato `<telefone>[:<device>]@s.whatsapp.net` →
   **remover o sufixo `:NN`** e usar o telefone. Caminho normal.
2. Só `@lid` → consultar `contact_identities` pelo `external_id`. Casou, usa o contato.
3. Não casou → **descartar com log alto**. Nunca criar contato sintético.

`POST /user/info` **não** traduz LID em telefone (verificado — devolve `LID: null` e nenhum
JID). O vínculo só se constrói no sentido telefone → LID, via `POST /user/check`, e é gravado
em `contact_identities` quando o contato é criado ou atualizado no canal QR.

### 6.5 Mídia

**O `URL` do proto NÃO serve.** Ele aponta para o CDN do WhatsApp e o conteúdo ali é AES,
chaveado pelo `mediaKey` da própria mensagem. Baixar e subir esses bytes "funciona" — upload
200, `media_path` preenchido, bolha com player — e o player fica mudo. É recusado com log
explicando o que configurar; ver `isEncryptedWhatsappUrl`. Vale para `mmg.whatsapp.net` com ou
sem sufixo `.enc` (imagem enviada volta como `/o1/v/t24/...` sem `.enc`, igualmente cifrada).

Duas fontes servem, nesta ordem:

1. **`base64`** — com `WEBHOOK_FILES=true` (o padrão) a Evolution decripta e manda junto. A
   posição foi **medida**: é irmão do proto dentro de `Message`, não filho dele nem no nível
   de `data`.

   ```
   data.Message = { audioMessage: {URL, mediaKey, mimetype, …},
                    base64: "T2dnUw…",              ← aqui
                    messageContextInfo: {…} }
   ```

2. **`mediaUrl`** — objeto já em claro, quando a VPS tem MinIO/S3.

`MINIO_ENABLED=true` continua sendo o alvo de **produção** (o base64 infla ~33% e a Vercel
rejeita corpo acima de ~4,5 MB; o webhook falharia e, após 5 tentativas, o evento some), mas
não é pré-requisito para o canal funcionar. O bloqueio prático é de rede: `MINIO_ENDPOINT`
precisa ser um host que **o CRM** resolva — um hostname interno do Docker (`minio_minio`) a
Evolution resolve e o CRM não, e aí ligar MinIO é pior que deixar desligado, porque o servidor
para de mandar o base64 e a URL não é alcançável.

Nome do objeto no bucket: áudio de voz não tem `fileName` (é gravação, não arquivo), então a
extensão vem do mimetype — `audio/ogg; codecs=opus` → `media.ogg`. Sem isso tudo virava
`media.bin`.

🔴 **O `contentType` do upload vai SEM os parâmetros do mimetype.** `allowed_mime_types` do
bucket é comparado como **string literal** pelo Supabase Storage e lista tipos puros
(`audio/ogg`, `video/mp4`, …). Todo áudio de voz do WhatsApp chega como
`audio/ogg; codecs=opus` e era recusado com `mime type ... is not supported` — um tipo que a
lista permite, barrado pelo sufixo. O base64 chegava certo, era decodificado certo, e a mídia
morria na última linha, sem erro na UI. `baseMimeType()` (em `lib/storage/upload-media.ts`)
normaliza, e o mesmo helper protege o upload pelo browser, onde o `MediaRecorder` produz
`audio/webm;codecs=opus`. Um tipo legítimo que ainda assim falhe agora aparece nomeado no log,
com a instrução de incluí-lo em `allowed_mime_types`.

---

### 6.6 F4.1 — roteamento por canal (correção pós-revisão, 2026-08-14)

A revisão de código da F4 encontrou um furo que a própria §8.3 já previa testar: **a F4
fazia conversas QRCode aparecerem no inbox, mas nenhum caminho de SAÍDA lia
`conversations.channel_id`.** `sendMessageToConversation` e `sendAndPersistOutbound`
chamavam `resolveChannelContext(db, accountId)` sem tipo — o que cai no padrão
`whatsapp_cloud`. Responder uma thread do QRCode saía pelo **número oficial da Meta**:
mensagem cobrada, de outro número, fora de qualquer janela, e com um `wamid` que o eco
`SEND_MESSAGE` da Evolution nunca casaria.

A correção antecipa uma parte pequena do que a SPEC 049 cobre (inbox multicanal), porque
sem ela o teste manual §8.3 #3 — _"Resposta pelo inbox → chega no celular"_ — não passa:

| Ponto                                            | Antes                 | Agora                                                                                     |
| ------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------- |
| `resolveChannelForConversation()` (novo)         | —                     | Único tradutor conversa → canal                                                           |
| `sendMessageToConversation` (inbox + API v1)     | `whatsapp_cloud` fixo | Canal da conversa                                                                         |
| `sendAndPersistOutbound` (automações, flows, IA) | `whatsapp_cloud` fixo | Canal da conversa                                                                         |
| `/api/whatsapp/react`                            | Sempre Meta           | Adaptador do canal (`sendReaction`)                                                       |
| `ChannelAdapter.sendReaction`                    | Não existia           | Nos dois adaptadores — a matriz declarava `reactions: true` para QR sem ter implementação |

Os guards de capacidade de `sendContentViaChannel` fazem o resto: template ou botão pedido
numa conversa QR vira `ChannelCapabilityError` → HTTP **400** com motivo legível, em vez de
um 502 "Meta API error" culpando a Meta por algo que nunca chegou a ela.

**O que ainda é da SPEC 049:** filtro e badge de canal no inbox, composer que esconde o que o
canal não faz, e ficha de contato multicanal. Esta correção só garante que o que o operador
já consegue fazer hoje saia pelo canal certo.

**Outras correções da mesma revisão** (todas com teste): `media_path` no eco do operador
(mídia enviada pelo celular virava bolha vazia); figurinha mapeada para `image`; proto não
reconhecido descartado em vez de virar bolha em branco; sufixo `:NN` normalizado também no
LID (§1.2 R4 vale para os dois identificadores); fallback `Info.Sender` desligado em eco (ali
`Sender` é o nosso próprio número); recibo de leitura escopado por conta/canal e resolvido
por id interno (`message_id` não é único — migração 009); e o adaptador deixou de lançar
depois da entrega confirmada (lançar ali fazia o operador reenviar e o cliente receber duas
vezes).

**Migração 060** acompanha: `merge_duplicate_conversations()` (036) ainda agrupava por
`(account_id, contact_id)` e, rodada pós-059, fundiria a thread Cloud com a do QRCode do
mesmo contato.

### 6.7 F4.2 e F4.3 — o que só o número real mostrou (2026-08-14)

Duas rodadas de teste manual com um WhatsApp de verdade. **Nenhum dos defeitos abaixo
apareceu como erro** — todos se manifestaram como mensagem que não chega, áudio que não toca
ou bolha repetida, com a suíte 100% verde nas duas vezes.

**F4.2 — nomes e caixa.** `event` não traz o nome da FAMÍLIA assinada: assina-se
`SEND_MESSAGE` e chega `SendMessage`; `READ_RECEIPT` → `Receipt`; `CONNECTION` →
`Connected`/`LoggedOut`/`PairSuccess`. O `switch` comparava com os nomes de família, então só
`Message` e `QRCode` casavam, por coincidência. Eco do celular, recibo e status de conexão
estavam mortos em silêncio — e a pista foi `connected_jid` nulo no banco com a instância
pareada. Junto: o `state` do recibo vem no ENVELOPE (irmão de `event`), não em `data`; e o
evento `Connected` traz `{status:"open", jid}`, sem os booleanos `Connected`/`LoggedIn` que só
existem em `/instance/status` — lendo booleanos ausentes, conectar marcava o canal como
**desconectado**.

**F4.3 — níveis.** Os dois campos que restavam estavam sendo lidos no nível errado:

| Campo     | Onde procurávamos                    | Onde está (medido)   | Sintoma                                               |
| --------- | ------------------------------------ | -------------------- | ----------------------------------------------------- |
| id da msg | `data.ID`, `data.key.ID`             | **`data.Info.ID`**   | `message_id` vazio → cada resposta duplicada no inbox |
| base64    | `audioMessage.base64`, `data.base64` | **`Message.base64`** | "Áudio indisponível" / foto que não abre              |

O id vazio era a causa RAIZ da duplicação: sem ele, o eco `SendMessage` não reconhecia o que o
próprio CRM tinha acabado de mandar e inseria uma segunda linha. O banco do teste mostrou o
par perfeitamente — a bolha do eco com o id e sem mídia, a nossa com mídia e `message_id`
vazio, em ✓ contra ✓✓, porque só a do eco casava com o recibo.

Mais duas correções da mesma rodada, ambas nascidas de **cronometrar** o log e não de ler o
código:

- **O recibo corre com a nossa própria gravação, e na mídia ele ganha.** `POST
/api/whatsapp/send` de uma imagem levou 5,6 s (assinar URL, subir ao bucket, esperar a
  Evolution) e o `Delivered` daquele id chegou ANTES da resposta do provedor. Sem espera, a
  consulta não casava nada e toda mídia enviada ficava presa em "enviada" para sempre.
  `findReceiptTargets` tenta de novo em 0/1/2,5 s, só no caso do miss, dentro do `after()`.
- **Eco de mídia enviada pelo inbox deixava objeto órfão.** O eco carrega o arquivo inteiro em
  base64 (2,3 MB numa foto do teste); `ingest.ts` descartava a duplicata só DEPOIS do upload.
  `echoAlreadyStored` fecha a porta antes do download.

**F4.4 — a mídia chegou ao bucket e a UI não olhava para lá.** Com as correções acima,
`media_path` passou a ser preenchido corretamente. A bolha continuava dizendo "Áudio
indisponível" porque o gate era `!!message.media_url` — e o canal QRCode **nunca** preenche
`media_url`: o webhook baixa da Evolution e sobe ao bucket, sem URL pública em momento algum
(§6.5). Os wrappers (`MediaImage`/`MediaAudio`/`MediaVideo`/`DocumentLink`) já recebiam `path`
e sabiam resolvê-lo; o gate é que nunca os deixava tentar. Agora a pergunta é feita a
`resolveMediaRef`, que é quem conhece a precedência entre as três colunas. O mesmo filtro por
URL excluía imagem QR da galeria do lightbox — o clique para ampliar não fazia nada.

Junto: o `contentType` do upload ia com os parâmetros do mimetype, e o bucket os recusa (§6.5).

**F4.5 — a UI passou a enxergar o canal.** Duas consequências da 059 apareceram no teste real,
e as duas nasciam da mesma falta: nada na UI sabia a que canal uma conversa pertence.

Uma conversa por `(contato, canal)` significa que o mesmo contato atendido pelo oficial e por
uma instância QRCode rende **duas linhas na lista** — e, sem selo, idênticas. Foi lido como
"contato duplicado"; o banco desmentiu (um `contact_id`, zero telefones repetidos em toda a
base). O que faltava era dizer qual linha é de qual número. Decisão do mantenedor: **manter uma
thread por canal e marcar o canal**, preservando o que os canais têm de diferente — números
distintos, janela de 24h só no oficial, template só no oficial — e garantindo que a resposta
sempre saia pelo número em que o cliente escreveu. O selo só aparece com mais de um canal: numa
conta que só usa o oficial, repetir "WhatsApp Oficial" em toda linha é ruído.

O timer de 24h lia `conversation.channel.type`, mas `CONVERSATION_SELECT` **não faz embed de
`channels`** — o campo chega sempre indefinido, caía no padrão `whatsapp_cloud`, e uma thread
QRCode exibia "23h restantes": um prazo que não existe naquele canal (PRD §7.1.1). O código já
estava certo; o dado que ele lia é que nunca era carregado.

Os dois passam a resolver o canal por `useAccountChannels()` — uma consulta por sessão,
cruzada em memória. **Não** um embed: `lib/channels/send.ts` já documenta o `PGRST200` de
relacionamento recém-criado, e ali o custo de errar é uma consulta, enquanto no
`CONVERSATION_SELECT` seria a lista inteira do inbox falhando. Uma conta tem um punhado de
canais e centenas de conversas, então cruzar em memória também é menos trabalho que repetir o
join por linha.

**A lição transversal:** o servidor mistura três convenções no mesmo payload — `encoding/json`
sobre struct Go (`Info`, `Chat`, `ID`), protojson sobre o proto (`audioMessage`, `mediaKey`,
`URL`) e campos do envelope (`event`, `state`). `lib/evolution/payload.ts` faz a leitura
indiferente à caixa e elimina essa classe de erro; o que ela **não** cobre é o nível errado,
que foi exatamente o que sobrou para a F4.3. Fixture inventada reproduz a suposição do autor:
os testes de mídia da F4.2 penduravam o `base64` dentro do proto e ficavam verdes enquanto
nenhum áudio tocava. As fixtures de hoje são recortes do payload real, e cada uma foi
verificada falhando contra o código antigo antes de ser aceita.

`EVOLUTION_DEBUG=true` loga a FORMA do payload (sem base64, sem segredo) — foi a ferramenta
que fechou as duas rodadas.

---

## 7. Gerenciamento de instâncias (F3)

Rotas `/api/channels/evolution/*`, todas `admin+`, rate-limited, com a chave global e os
tokens **exclusivamente server-side**.

| Rota                                                         | Ação                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `POST /instances`                                            | Cria (nome namespaced §7.1), encadeia `connect`, guarda token cifrado |
| `GET /instances`                                             | Lista com status                                                      |
| `GET /instances/[id]/qr`                                     | Proxy do QR — **nunca persistido, nunca cacheado**                    |
| `POST /instances/[id]/pair`                                  | Código de pareamento por telefone                                     |
| `GET /instances/[id]/status`                                 | Status ao vivo                                                        |
| `PATCH /instances/[id]`                                      | Rótulo local + `advanced-settings` (PUT na VPS)                       |
| `POST /instances/[id]/disconnect` · `/logout` · `/reconnect` | Ciclo de vida                                                         |
| `DELETE /instances/[id]`                                     | Exclui na VPS e no banco; **conversas preservadas**                   |

### 7.1 Nome namespaced

`<prefix>_<8 hex do account_id>_<slug>_<4 hex aleatórios>` — a VPS é compartilhada entre
contas e `name` é global nela.

### 7.2 Limite (PRD D-1)

`COALESCE(accounts.evolution_instance_limit, EVOLUTION_MAX_INSTANCES_PER_ACCOUNT)`, e a
criação também falha se o deployment já atingiu `EVOLUTION_MAX_INSTANCES_TOTAL`.

### 7.3 Aba "WhatsApp QRCode"

Seção nova em `SETTINGS_SECTIONS`, com o aviso permanente de risco (não dispensável), contador
de uso, cards por instância, fluxo de conexão com QR + contagem regressiva + aba de código de
pareamento, e exclusão com confirmação por digitação. Sem `EVOLUTION_API_URL`, a aba aparece
**desabilitada com instruções** — nunca some, nunca 503 silencioso.

---

## 8. Plano de teste

### 8.1 Testes automatizados (co-locados, Vitest)

| Arquivo                                                                 | Cobre                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/channels/capabilities.test.ts`                                 | Matriz completa; nenhum tipo com capacidade indefinida                                                                                                                                              |
| `src/lib/channels/registry.test.ts`                                     | Todo `ChannelType` resolve adaptador                                                                                                                                                                |
| `src/lib/channels/resolve.test.ts`                                      | Precedência explícito > conversa > padrão; tenancy cruzada negada                                                                                                                                   |
| `src/lib/channels/session-window.test.ts`                               | `applicable:false` em QR; paridade exata com `computeSessionWindow` em Cloud                                                                                                                        |
| `src/lib/channels/ingest.test.ts`                                       | **Paridade com o comportamento pré-refactor** + idempotência                                                                                                                                        |
| `src/lib/channels/send.test.ts`                                         | Capacidade ausente → `unsupported_by_channel`; persistência única                                                                                                                                   |
| `src/lib/channels/adapters/evolution.test.ts`                           | Normalização de número; **mapeamento do erro real** (`{"error":"..."}` e `text/plain`); leitura defensiva do campo do QR                                                                            |
| `src/lib/channels/send.test.ts` (bloco `resolveChannelForConversation`) | **F4.1**: conversa QR resolve credencial da instância e NUNCA toca `whatsapp_config`; conversa Cloud resolve Cloud; `channel_id` nulo cai no Cloud (compat pré-059); canal apagado falha com motivo |
| `src/lib/channels/adapters/evolution-inbound.test.ts`                   | `MESSAGE`, `SEND_MESSAGE` (incl. supressão de eco), `READ_RECEIPT`, `CONNECTION`; **resolução de LID**                                                                                              |
| `src/lib/channels/limits.test.ts`                                       | Limite de instâncias nas três camadas (D-1)                                                                                                                                                         |
| `src/app/api/channels/evolution/webhook/route.test.ts`                  | 401 em secret/instanceId/token inválidos; timing-safe                                                                                                                                               |
| ✅ `src/lib/channels/cold-send-limit.test.ts`                           | **27 testes — já verdes**                                                                                                                                                                           |
| ✅ `src/lib/automations/window-fallback.test.ts`                        | **20 testes — já verdes**                                                                                                                                                                           |

Não-regressão da SPEC 045 (PRD §7.1.6): `engine.window.test.ts`,
`engine.condition.test.ts`, `window-scan.test.ts`, `ingest.session-window.test.ts`.

### 8.2 Sonda contra o servidor real — `scripts/evolution-probe.mjs`

```bash
node scripts/evolution-probe.mjs
```

Somente leitura, sem efeito colateral algum. **Já executada — 11 respostas**, e quando existe
instância pareada ela sozinha fecha escopo de chave, envelope, sufixo de dispositivo no JID,
LID e assinatura de eventos. Evidência em `scripts/.evolution-probe-result.json` (com tokens
redigidos, fora do versionamento).

Rodar de novo é o **teste de regressão contra atualizações da VPS**: qualquer resposta que
mude aparece na hora.

```bash
node scripts/evolution-probe.mjs --lifecycle
```

Cria `zapcrm_probe_<id>` (com token gerado por `randomUUID()` — §1.3 R8), executa `connect` →
`qr` → `status` → `advanced-settings` e **apaga ao final**. Executada em 12/08: F0 fechada, VPS
verificada limpa depois. Acrescente `--keep` para manter e parear um número — necessário para
os testes manuais abaixo.

### 8.3 Testes manuais obrigatórios antes do merge da F4

1. Parear um número real por **QR** e por **código de pareamento**.
2. Mensagem do celular → aparece no inbox com o contato certo.
3. Resposta pelo inbox → chega no celular.
4. **Responder pelo celular** → aparece no CRM como `agent` (evento `SEND_MESSAGE`), **sem
   duplicar** o que o CRM enviou.
5. Recibo de leitura reflete em `messages.status`.
6. Enviar mídia nos dois sentidos; conferir que sobe ao bucket privado.
7. Derrubar a internet do aparelho → status vira "Desconectado" na aba.
8. Reentregar o mesmo webhook duas vezes (repetir o POST) → **uma** mensagem no banco.
9. **Botões**: enviar `/send/button` para um aparelho real e observar o que aparece — é este
   teste que decide §1.1.

---

## 9. Configuração exigida na VPS

| Variável                 | Valor     | Por quê                                                    |
| ------------------------ | --------- | ---------------------------------------------------------- |
| `MINIO_ENABLED`          | `true`    | §6.5 — evita estourar o limite de corpo da Vercel          |
| `WEBHOOK_URL`            | **vazio** | Webhook global dispara em paralelo → todo evento duplicado |
| `DATABASE_SAVE_MESSAGES` | `true`    | Sem isso `/message/status` responde vazio                  |
| `CONNECT_ON_STARTUP`     | `true`    | Instâncias voltam sozinhas após restart                    |
| `EVENT_IGNORE_GROUP`     | `true`    | Não suportamos grupos — filtrar na origem é mais barato    |
| `EVENT_IGNORE_STATUS`    | `true`    | Stories não interessam ao CRM                              |

**Deploy:** a janela de tolerância do webhook é de ~2,5 min (5 × 30 s) e não há dead-letter.
Deploys que derrubem a rota por mais que isso perdem eventos.

---

## 10. Ordem de execução

| Fase | Entrega                                          | Depende de     |
| ---- | ------------------------------------------------ | -------------- |
| F0   | Sonda `--lifecycle` + teste de botões            | —              |
| F1   | Migração 055 + `lib/channels` + adaptador Cloud  | —              |
| F2   | `ingest.ts` + `send.ts` + webhook Meta reescrito | F1             |
| F3   | Migração 056 + rotas + aba "WhatsApp QRCode"     | F1             |
| F4   | Adaptador Evolution + webhook + mensageria       | **F0, F2, F3** |

F2 antes de F4 é inegociável: sem ela nasce o sexto caminho de envio paralelo.

**Modelo recomendado:** Opus 5 para a F2 (caminho crítico, erro perde mensagem em silêncio);
Sonnet 5 para F0/F1/F3/F4.
