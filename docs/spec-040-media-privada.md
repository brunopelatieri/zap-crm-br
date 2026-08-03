# SPEC 040 — Mídia fora do perímetro de isolamento da 039

> **Status:** Rascunho para revisão. **Nenhuma linha de implementação foi escrita.**
> **Severidade:** 🔴 Crítico — é a maior das pendências deixadas pela entrega da
> [SPEC de abas + atribuição](spec-inbox-tabs-assignment.md).
> **Escopo:** `storage.objects` (buckets `chat-media` e `flow-media`),
> `src/app/api/whatsapp/media/[mediaId]/route.ts`, `src/lib/storage/upload-media.ts`,
> `src/components/inbox/` (composer, bolha, download, lightbox),
> `src/components/settings/template-manager.tsx`, nova migração SQL.
> **Data:** 2026-08-03

---

## 0. Resumo executivo

A migração [039_conversation_assignment.sql](../supabase/migrations/039_conversation_assignment.sql)
trocou o isolamento **por conta** por isolamento **por linha**: um agente passou a
enxergar apenas as conversas atribuídas a ele, mais a fila sem dono. O trabalho foi
feito nas tabelas — `conversations`, `messages`, `message_reactions`, `contact_notes`,
`flow_runs`, `flow_run_events`.

**A mídia ficou de fora.** O próprio cabeçalho da 039 registra isso como dívida
consciente ([039:71-79](../supabase/migrations/039_conversation_assignment.sql#L71-L79)):

> `FORA DE ESCOPO (ticket separado, mas registrado aqui porque relativiza o
> resultado): o bucket chat-media é PÚBLICO (…). Enquanto isso não for corrigido, o
> isolamento de conversas é parcial: o texto fica protegido, os anexos não.`

Esta SPEC é esse ticket. E a auditoria encontrou **um segundo furo, mais grave e não
registrado em lugar nenhum**: a rota que serve a mídia **recebida** do cliente
autentica o chamador mas nunca confere a que conversa aquela mídia pertence.

Os dois furos têm vítimas diferentes e por isso precisam dos dois consertos:

| | Mídia **recebida** do cliente | Mídia **enviada** pelo agente |
| --- | --- | --- |
| Onde vive | Meta CDN, servida por `/api/whatsapp/media/[mediaId]` | bucket `chat-media`, URL pública |
| Quem consegue ler hoje | **qualquer membro autenticado da conta**, de qualquer conversa | **qualquer pessoa na internet** com a URL, sem login |
| O que quebra | o isolamento por agente da 039, dentro da conta | a confidencialidade do inquilino, fora dela |
| Item | **F-40-A** | **F-40-B** |

---

## 1. Análise de contexto

### 1.1 Os dois caminhos de mídia do produto

O ZAP CRM BR nunca teve **um** pipeline de mídia — tem dois, com origens e
armazenamentos distintos, e é por isso que a 039 protegeu um lado e deixou o outro:

**Recebida (inbound).** O webhook não baixa o arquivo. Ele valida o `mediaId` junto à
Meta e grava em `messages.media_url` uma **rota-proxy da própria aplicação**
([webhook/route.ts:893-897](../src/app/api/whatsapp/webhook/route.ts#L893-L897)):

```ts
const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
  try {
    await getMediaUrl({ mediaId, accessToken });
    return `/api/whatsapp/media/${mediaId}`;
  } catch (error) { … }
};
```

O byte só é buscado quando alguém abre a conversa. O comentário em
[media-download.tsx:68-70](../src/components/inbox/media-download.tsx#L68-L70) descreve
corretamente o desenho — `"mesma origem, autenticada"` — e é justamente essa premissa
que a §2 desmonta: a rota é autenticada, mas não é **autorizada**.

**Enviada (outbound).** O composer sobe o arquivo para o bucket `chat-media` e guarda a
URL pública, porque **a Meta precisa buscar o arquivo por URL** no momento do envio
([send-message.ts:377](../src/lib/whatsapp/send-message.ts#L377), `link: mediaUrl!`).
Foi essa exigência que tornou o bucket público na origem — a
[023:57-61](../supabase/migrations/023_chat_media.sql#L57-L61) diz isso com todas as
letras: *"Reads are public (the bucket is public so Meta can fetch links)"*.

Era uma decisão defensável **quando o modelo era plano por conta**. Depois da 039 não é
mais: a 039 promete isolamento e o bucket entrega o contrário.

### 1.2 Quem consome cada coisa

| Consumidor | Caminho | Efeito da correção |
| --- | --- | --- |
| Bolha de mensagem / lightbox | `messages.media_url` | precisa aceitar URL assinada de validade curta |
| Download por blob ([media-download.tsx](../src/components/inbox/media-download.tsx)) | idem | idem |
| Envio à Meta ([send-message.ts:377](../src/lib/whatsapp/send-message.ts#L377)) | `link: mediaUrl` | a Meta baixa **uma vez**, no envio — URL assinada curta basta |
| Header de template ([template-manager.tsx:518](../src/components/settings/template-manager.tsx#L518)) | `uploadAccountMedia('chat-media', …)` → `header_media_url` | **caso especial, ver §4.4** |
| Handle de header ([template-header-handle.ts:36](../src/lib/whatsapp/template-header-handle.ts#L36)) | faz `fetch` da própria URL pública | precisa da URL assinada, servidor-side |
| Flows (bucket `flow-media`, [016](../supabase/migrations/016_flow_media.sql)) | mesmo `uploadAccountMedia` | **mesmo desenho, mesmo furo — ver §5 e §6** |

O helper [upload-media.ts](../src/lib/storage/upload-media.ts) é o ponto único de
upload dos dois buckets (`buildMediaPath` + `uploadAccountMedia` + `deleteAccountMedia`).
Isso é uma sorte: a correção tem **um** lugar para entrar, não seis.

---

## 2. 🔴 F-40-A — Proxy de mídia recebida sem checagem de conversa

**Onde:** [src/app/api/whatsapp/media/[mediaId]/route.ts](../src/app/api/whatsapp/media/[mediaId]/route.ts)

A rota faz, em ordem: (1) exige sessão; (2) resolve o `account_id` do chamador;
(3) carrega o `whatsapp_config` **da conta**; (4) pede o arquivo à Meta com o token da
conta; (5) devolve os bytes.

O que ela **não** faz: verificar que o `mediaId` pedido pertence a uma mensagem de uma
conversa que o chamador pode ver. Não há um único `from('messages')` na rota.

**Cenário de exploração.** Agente B pertence à conta, mas a conversa do cliente
*Fulano* está atribuída ao agente A. Sob a 039, B recebe 0 linhas ao consultar essa
conversa ou suas mensagens — o texto está protegido, como prometido. Mas o `mediaId`
de um anexo é um identificador da Meta que circula em logs, em telas compartilhadas,
em exportações antigas e — decisivamente — **em qualquer histórico anterior à 039, que
B enxergava por completo**. Com ele:

```bash
curl -H "Cookie: <sessão do agente B>" \
     "https://<app>/api/whatsapp/media/<mediaId-de-anexo-do-Fulano>"
# → 200 + os bytes do contrato/RG/comprovante que o cliente mandou para o agente A.
```

Isso é um **bypass direto da 039 dentro da conta**, e não estava documentado em lugar
nenhum — nem na SPEC original (a F-01 listou as tabelas satélite, não as rotas), nem no
cabeçalho da 039. O bucket público (F-40-B) foi registrado; esta não.

**Agravante secundário.** A resposta sai com
`Cache-Control: public, max-age=86400`
([media/[mediaId]/route.ts:78](../src/app/api/whatsapp/media/[mediaId]/route.ts#L78)).
`public` autoriza **cache compartilhado** — CDN, proxy corporativo — a guardar por 24 h
uma resposta que depende de sessão. Numa implantação atrás de CDN, isso vira entrega
cruzada de anexo entre usuários. Tem de ser `private`.

### Mitigação

Amarrar o `mediaId` à conversa **antes** de falar com a Meta.

O `mediaId` não é persistido em coluna própria: o webhook grava
`media_url = '/api/whatsapp/media/<mediaId>'` e `message_id = <id da mensagem na Meta>`
([webhook/route.ts:712-726](../src/app/api/whatsapp/webhook/route.ts#L712-L726)). Duas
formas de fechar, e a SPEC recomenda **fazer as duas**:

1. **Imediata, sem migração** — casar pela própria `media_url`, com o cliente do
   usuário (RLS ligada), de modo que a policy da 039 faça o trabalho:

```ts
// Antes de resolver o whatsapp_config: a mensagem que carrega esta mídia
// tem de ser visível PARA ESTE USUÁRIO. `supabase` aqui é o cliente de
// sessão — a RLS da 039 (`messages_select` → `can_access_conversation`)
// é quem decide, não este código.
const { data: owning } = await supabase
  .from('messages')
  .select('id')
  .eq('media_url', `/api/whatsapp/media/${mediaId}`)
  .limit(1)
  .maybeSingle();

// 404 genérico de propósito: para quem sonda ids, "não existe" e "não é
// sua" têm de ser indistinguíveis — mesma regra que
// `lib/inbox/assignment.ts` já aplica em CONVERSATION_NOT_FOUND.
if (!owning) {
  return NextResponse.json({ error: 'Media not found' }, { status: 404 });
}
```

2. **Estrutural, na migração** — coluna `messages.media_id TEXT` preenchida pelo webhook
   e índice sobre ela, para que o casamento não dependa do formato de uma string de
   rota. A comparação por `media_url` funciona, mas acopla a autorização ao formato da
   URL: no dia em que alguém mudar o prefixo da rota, o `.eq()` para de casar e a rota
   passa a responder **404 para todo mundo** (falha fechada — ruim, mas não insegura).
   Com a coluna, o acoplamento some.

Trocar também o header para `Cache-Control: private, max-age=86400`.

---

## 3. 🔴 F-40-B — Buckets `chat-media` e `flow-media` públicos

**Onde:** [023_chat_media.sql:40-42](../supabase/migrations/023_chat_media.sql#L40-L42)
(`public = TRUE`) e [023:83-86](../supabase/migrations/023_chat_media.sql#L83-L86):

```sql
CREATE POLICY "Chat media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chat-media');
```

Sem `auth.uid()`, sem `profiles`, sem `bucket_id` cruzado com conta: **qualquer
requisição, autenticada ou não, de qualquer origem, lê qualquer objeto do bucket.** As
policies de INSERT/UPDATE/DELETE logo abaixo ([023:88-125](../supabase/migrations/023_chat_media.sql#L88-L125))
são corretamente escopadas por `account-<uuid>` — só a leitura ficou aberta.

**Cenário de exposição.** O caminho é
`chat-media/account-<account_id>/<timestamp>-<basename>.<ext>`
([upload-media.ts, `buildMediaPath`](../src/lib/storage/upload-media.ts)). Não é
adivinhável a esmo — precisa do `account_id` **e** do nome e do milissegundo exatos.
O risco real não é força bruta, é **vazamento de URL**, e a URL vaza com facilidade:

- ela é o valor de `messages.media_url` e viaja para qualquer integração que leia
  mensagens — inclusive `/api/v1` e webhooks de saída ([deliver.ts](../src/lib/webhooks/deliver.ts));
- ela aparece no DOM, em `Referer`, em log de proxy, em print de tela, em relato de bug;
- ela é `header_media_url` de template, que é enviada à Meta e fica registrada lá;
- **e ela nunca expira.** Um contrato subido em janeiro segue legível por link em
  dezembro, mesmo depois de o cliente encerrar o contrato e a conta ser apagada do app.

Some-se a isso o efeito colateral que a 039 criou: o texto da conversa passou a exigir
sessão + atribuição; o anexo daquela mesma conversa não exige nem login. A promessa de
isolamento é lida pelo usuário como valendo para a conversa inteira.

### Mitigação

Bucket privado + **URL assinada de vida curta**, mintada sob demanda por quem tem
permissão. A objeção óbvia — *"mas a Meta precisa buscar a mídia"* — se resolve porque
**a Meta baixa uma única vez, no instante do envio**: ela re-hospeda o arquivo e passa a
servi-lo ao destinatário por conta própria. Uma URL assinada de 10 minutos é folgada
para isso.

```sql
-- Bucket deixa de ser público. Não apaga nada: só muda quem pode ler.
UPDATE storage.buckets SET public = FALSE WHERE id IN ('chat-media', 'flow-media');

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;

-- Leitura passa a exigir ser membro da conta dona da pasta — mesmo
-- predicado que as policies de escrita da 023 já usam (023:88-100).
CREATE POLICY "Members read own account chat media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id IN ('chat-media', 'flow-media')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
```

> **Por que a leitura é por CONTA e não por conversa.** Seria tentador amarrar o objeto
> à conversa via `can_access_conversation`, para espelhar a 039. Não dá: o caminho do
> objeto não carrega `conversation_id` — carrega só `account-<uuid>` — e o mesmo bucket
> serve mídia de template e de flow, que não pertencem a conversa nenhuma. Fechar por
> conta já elimina o furo **externo**, que é o desta seção. O furo **interno** para
> mídia enviada continua existindo e está registrado abaixo como resíduo aceito (§6),
> porque o vetor prático dele (F-40-A) some com a §2.

> ⚠️ **`flow-media` tem objetos legados fora da convenção.** O bucket nasceu na
> [016:19](../supabase/migrations/016_flow_media.sql#L19) com caminho **por usuário**
> (`flow-media/{auth.uid()}/…`); só a [020:66-118](../supabase/migrations/020_account_sharing_followups.sql#L66-L118)
> reescreveu as policies de escrita para `account-<uuid>` — os objetos antigos **não
> foram movidos**. A policy acima casa `(storage.foldername(name))[1]` com
> `account-<uuid>`, então todo objeto de flow anterior à 020 deixaria de ser legível.
> A migração precisa (a) contar esses objetos, e (b) ou movê-los, ou aceitar uma
> segunda cláusula `OR (storage.foldername(name))[1] = auth.uid()::text` para o legado.
> Mesma natureza do resíduo de `media_path` da §4.1 — conferir **antes** da Fase 4.

---

## 4. Modelo de dados e mudanças de aplicação

### 4.1 Migração `supabase/migrations/040_private_media.sql`

Idempotente, no mesmo padrão das demais:

```sql
-- 1. messages.media_id — desacopla a autorização do formato da rota (F-40-A)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_media_id
  ON messages(media_id) WHERE media_id IS NOT NULL;

-- Backfill a partir do que já existe: o prefixo da rota é conhecido e
-- estável desde a 023.
UPDATE messages
   SET media_id = substring(media_url FROM '^/api/whatsapp/media/(.+)$')
 WHERE media_id IS NULL
   AND media_url LIKE '/api/whatsapp/media/%';

-- 2. messages.media_path — o objeto no bucket, para mintar URL assinada
--    sem ter de reverter a URL pública por regex em runtime (F-40-B)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path TEXT;

UPDATE messages
   SET media_path = substring(media_url FROM '/chat-media/(account-[^?]+)')
 WHERE media_path IS NULL
   AND media_url LIKE '%/chat-media/account-%';

-- 3. buckets privados + policy de leitura por conta (§3)
-- 4. mesma coisa para message_templates.header_media_url (§4.4)
```

**Convivência com o legado é obrigatória.** Toda mídia já enviada tem `media_url`
público e nada mais. O backfill acima recupera o `media_path` por regex para o que
seguiu a convenção; o que não casar fica com `media_path` nulo e **continua sendo lido
pela URL antiga — que deixará de funcionar quando o bucket virar privado**. Por isso a
ordem da §5 separa a coluna (deploy 1) do fechamento do bucket (deploy 2), com uma
janela para conferir quantas linhas ficaram sem `media_path`:

```sql
SELECT count(*) FILTER (WHERE media_path IS NULL) AS sem_path,
       count(*)                                   AS total
  FROM messages
 WHERE media_url LIKE '%/chat-media/%';
```

Fechar o bucket com `sem_path > 0` **quebra mídia histórica na tela do usuário**. Se
sobrar resíduo, a alternativa é manter uma policy de leitura pública restrita aos
`name` já existentes na data de corte — feio, mas reversível.

### 4.2 Rota nova de assinatura

`src/app/api/inbox/media/sign/route.ts` — `POST { messageId }`, sessão obrigatória,
cliente de usuário (RLS ligada, então a 039 autoriza sozinha), devolve
`createSignedUrl(path, 600)`. Reusar o mapeamento de erro genérico de
[lib/inbox/assignment.ts](../src/lib/inbox/assignment.ts) (`mapError`): mídia
inacessível responde **404**, nunca 403 — 403 confirmaria que o recurso existe.

### 4.3 Envio à Meta

Em [send-message.ts:377](../src/lib/whatsapp/send-message.ts#L377), `link: mediaUrl!`
passa a receber uma URL assinada gerada no servidor imediatamente antes da chamada.
Como o envio já roda em rota de API, o `createSignedUrl` sai do cliente de service role
ou do cliente de sessão — tanto faz, desde que **não** seja mintada no browser e
persistida: URL assinada **não vai para `messages.media_url`** (expira; o registro
ficaria com um link morto). `messages.media_url` passa a guardar o **path**, e a
assinatura é sempre efêmera.

### 4.4 Header de template — o caso que quase quebra

Templates são o único consumidor que **não** pode usar URL de 10 minutos sem cuidado:
[template-header-handle.ts:36](../src/lib/whatsapp/template-header-handle.ts#L36) baixa
os bytes da própria URL para produzir o *handle* de upload da Meta, e
`message_templates.header_media_url` é persistido e reusado a cada envio
([send-message.ts:495](../src/lib/whatsapp/send-message.ts#L495)).

Como esse fetch é **servidor-side e imediato**, a correção é a mesma — assinar na hora
— desde que `header_media_url` passe a guardar o path e não a URL pública. A SPEC de
implementação deve tratar `message_templates` no mesmo movimento da migração, ou o
envio de template com header de mídia quebra no dia em que o bucket fechar. **Este é o
ponto de regressão mais provável de toda a entrega.**

### 4.5 Cliente

- [media-download.tsx](../src/components/inbox/media-download.tsx) e
  [media-lightbox.tsx](../src/components/inbox/media-lightbox.tsx) passam a pedir a URL
  assinada antes de montar o blob. O fluxo por blob que já existe **ajuda**: ele já lida
  com latência e erro, que é exatamente o que a assinatura introduz.
- [message-composer.tsx](../src/components/inbox/message-composer.tsx) deixa de guardar
  `publicUrl` no rascunho e passa a guardar `path` (o `uploadAccountMedia` já devolve os
  dois — [upload-media.ts, `UploadAccountMediaResult`](../src/lib/storage/upload-media.ts)).
- A pré-visualização local do rascunho continua usando `URL.createObjectURL` do arquivo
  em memória; não precisa de assinatura nenhuma.
- Atenção ao **cache do `<img>`**: URL assinada muda a cada montagem, então a imagem é
  rebaixada a cada render se a assinatura for pedida sem memoização. Guardar por
  `messageId` com TTL menor que o da assinatura.

---

## 5. Plano de deploy

A ordem existe para que **nenhuma janela** deixe mídia quebrada na tela.

| Fase | Conteúdo | Reversível? |
| --- | --- | --- |
| **1 — F-40-A isolado** | Checagem de propriedade na rota de proxy + `Cache-Control: private`. Sem migração, sem tocar em bucket. | sim, trivialmente |
| **2 — colunas** | `040_private_media.sql` **só** com `media_id` / `media_path` + backfills + índice. Bucket **continua público**. Aplicação passa a *escrever* path e a *ler* pelo caminho novo, com fallback para `media_url` legado. | sim |
| **3 — conferência** | Rodar a query de resíduo da §4.1. Só seguir com `sem_path = 0` (ou com a policy de exceção acordada). | — |
| **4 — fechamento** | `UPDATE storage.buckets SET public = FALSE` + troca da policy de SELECT. Templates já migrados para path. | sim (basta reverter o `UPDATE` e a policy) |
| **5 — advisors** | `get_advisors` (security + performance) e bloco novo no [scripts/verify-039-rls.sql](../scripts/verify-039-rls.sql). | — |

A Fase 1 pode e **deve** ir sozinha e antes de tudo: ela fecha o único furo que hoje é
explorável por alguém já logado no produto, e não depende de decisão nenhuma.

---

## 6. Riscos, resíduos aceitos e critérios de aceite

**Riscos**
- **Regressão de template com header de mídia** (§4.4) — maior risco da entrega.
  Testar criação *e* envio de template com header antes da Fase 4.
- **Mídia histórica sem `media_path`** (§4.1) — some da tela se a Fase 3 for pulada.
- **Custo de latência**: cada abertura de mídia ganha um round-trip de assinatura. O
  fluxo por blob já era assíncrono, então o impacto percebido é pequeno; ainda assim,
  memoizar por `messageId`.
- **`flow-media`** entra junto porque compartilha `uploadAccountMedia` e tem a mesma
  policy pública de leitura ([016:87-90](../supabase/migrations/016_flow_media.sql#L87-L90)).
  Deixá-lo de fora seria fechar a porta e esquecer a janela — mas atenção ao legado
  por-usuário descrito na §3.

**Resíduo aceito e registrado** — depois desta SPEC, um membro da conta ainda consegue
ler um objeto de `chat-media` de **outra conversa da mesma conta**, se souber o path
exato (a policy da §3 fecha por conta, não por conversa). Isso é aceito porque: (a) o
path só é obtenível a partir da linha de `messages`, que a 039 já protege; (b) o vetor
prático que existia — o proxy de mídia — é fechado pela §2. Se o produto quiser fechar
também isso, o caminho é gravar `conversation_id` no path do objeto e cruzar com
`can_access_conversation` na policy — e isso **exige reescrever todos os paths
existentes**, o que não se justifica agora.

**Critérios de aceite**
1. `curl` **anônimo** a uma URL de `chat-media` → **400/403**, nunca 200.
2. Agente B, autenticado, pedindo `/api/whatsapp/media/<mediaId>` de anexo de conversa
   atribuída ao agente A → **404** (não 403).
3. Agente A, dono da conversa, abre a mesma mídia → **200**.
4. Envio de imagem/vídeo/documento pelo composer continua chegando ao WhatsApp do
   cliente.
5. Criação **e** envio de template com header de mídia continuam funcionando.
6. Mídia enviada antes da migração continua abrindo no Inbox.
7. Nenhuma resposta de mídia sai com `Cache-Control: public`.

---

## 7. Nota de auditoria — não-issues confirmados

Registrado para que ninguém reinvestigue:

- **Mídia recebida não fica no bucket.** O webhook guarda a rota-proxy, não um objeto de
  storage ([webhook/route.ts:893-897](../src/app/api/whatsapp/webhook/route.ts#L893-L897)).
  O bucket público expõe apenas mídia **enviada pelo agente** e header de template — o
  que não diminui a gravidade, mas delimita o alcance.
- **As policies de escrita da 023 estão corretas** — escopadas por `account-<uuid>`
  ([023:88-125](../supabase/migrations/023_chat_media.sql#L88-L125)). Só a de SELECT
  precisa mudar.
- **`message_actions` não existe como tabela.** A F-01 da SPEC original listou-a como
  satélite a endurecer, provavelmente confundida pelo **nome do arquivo**
  [009_message_actions.sql](../supabase/migrations/009_message_actions.sql) — que na
  verdade cria `message_reactions`, tabela que a 039 já endureceu
  ([039, seção 5](../supabase/migrations/039_conversation_assignment.sql#L340)). Não há
  nada a fazer aqui.
