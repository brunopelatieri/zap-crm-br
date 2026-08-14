# Evolution Go — Referência Completa (API WhatsApp em Go)

> Documento de referência técnica consolidado para desenvolvimento assistido por LLM (Claude Opus 5 / Sonnet 5).
> Fonte primária: [docs.evolutionfoundation.com.br/evolution-go](https://docs.evolutionfoundation.com.br/evolution-go) — páginas de referência individuais geradas a partir das specs **OpenAPI 3.0.0** oficiais (fonte mais confiável e autoconsistente do site) + guias narrativos (getting-started, webhooks, Postman, N8N) + repositório oficial no GitHub.
> Gerado em: 2026-08-12

---

## Objetivo

Reunir, em um único lugar, tudo necessário para **integrar e automatizar via requisições HTTP** com o Evolution Go: autenticação, os **59 endpoints** da API (path, método, schema de request, exemplo de resposta), sistema de eventos/webhook completo (payloads reais por tipo de evento), variáveis de ambiente, e como usar a collection Postman oficial. Complementa o `EVOLUTION_API_REFERENCE.md` (irmã em TypeScript) — **não confundir os dois**: são produtos distintos, com contratos de API diferentes.

---

## ⚠️ Nota crítica sobre inconsistências na documentação oficial

Durante a pesquisa, foram encontradas **divergências entre páginas diferentes** do mesmo site oficial:

| Fonte                                                                                                                                           | `POST /instance/create` body                                                          | Endpoint de QR Code                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Páginas de referência de endpoint** (`/evolution-go/create-a-new-instance`, `/evolution-go/get-instance-qr-code`) — geradas direto do OpenAPI | `{ "name": "...", "token": "...", "proxy": {...} }`                                   | `GET /instance/qr` (instância resolvida pelo header `apikey`) |
| **Guias narrativos** (`/evolution-go/installation`, `/evolution-go/install/postman`)                                                            | `{ "instanceName": "...", "integration": "WHATSAPP-BAILEYS" }` (estilo Evolution API) | `GET /instance/{name}/qrcode` (path param)                    |

**Este documento adota como fonte de verdade as páginas de referência individuais (OpenAPI)**, por serem geradas automaticamente a partir do contrato real da API e serem internamente consistentes entre si (mesmos nomes de campo, mesmo padrão de resposta em todos os 59 endpoints). Os guias narrativos parecem conter exemplos desatualizados ou copiados por engano do produto irmão (Evolution API). **Sempre teste contra sua instância real antes de depender de um exemplo específico.**

---

## Arquitetura (resumo)

| Item                            | Detalhe                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Linguagem                       | Go 1.24+                                                                      |
| Framework HTTP                  | `net/http` + `ServeMux` (biblioteca padrão, sem framework externo)            |
| Biblioteca WhatsApp             | [whatsmeow](https://github.com/tulir/whatsmeow) (Tulir Asokan)                |
| Banco de dados                  | PostgreSQL (via GORM) — dois bancos: `POSTGRES_AUTH_DB` e `POSTGRES_USERS_DB` |
| Documentação interativa         | Swagger/OpenAPI, disponível em `{baseUrl}/swagger/index.html`                 |
| Mídia                           | MinIO/S3 (opcional) — sem isso, mídia trafega em base64 no payload            |
| Eventos em tempo real           | Webhook HTTP, RabbitMQ (AMQP), NATS, WebSocket — múltiplos simultâneos        |
| Container                       | Docker / imagem oficial `evoapicloud/evolution-go`                            |
| Telemetria                      | Coleta anônima de rotas usadas + versão da API (sem dados sensíveis)          |
| Licença                         | Apache 2.0 + condições de proteção de marca (ver `TRADEMARKS.md` no repo)     |
| Repositório oficial             | `https://github.com/evolution-foundation/evolution-go`                        |
| Servidores de exemplo (OpenAPI) | `http://localhost:8080` · `https://localhost:8080` · `{customUrl}`            |

---

## Autenticação

Todas as requisições exigem o header:

```
apikey: SUA_CHAVE_AQUI
```

Dois tipos de chave, com escopos diferentes:

| Tipo                                            | Uso                                                               | Endpoints que exigem                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Key Global** (`GLOBAL_API_KEY` do `.env`) | Operações administrativas                                         | `/instance/create`, `/instance/delete/{id}`, `/instance/all`                                                                                             |
| **Token da instância**                          | Operações da instância específica (enviar mensagem, grupos, etc.) | Todos os demais — a instância é resolvida **implicitamente pelo valor do token no header `apikey`**, sem precisar de `instanceName`/`instanceId` no body |

```bash
# Exemplo com API Key Global (criar instância)
curl -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: SUA_GLOBAL_API_KEY" \
  -d '{"name":"vendas","token":"token-unico-vendas"}'

# Exemplo com token de instância (enviar texto)
curl -X POST http://localhost:8080/send/text \
  -H "Content-Type: application/json" \
  -H "apikey: token-unico-vendas" \
  -d '{"number":"5519999999999","text":"Olá!"}'
```

> Nas páginas de webhook/Postman aparece também um header `instanceId` (UUID) sendo enviado junto — provavelmente relevante em fluxos administrativos (conectar/gerenciar uma instância específica usando a chave global). Para as operações do dia a dia (enviar mensagem, etc.), o token da instância no `apikey` já é suficiente e é o padrão confirmado por todas as 59 páginas de referência de endpoint.

---

## Formato de resposta e erro padrão

**Erro** (idêntico ao padrão da Evolution API — schema `ErrorResponse` presente em todos os 59 endpoints):

```json
{
  "success": false,
  "error": { "code": "BAD_REQUEST", "message": "Descrição do erro" },
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "path": "/instance/create",
    "method": "POST"
  }
}
```

| HTTP | `error.code`            |
| ---- | ----------------------- |
| 400  | `BAD_REQUEST`           |
| 401  | `UNAUTHORIZED`          |
| 403  | `FORBIDDEN`             |
| 404  | `NOT_FOUND`             |
| 500  | `INTERNAL_SERVER_ERROR` |

**Sucesso:** varia por endpoint, mas segue o padrão `{ "message": "success", "data": {...} }` no exemplo do OpenAPI (a propriedade de nível superior descrita no schema — `success`/`instances`/`qrCode`/etc. — às vezes diverge do campo mostrado no `example`; **confie no `example`, que reflete o payload real observado**).

---

## Quickstart (curl)

```bash
# 1. Teste de saúde
curl http://localhost:8080/

# 2. Criar instância (usa GLOBAL_API_KEY)
curl -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: SUA_GLOBAL_API_KEY" \
  -d '{"name":"minha-instancia","token":"token-seguro-unico"}'

# 3. Conectar (usa o token retornado no passo 2)
curl -X POST http://localhost:8080/instance/connect \
  -H "Content-Type: application/json" \
  -H "apikey: token-seguro-unico" \
  -d '{"webhookUrl":"https://webhook.site/seu-id","subscribe":["ALL"],"immediate":true}'

# 4. Obter QR Code
curl http://localhost:8080/instance/qr \
  -H "apikey: token-seguro-unico"

# 5. Verificar status
curl http://localhost:8080/instance/status \
  -H "apikey: token-seguro-unico"

# 6. Enviar texto
curl -X POST http://localhost:8080/send/text \
  -H "Content-Type: application/json" \
  -H "apikey: token-seguro-unico" \
  -d '{"number":"5519999999999","text":"Olá!"}'
```

---

## Índice de Endpoints (cheat-sheet — 59 endpoints)

| Método | Path                            | Descrição                                        | Auth   |
| ------ | ------------------------------- | ------------------------------------------------ | ------ |
| GET    | `/instance/all`                 | Listar todas as instâncias                       | Global |
| POST   | `/instance/create`              | Criar instância                                  | Global |
| DELETE | `/instance/delete/{instanceId}` | Deletar instância                                | Global |
| DELETE | `/instance/proxy/{instanceId}`  | Remover proxy                                    | Global |
| POST   | `/instance/connect`             | Conectar instância (QR/pairing)                  | Token  |
| GET    | `/instance/qr`                  | Obter QR Code                                    | Token  |
| POST   | `/instance/pair`                | Solicitar pairing code                           | Token  |
| GET    | `/instance/status`              | Status da conexão                                | Token  |
| POST   | `/instance/disconnect`          | Desconectar                                      | Token  |
| DELETE | `/instance/logout`              | Logout completo                                  | Token  |
| POST   | `/send/text`                    | Enviar texto                                     | Token  |
| POST   | `/send/link`                    | Enviar link com preview                          | Token  |
| POST   | `/send/media`                   | Enviar mídia                                     | Token  |
| POST   | `/send/location`                | Enviar localização                               | Token  |
| POST   | `/send/contact`                 | Enviar contato (vCard)                           | Token  |
| POST   | `/send/poll`                    | Enviar enquete                                   | Token  |
| POST   | `/send/sticker`                 | Enviar figurinha                                 | Token  |
| POST   | `/message/react`                | Reagir a mensagem                                | Token  |
| POST   | `/message/markread`             | Marcar como lida                                 | Token  |
| POST   | `/message/edit`                 | Editar mensagem                                  | Token  |
| POST   | `/message/delete`               | Deletar mensagem p/ todos                        | Token  |
| POST   | `/message/presence`             | Definir presença no chat                         | Token  |
| POST   | `/message/downloadimage`        | Baixar imagem (⚠️ bug conhecido)                 | Token  |
| POST   | `/message/status`               | Status de entrega/leitura                        | Token  |
| POST   | `/chat/archive`                 | Arquivar chat                                    | Token  |
| POST   | `/chat/mute`                    | Silenciar chat                                   | Token  |
| POST   | `/chat/pin`                     | Fixar chat                                       | Token  |
| POST   | `/chat/unpin`                   | Desfixar chat                                    | Token  |
| POST   | `/group/create`                 | Criar grupo                                      | Token  |
| POST   | `/group/info`                   | Info do grupo                                    | Token  |
| POST   | `/group/invitelink`             | Link de convite do grupo                         | Token  |
| POST   | `/group/join`                   | Entrar via link                                  | Token  |
| GET    | `/group/list`                   | Listar todos os grupos                           | Token  |
| GET    | `/group/myall`                  | Meus grupos                                      | Token  |
| POST   | `/group/name`                   | Alterar nome do grupo                            | Token  |
| POST   | `/group/participant`            | Add/remover/promover/rebaixar (⚠️ bug conhecido) | Token  |
| POST   | `/group/photo`                  | Alterar foto do grupo                            | Token  |
| POST   | `/user/check`                   | Verificar número no WhatsApp                     | Token  |
| POST   | `/user/info`                    | Info de usuário                                  | Token  |
| POST   | `/user/avatar`                  | Obter avatar                                     | Token  |
| GET    | `/user/contacts`                | Listar contatos                                  | Token  |
| GET    | `/user/privacy`                 | Config. de privacidade                           | Token  |
| POST   | `/user/profile`                 | Definir foto de perfil                           | Token  |
| POST   | `/user/block`                   | Bloquear contato                                 | Token  |
| GET    | `/user/blocklist`               | Lista de bloqueados                              | Token  |
| POST   | `/user/unblock`                 | Desbloquear contato                              | Token  |
| POST   | `/newsletter/create`            | Criar canal/newsletter                           | Token  |
| POST   | `/newsletter/info`              | Info do canal                                    | Token  |
| POST   | `/newsletter/link`              | Link de convite do canal                         | Token  |
| GET    | `/newsletter/list`              | Listar canais                                    | Token  |
| POST   | `/newsletter/messages`          | Mensagens do canal                               | Token  |
| POST   | `/newsletter/subscribe`         | Inscrever-se em canal                            | Token  |
| POST   | `/label/chat`                   | Adicionar etiqueta a chat                        | Token  |
| POST   | `/label/edit`                   | Criar/editar etiqueta                            | Token  |
| POST   | `/label/message`                | Adicionar etiqueta a mensagem                    | Token  |
| POST   | `/unlabel/chat`                 | Remover etiqueta de chat                         | Token  |
| POST   | `/unlabel/message`              | Remover etiqueta de mensagem                     | Token  |
| POST   | `/community/create`             | Criar comunidade                                 | Token  |
| POST   | `/community/add`                | Vincular grupo à comunidade                      | Token  |
| POST   | `/community/remove`             | Desvincular grupo da comunidade                  | Token  |

> Não há endpoint de **listagem de etiquetas** (`GET /label/list`) documentado no Go — diferente da Evolution API, que tem `GET /label/findLabels`. Também não há endpoints de botões/listas/carrossel interativos, catálogo Business ou templates — esses recursos existem apenas na Evolution API (TypeScript).

---

## 1. Instância (`/instance`)

### `GET /instance/all` _(Global)_

Retorna array de instâncias. Exemplo de item:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "test",
  "token": "f0e1d2c3-b4a5-6789-0abc-def123456789",
  "webhook": "",
  "jid": "",
  "connected": false,
  "os_name": "Evolution GO",
  "alwaysOnline": false,
  "rejectCall": false,
  "readMessages": false,
  "ignoreGroups": false,
  "ignoreStatus": false
}
```

### `POST /instance/create` _(Global)_

**Body (`CreateInstance`):**

```json
{
  "name": "minha-instancia",
  "token": "token-opcional-customizado",
  "proxy": { "address": "", "port": "", "username": "", "password": "" }
}
```

| Campo   | Tipo                                                   | Obrigatório                           |
| ------- | ------------------------------------------------------ | ------------------------------------- |
| `name`  | string                                                 | ✅                                    |
| `token` | string                                                 | — (gerado automaticamente se omitido) |
| `proxy` | `ProxyConfig` (`address`,`port`,`username`,`password`) | —                                     |

### `DELETE /instance/delete/{instanceId}` _(Global)_

Path param `instanceId` (UUID). → `{ "message": "success" }`

### `DELETE /instance/proxy/{instanceId}` _(Global)_

Remove proxy configurado.

### `POST /instance/connect` _(Token)_

**Body (`ConnectInstance`):**

```json
{
  "phone": "5519999999999",
  "immediate": true,
  "subscribe": ["ALL"],
  "webhookUrl": "https://seu-webhook.com/webhook"
}
```

Resposta inclui `eventString` com todos os eventos habilitados por padrão: `MESSAGE,SEND_MESSAGE,READ_RECEIPT,PRESENCE,HISTORY_SYNC,CHAT_PRESENCE,CALL,CONNECTION,LABEL,CONTACT,GROUP,NEWSLETTER,QRCODE`.

### `GET /instance/qr` _(Token)_

```json
{
  "data": { "Qrcode": "data:image/png;base64,...", "Code": "2@AbCd..." },
  "message": "success"
}
```

### `POST /instance/pair` _(Token)_

**Body:** `{ "phone": "5519999999999", "subscribe": ["ALL"] }` → retorna `PairingCode` (8 dígitos).

### `GET /instance/status` _(Token)_

```json
{
  "data": { "Connected": true, "LoggedIn": false, "Name": "" },
  "message": "success"
}
```

### `POST /instance/disconnect` _(Token)_

Sem body obrigatório.

### `DELETE /instance/logout` _(Token)_

Remove sessão — necessário novo QR Code depois.

---

## 2. Envio de mensagens (`/send`)

Todos exigem `number` (DDI+DDD+número, ex: `5519999999999`) no body. Suportam opcionalmente `delay`, `id`, `mentionedJid`, `mentionAll`, `quoted: {messageId, participant}`.

### `POST /send/text`

```json
{
  "number": "5519999999999",
  "text": "Olá, tudo bem?",
  "delay": 1200,
  "mentionAll": false,
  "quoted": {
    "messageId": "BAE5...",
    "participant": "5519999999999@s.whatsapp.net"
  }
}
```

### `POST /send/link`

```json
{
  "number": "5519999999999",
  "text": "Confira: https://exemplo.com",
  "title": "Título",
  "url": "https://exemplo.com",
  "description": "Descrição",
  "imgUrl": "https://exemplo.com/img.jpg"
}
```

> `title`/`description`/`imgUrl` são opcionais — se omitidos, a API tenta extrair metadados Open Graph automaticamente.

### `POST /send/media`

```json
{
  "number": "5519999999999",
  "url": "https://exemplo.com/imagem.jpg",
  "type": "image",
  "caption": "Legenda",
  "filename": "foto.jpg"
}
```

`type`: valor livre (`image`, `video`, `audio`, `document` conforme uso comum — não é enum fechado no schema).

### `POST /send/location`

```json
{
  "number": "5519999999999",
  "latitude": -22.9,
  "longitude": -47.0,
  "name": "Escritório",
  "address": "Rua Exemplo, 123"
}
```

### `POST /send/contact`

```json
{
  "number": "5519999999999",
  "vcard": {
    "fullName": "João Silva",
    "phone": "5519888888888",
    "organization": "Empresa LTDA"
  }
}
```

### `POST /send/poll`

```json
{
  "number": "5519999999999",
  "question": "Qual sua cor favorita?",
  "maxAnswer": 1,
  "options": ["Azul", "Verde", "Vermelho"]
}
```

### `POST /send/sticker`

```json
{ "number": "5519999999999", "sticker": "https://exemplo.com/figurinha.png" }
```

> Conversão automática para WebP.

> ⚠️ **Não existem endpoints de botões (`/send/button`), lista (`/send/list`) ou carrossel no Evolution Go** — confirmado pela ausência na spec OpenAPI e no índice oficial de páginas (`llms.txt`). Esses recursos existem apenas na Evolution API (TypeScript) e — segundo material da comunidade — o WhatsApp já descontinuou botões/listas interativos para contas não-oficiais de qualquer forma.

---

## 3. Gerenciamento de mensagens (`/message`)

### `POST /message/react`

```json
{ "number": "5519999999999", "id": "MESSAGE_ID", "reaction": "🔥" }
```

> Schema real é simples: `{id, number, reaction}` — sem campos `fromMe`/`participant` (diferentes de outras implementações).

### `POST /message/markread`

```json
{ "number": "5519999999999", "id": ["MESSAGE_ID_1", "MESSAGE_ID_2"] }
```

### `POST /message/edit`

```json
{
  "chat": "5519999999999@s.whatsapp.net",
  "messageId": "MESSAGE_ID",
  "message": "Texto editado"
}
```

### `POST /message/delete`

```json
{ "chat": "5519999999999@s.whatsapp.net", "messageId": "MESSAGE_ID" }
```

### `POST /message/presence`

```json
{ "number": "5519999999999", "state": "composing", "isAudio": false }
```

`state`: `composing` | `paused` | `recording` | `available` | `unavailable`.

### `POST /message/downloadimage`

```json
{ "url": "...", "mimetype": "image/jpeg", "mediaKey": [...], "fileSHA256": [...], "fileEncSHA256": [...], "fileLength": 123456, "directPath": "/v/..." }
```

> ⚠️ **Bug conhecido documentado oficialmente**: retorna erro 500 "Failed to download image download failed with status code 429" (rate limit do WhatsApp). Trate com retry/backoff.

### `POST /message/status`

```json
{ "id": "MESSAGE_ID" }
```

> Requer `DATABASE_SAVE_MESSAGES=true` no `.env` para funcionar (persistência habilitada).

---

## 4. Chat (`/chat`)

Todos usam o mesmo schema `ChatBody`: `{ "number": "5519999999999" }` (ou JID de grupo).

| Endpoint             | Ação      |
| -------------------- | --------- |
| `POST /chat/archive` | Arquivar  |
| `POST /chat/mute`    | Silenciar |
| `POST /chat/pin`     | Fixar     |
| `POST /chat/unpin`   | Desfixar  |

> Não há endpoint de "unarchive"/"unmute" documentado separadamente nas 59 páginas oficiais (apenas os 4 acima) — se precisar dessas ações, teste se `/chat/archive` e `/chat/mute` aceitam um parâmetro booleano adicional na prática, ou consulte o Swagger da sua instância.

---

## 5. Grupos (`/group`)

### `POST /group/create`

```json
{
  "groupName": "Nome do Grupo",
  "participants": ["5519999999999", "5519888888888"]
}
```

### `POST /group/info`

```json
{ "groupJid": "120360000000000001@g.us" }
```

Resposta traz objeto completo `whatsmeow` (JID, OwnerJID, Name, Topic, Participants com IsAdmin/IsSuperAdmin, AddressingMode `lid`, etc.)

### `POST /group/invitelink`

```json
{ "groupJid": "120360000000000001@g.us", "reset": false }
```

→ `"https://chat.whatsapp.com/AbCdEfGh..."`

### `POST /group/join`

```json
{ "code": "AbCdEfGhIjKlMnOpQrStUv" }
```

> `code` é apenas o código do convite (sem a URL completa).

### `GET /group/list`

Lista todos os grupos que a instância participa (array de objetos completos, mesmo shape de `/group/info`).

### `GET /group/myall`

Variante de listagem — retorno observado como `null` no exemplo oficial (comportamento a confirmar em produção).

### `POST /group/name`

```json
{ "groupJid": "120360000000000001@g.us", "name": "Novo Nome" }
```

### `POST /group/participant`

```json
{
  "groupJid": "120360000000000001@g.us",
  "action": "add",
  "participants": ["5519999999999"]
}
```

`action`: `add` | `remove` | `promote` | `demote`.

> ⚠️ **Bug conhecido documentado oficialmente**: retorna 400 "participants is required and cannot be empty" mesmo com payload correto — reportar/testar antes de depender em produção.

### `POST /group/photo`

```json
{
  "groupJid": "120360000000000001@g.us",
  "image": "https://exemplo.com/foto.jpg"
}
```

---

## 6. Usuário (`/user`)

### `POST /user/check`

```json
{ "number": ["5519999999999", "5519888888888"] }
```

→ array `Users[]` com `{Query, IsInWhatsapp, JID, RemoteJID, LID, VerifiedName}`.

### `POST /user/info`

Mesmo body de `/user/check` (schema `CheckUser`). Retorna detalhes por JID: `VerifiedName`, `Status`, `PictureID`, `Devices[]`, `LID`.

### `POST /user/avatar`

```json
{ "number": "5519999999999", "preview": true }
```

→ `{ "success": true, "avatar": "base64..." }`

### `GET /user/contacts`

Lista contatos: `[{Jid, Found, FirstName, FullName, PushName, BusinessName}]`.

### `GET /user/privacy`

```json
{
  "GroupAdd": "all",
  "LastSeen": "none",
  "Status": "all",
  "Profile": "all",
  "ReadReceipts": "none",
  "CallAdd": "all",
  "Online": "match_last_seen"
}
```

### `POST /user/profile`

```json
{ "image": "https://exemplo.com/nova-foto.jpg" }
```

> Define a foto de perfil **da própria instância** (não de outro usuário).

### `POST /user/block`

```json
{ "number": "5519999999999" }
```

→ `{ "DHash": "...", "JIDs": [...] }`

### `GET /user/blocklist`

→ mesma estrutura `{DHash, JIDs[]}`.

### `POST /user/unblock`

Mesmo schema de `/user/block`.

---

## 7. Newsletter / Canais (`/newsletter`)

### `POST /newsletter/create`

```json
{ "name": "Nome do Canal", "description": "Descrição" }
```

Resposta traz objeto completo `thread_metadata` (invite code, subscribers_count, verification, picture, settings) e `viewer_metadata` (mute, role).

### `POST /newsletter/info`

```json
{ "jid": { "user": "120360000000000001", "server": "newsletter" } }
```

> `jid` é um objeto `JID` estruturado (`{device, integrator, rawAgent, server, user}`), não uma string simples.

### `POST /newsletter/link`

Mesmo schema de request (`GetNewsletterInvite: {key: string}`) — retorna o invite code do canal.

### `GET /newsletter/list`

Lista todos os canais que a instância administra/segue.

### `POST /newsletter/messages`

```json
{
  "jid": { "user": "...", "server": "newsletter" },
  "count": 20,
  "before_id": 0
}
```

### `POST /newsletter/subscribe`

```json
{ "jid": { "user": "...", "server": "newsletter" } }
```

---

## 8. Etiquetas (`/label`, `/unlabel`)

### `POST /label/chat`

```json
{ "jid": "5519999999999@s.whatsapp.net", "labelId": "1" }
```

### `POST /label/edit`

```json
{ "labelId": "1", "name": "Cliente VIP", "color": 5, "deleted": false }
```

> `color` é um índice inteiro (paleta interna do WhatsApp), não hex.

### `POST /label/message`

```json
{
  "jid": "5519999999999@s.whatsapp.net",
  "labelId": "1",
  "messageId": "MESSAGE_ID"
}
```

### `POST /unlabel/chat`

Mesmo schema de `/label/chat`.

### `POST /unlabel/message`

Mesmo schema de `/label/message` (confirmado pelo padrão simétrico observado em `/unlabel/chat`).

> Não há endpoint para **listar** etiquetas existentes no Go.

---

## 9. Comunidades (`/community`)

### `POST /community/create`

```json
{ "communityName": "Nome da Comunidade" }
```

Retorna objeto de grupo completo com `IsParent: true`, `DefaultMembershipApprovalMode: "request_required"`.

### `POST /community/add`

```json
{
  "communityJid": "120360000000000003@g.us",
  "groupJid": ["120360000000000004@g.us"]
}
```

> **Atenção**: `groupJid` é um **array de grupos existentes** a vincular à comunidade — não é para adicionar uma pessoa física. "Participant" aqui = grupo-membro da comunidade.

### `POST /community/remove`

Mesmo schema de `/community/add` — desvincula os grupos listados.

---

## 10. Sistema de Eventos / Webhooks

### Configuração

O webhook é definido **no momento da conexão** via `POST /instance/connect`, não em um endpoint `/webhook/set` separado como na Evolution API:

```json
{
  "webhookUrl": "https://seu-dominio.com/webhook",
  "subscribe": ["MESSAGE", "SEND_MESSAGE", "CONNECTION", "QRCODE"],
  "immediate": true,
  "phone": "5519999999999"
}
```

| Parâmetro         | Tipo     | Descrição                                                            |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `webhookUrl`      | string   | URL que recebe os eventos via HTTP POST                              |
| `subscribe`       | string[] | Tipos de evento (`"ALL"` para todos) — se vazio, recebe só `MESSAGE` |
| `immediate`       | boolean  | Conecta sem esperar o QR                                             |
| `phone`           | string   | Para pairing code em vez de QR                                       |
| `rabbitmqEnable`  | string   | `"enabled"` para ativar envio via RabbitMQ                           |
| `websocketEnable` | string   | `"enabled"` para WebSocket                                           |
| `natsEnable`      | string   | `"enabled"` para NATS                                                |

**Webhook global** via `.env` (`WEBHOOK_URL`) dispara **em paralelo** ao webhook por instância — ambos rodam simultaneamente quando configurados.

### Payload base (todo evento)

```json
{
  "event": "NomeDoEvento",
  "data": {},
  "instanceId": "uuid-da-instancia",
  "instanceToken": "token-da-instancia"
}
```

### Tabela de tipos de evento (`subscribe[]`)

| Tipo            | Eventos incluídos                                               |
| --------------- | --------------------------------------------------------------- |
| `ALL`           | Todos abaixo                                                    |
| `MESSAGE`       | `Message`                                                       |
| `SEND_MESSAGE`  | `SendMessage`                                                   |
| `READ_RECEIPT`  | `Receipt` (`Read`, `ReadSelf`, `Delivered`)                     |
| `PRESENCE`      | `Presence`                                                      |
| `HISTORY_SYNC`  | `HistorySync`                                                   |
| `CHAT_PRESENCE` | `ChatPresence`, `Archive`                                       |
| `CALL`          | `CallOffer`, `CallRelayLatency`, `CallTerminate`                |
| `CONNECTION`    | `Connected`, `PairSuccess`, `LoggedOut`, `OfflineSyncCompleted` |
| `LABEL`         | `LabelEdit`, `LabelAssociationChat`, `LabelAssociationMessage`  |
| `CONTACT`       | `Contact`, `PushName`                                           |
| `GROUP`         | `GroupInfo`, `JoinedGroup`                                      |
| `NEWSLETTER`    | `NewsletterJoin`, `NewsletterLeave`                             |
| `QRCODE`        | `QRCode`, `QRTimeout`, `QRSuccess`                              |

### Payloads reais por evento (exemplos oficiais)

**`QRCode`:**

```json
{
  "event": "QRCode",
  "data": { "code": "2@...", "qrcode": "data:image/png;base64,..." },
  "instanceId": "...",
  "instanceToken": "..."
}
```

**`PairSuccess`:**

```json
{
  "event": "PairSuccess",
  "data": {
    "BusinessName": "",
    "ID": "5519...:5@s.whatsapp.net",
    "Platform": "android",
    "jid": "...",
    "pushName": "",
    "status": "open"
  }
}
```

**`Message` (texto):**

```json
{
  "event": "Message",
  "data": {
    "Info": {
      "Chat": "557499879409@s.whatsapp.net",
      "Sender": "...",
      "SenderAlt": "...@lid",
      "IsFromMe": false,
      "IsGroup": false,
      "ID": "3EB0...",
      "Type": "text",
      "PushName": "Nome",
      "Timestamp": "2024-10-10T17:17:44-03:00",
      "MediaType": ""
    },
    "Message": { "conversation": "texto da mensagem" },
    "IsEphemeral": false,
    "IsViewOnce": false,
    "IsEdit": false
  }
}
```

**`Message` (mídia — imagem/vídeo/áudio/documento):** mesma estrutura de `Info`, com `Message.imageMessage`/`videoMessage`/`audioMessage`/`documentMessage` (URL, mimetype, mediaKey, etc.) **+** campo `base64` quando `WEBHOOK_FILES=true` (padrão) — ou `mediaUrl` apontando pro MinIO/S3 se configurado.

**`Receipt`:**

```json
{
  "event": "Receipt",
  "state": "Read",
  "data": {
    "Chat": "...",
    "Sender": "...",
    "MessageIDs": ["..."],
    "Timestamp": "..."
  }
}
```

`state`: `Read` | `ReadSelf` | `Delivered`.

**`Connected` / `LoggedOut` / `OfflineSyncCompleted`:**

```json
{ "event": "Connected", "data": { "status": "open", "jid": "...", "pushName": "..." } }
{ "event": "LoggedOut", "data": { "Reason": "logged_out" } }
{ "event": "OfflineSyncCompleted", "data": { "Count": 42 } }
```

**`CallOffer` / `CallRelayLatency` / `CallTerminate`:**

```json
{
  "event": "CallOffer",
  "data": {
    "From": "...",
    "CallCreator": "...",
    "CallID": "...",
    "RemotePlatform": "android",
    "RemoteVersion": "2.24.10.12"
  }
}
```

**`JoinedGroup` / `GroupInfo`:**

```json
{
  "event": "GroupInfo",
  "data": {
    "JID": "...@g.us",
    "Sender": "...",
    "Name": { "Name": "...", "NameSetAt": "...", "NameSetBy": "..." },
    "Join": [],
    "Leave": [],
    "Promote": [],
    "Demote": []
  }
}
```

**`NewsletterJoin`:**

```json
{ "event": "NewsletterJoin", "data": { "id": "...@newsletter", "state": {"type":"ACTIVE"}, "thread_metadata": {...}, "viewer_metadata": {"mute":"OFF","role":"SUBSCRIBER"} } }
```

### Política de retentativa

| Item              | Valor                           |
| ----------------- | ------------------------------- |
| Máx. tentativas   | **5**                           |
| Intervalo         | **30 segundos**                 |
| Resposta esperada | HTTP `2xx` em até 30s           |
| Se falhar todas   | Evento descartado + log de erro |

### Canais alternativos de entrega

| Canal         | Ativação                               | Variáveis `.env`                                                                |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| RabbitMQ/AMQP | `rabbitmqEnable: "enabled"` na conexão | `AMQP_URL`, `AMQP_GLOBAL_ENABLED`, `AMQP_GLOBAL_EVENTS`, `AMQP_SPECIFIC_EVENTS` |
| NATS          | `natsEnable: "enabled"`                | `NATS_URL`, `NATS_GLOBAL_ENABLED`, `NATS_GLOBAL_EVENTS`                         |
| WebSocket     | `websocketEnable: "enabled"`           | —                                                                               |

Múltiplos canais podem rodar simultaneamente (ex.: webhook HTTP + RabbitMQ ao mesmo tempo).

---

## 11. Variáveis de Ambiente

| Variável                                                   | Descrição                                                | Padrão            |
| ---------------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| `SERVER_PORT`                                              | Porta HTTP                                               | `8080`            |
| `CLIENT_NAME`                                              | Identificador do cliente                                 | `evolution`       |
| `GLOBAL_API_KEY`                                           | Chave administrativa                                     | **obrigatório**   |
| `POSTGRES_AUTH_DB`                                         | Connection string do banco de auth                       | —                 |
| `POSTGRES_USERS_DB`                                        | Connection string do banco de usuários                   | —                 |
| `DATABASE_SAVE_MESSAGES`                                   | Persistir mensagens (necessário p/ `/message/status`)    | `false`           |
| `WADEBUG`                                                  | Nível de log do WhatsApp (`DEBUG`,`INFO`,`WARN`,`ERROR`) | `INFO`            |
| `LOGTYPE`                                                  | Formato de log (`console`,`json`)                        | `console`         |
| `CONNECT_ON_STARTUP`                                       | Reconectar instâncias ao subir o serviço                 | `true`            |
| `WEBHOOKFILES` / `WEBHOOK_FILES`                           | Incluir base64 de mídia nos webhooks                     | `true`            |
| `WEBHOOK_URL`                                              | Webhook global (todas as instâncias)                     | —                 |
| `AMQP_URL`                                                 | Conexão RabbitMQ                                         | —                 |
| `AMQP_GLOBAL_ENABLED`                                      | Ativa filas globais                                      | `false`           |
| `AMQP_GLOBAL_EVENTS` / `AMQP_SPECIFIC_EVENTS`              | Eventos por fila (CSV)                                   | —                 |
| `NATS_URL`                                                 | Conexão NATS                                             | —                 |
| `NATS_GLOBAL_ENABLED`                                      | Ativa NATS global                                        | `false`           |
| `NATS_GLOBAL_EVENTS`                                       | Eventos NATS global (CSV)                                | —                 |
| `EVENT_IGNORE_GROUP`                                       | Ignora eventos de grupo                                  | `false`           |
| `EVENT_IGNORE_STATUS`                                      | Ignora eventos de status/stories                         | `false`           |
| `MINIO_ENABLED`                                            | Habilita storage externo                                 | `false`           |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Credenciais MinIO/S3                                     | —                 |
| `MINIO_BUCKET`                                             | Bucket de mídia                                          | `evolution-media` |
| `MINIO_USE_SSL`                                            | SSL na conexão MinIO                                     | `false`           |

```bash
# .env mínimo funcional
SERVER_PORT=8080
CLIENT_NAME=evolution
GLOBAL_API_KEY=sua-chave-segura-aqui
POSTGRES_AUTH_DB=postgresql://postgres:password@postgres:5432/evogo_auth?sslmode=disable
POSTGRES_USERS_DB=postgresql://postgres:password@postgres:5432/evogo_users?sslmode=disable
DATABASE_SAVE_MESSAGES=false
WADEBUG=INFO
LOGTYPE=console
```

---

## 12. Instalação rápida (Docker)

```bash
git clone https://git.evoai.app/Evolution/evolution-go.git
cd evolution-go
cp .env.example .env
# editar .env com GLOBAL_API_KEY seguro
make docker-build
make docker-run
```

Ou via `docker-compose.yml` com a imagem oficial `evoapicloud/evolution-go:latest` + PostgreSQL (ver seção de instalação completa no site oficial). Verificação: `curl http://localhost:8080/` e Swagger em `http://localhost:8080/swagger/index.html`.

---

## 13. Postman — Collection Oficial

A Evolution Foundation mantém uma **collection Postman pública e oficial** para o Evolution Go, mantida por Davidson Gomes (mesmo autor/mantenedor citado na Evolution API):

```
https://www.postman.com/agenciadgcode/evolution-api/collection/u95jxho/evolution-go
```

### Como importar

1. Postman → **Import** → aba **Link** → colar a URL acima → **Continue** → **Import**.
2. Criar um **Environment** chamado "Evolution Go" com as variáveis:

| Variável      | Valor inicial                    |
| ------------- | -------------------------------- |
| `base_url`    | `http://localhost:8080`          |
| `api_key`     | valor do `GLOBAL_API_KEY`        |
| `instance_id` | preencher após criar a instância |

3. (Opcional) Pre-request Script no nível da collection para injetar headers automaticamente:

```javascript
pm.request.headers.add({ key: 'apikey', value: pm.environment.get('api_key') });
pm.request.headers.add({
  key: 'instanceId',
  value: pm.environment.get('instance_id'),
});
pm.request.headers.add({ key: 'Content-Type', value: 'application/json' });
```

> Nota: os exemplos de body mostrados no guia oficial de uso do Postman (`instanceName`/`integration`) **não batem** com o schema OpenAPI real (`name`/`token`) — ver seção de inconsistências no topo deste arquivo. Use `name`/`token` como confiável.

---

## 14. Integração N8N

Pacote **community node** dedicado (diferente do node da Evolution API):

```
n8n-nodes-evolution-go
```

Instalação: **Settings → Community Nodes → Install** → informar `n8n-nodes-evolution-go` → aceitar termos. Buscar por **"Evolution GO"** na barra de nodes.

---

## 15. Recursos que existem na Evolution API mas **NÃO** no Evolution Go

Útil para não assumir paridade de features entre os dois produtos:

| Recurso                                         | Evolution API (TS)           | Evolution Go                                                              |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Botões interativos                              | ✅ (`/message/sendButtons`)  | ❌ não documentado                                                        |
| Listas interativas                              | ✅                           | ❌ não documentado                                                        |
| Carrossel                                       | ❌                           | ❌                                                                        |
| Catálogo Business / Coleções                    | ✅ (`/business/*`)           | ❌                                                                        |
| Templates HSM (Cloud API)                       | ✅ (`/template/*`)           | ❌                                                                        |
| Configurações avançadas via API (`/settings/*`) | ✅                           | Parcial — via `.env`/config da instância no create, não endpoint dedicado |
| Proxy por instância                             | ✅ (`/proxy/set`)            | ✅ (`proxy` no create + `DELETE /instance/proxy/{id}`)                    |
| Listagem de etiquetas                           | ✅ (`GET /label/findLabels`) | ❌                                                                        |
| Comunidades WhatsApp                            | ❌                           | ✅ (`/community/*`) — recurso exclusivo do Go                             |
| Newsletters/Canais                              | ❌                           | ✅ (`/newsletter/*`) — recurso exclusivo do Go                            |
| Multi-canal de eventos (AMQP/NATS/WS nativos)   | Parcial                      | ✅ nativo e configurável por instância                                    |

---

## 16. Troubleshooting rápido

| Sintoma                                                       | Causa provável                                                                        | Ação                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 401 em qualquer request                                       | `apikey` errada ou usando token de instância em rota que exige Global (ou vice-versa) | Confirme qual tipo de chave a rota exige (ver tabela §1/cheat-sheet) |
| `POST /group/participant` retorna 400 mesmo com payload certo | Bug conhecido documentado oficialmente                                                | Testar variações de payload; reportar ao suporte se persistir        |
| `POST /message/downloadimage` retorna 500 (429)               | Bug conhecido — rate limit do WhatsApp                                                | Implementar retry com backoff                                        |
| Webhook não chega                                             | `subscribe` vazio (só recebe `MESSAGE`) ou URL não pública                            | Use `"subscribe":["ALL"]` para depurar; teste com webhook.site       |
| Mídia não vem em base64                                       | `WEBHOOK_FILES=false` ou MinIO configurado                                            | Confira `.env`; se MinIO ativo, use o `mediaUrl` retornado           |
| `/message/status` sempre vazio                                | `DATABASE_SAVE_MESSAGES=false`                                                        | Ative no `.env` e reinicie                                           |
| Instância não reconecta sozinha                               | `CONNECT_ON_STARTUP=false`                                                            | Ative no `.env`                                                      |

---

## 17. Referências externas

- Documentação oficial (fonte deste arquivo): https://docs.evolutionfoundation.com.br/evolution-go
- Índice machine-readable (`llms.txt`): https://docs.evolutionfoundation.com.br/llms.txt
- OpenAPI specs individuais: `https://docs.evolutionfoundation.com.br/api-reference/openapi/Evolution-Go/{user,send-message,newsletter,evo-go-message,evo-go-label,evo-go-instance,evo-go-group,evo-go-chat,community}.yaml`
- Repositório oficial (código + wiki + Swagger): https://github.com/evolution-foundation/evolution-go
- Wiki interna do repo (guias narrativos, não 100% alinhados ao contrato real — ver nota de inconsistência): `docs/wiki/` no repositório
- Swagger interativo da sua instância: `{baseUrl}/swagger/index.html`
- Postman collection oficial: https://www.postman.com/agenciadgcode/evolution-api/collection/u95jxho/evolution-go
- Community node N8N: pacote npm `n8n-nodes-evolution-go`
- Biblioteca WhatsApp subjacente (whatsmeow): https://github.com/tulir/whatsmeow
- Repositório irmão (produto TypeScript): https://github.com/EvolutionAPI/evolution-api

---

## Créditos

Conteúdo compilado a partir da documentação oficial **Evolution Foundation** (OpenAPI 3.0.0, páginas de referência de endpoint + guias narrativos), cross-referenciado com o repositório oficial `evolution-foundation/evolution-go` no GitHub. Organizado para uso como contexto de desenvolvimento com Claude Opus 5 / Sonnet 5.

## Licença

Evolution Go é distribuído sob Apache License 2.0 com condições adicionais de proteção de marca (preservação de logo/copyright e Usage Notification requirement). Ver `LICENSE` e `TRADEMARKS.md` no repositório oficial antes de uso comercial.
