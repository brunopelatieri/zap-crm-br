# SPEC 056 — Continuar a conversa por outro canal (resgate e transferência)

| Campo         | Valor                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | **F1, F2 e F3 concluídas (2026-08-20)** — código e UI prontos. **F4** (i18n ✅ já na F3; docs ✅ este índice) tem o checklist executável pronto em [docs/spec-056-teste-manual.md](./spec-056-teste-manual.md) — só falta VOCÊ rodar os 10 itens contra o número real, obrigatório antes do merge |
| Motivação     | Janela de 24h do WhatsApp Oficial fecha → hoje a única saída é template pago. Com uma instância QRCode pareada, existe uma saída gratuita que o CRM ainda não oferece      |
| Pré-requisito | [SPEC 048](./spec-048-canal-whatsapp-qrcode.md) F0–F4 e [SPEC 049](./spec-049-inbox-multicanal-e-motores.md) F5–F6 **concluídas**. Migrações 055–063 são fatos, não hipóteses |
| Migrações     | **Nenhuma.** Ver §3 — é o achado que mais barateia esta SPEC                                                                                                              |
| Escopo fora   | Unificar as duas threads numa só; transferência em massa; transferência automática por regra; transferir para um segundo número Cloud API                                  |
| Data          | 2026-08-20                                                                                                                                                                |

---

## 1. O que o levantamento no código mudou

O pedido chegou formulado como **duas** funcionalidades: _"enviar uma mensagem como outro canal"_
**e** _"transferir de canal"_. A leitura do código diz que são **uma só**, que ela é
**assimétrica**, e que o mecanismo que parecia pronto para servi-la é justamente o que não
serve. Três achados mudam o desenho antes da primeira linha.

| #   | A formulação natural dizia                                                    | O código (e o WhatsApp) dizem                                                                                     | Impacto                          |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | "Enviar pelo canal B" e "transferir para o canal B" são coisas diferentes     | São a mesma. A resposta do cliente volta **para o número que enviou** — enviar pelo B já transferiu                | 🔴 Um fluxo, não dois            |
| 2   | "E vice-versa" — Cloud→QR e QR→Cloud são simétricos                           | Não são. QR→Cloud esbarra na janela de 24h do oficial, que estará **fechada** justamente no caso que motiva o uso  | 🔴 UI diferente em cada sentido  |
| 3   | `sendAndPersistOutbound({ channel })` é o encanamento pronto para isto        | É o encanamento do **desvio de automação**, e usá-lo aqui produziria o problema do achado 1                       | 🔴 Não usar; ver §4.2            |
| 4   | Falta construir navegação entre threads, criação da thread irmã e a listagem  | As três **já existem** (§1.4). Falta o botão que as liga                                                          | ✅ Escopo menor que o esperado   |

### 1.1 🔴 Enviar pelo outro canal **é** transferir — a rede decide, não a UI

O caso de uso descrito é: contato atendido pelo WhatsApp Oficial, janela de 24h fechada,
operador quer "cutucar" pelo número QRCode em vez de pagar template.

Suponha que a mensagem saia pelo número QRCode e a bolha fique na thread do oficial (que é o
que o desvio de automação faz hoje). O cliente recebe **de outro número**. Ele responde — e a
resposta chega pelo webhook da Evolution, que a ingere com o `channel_id` da instância QRCode.
`ingest.ts` resolve a conversa por `(conta, contato, canal)` — o índice único
`idx_conversations_account_contact_channel` da [059](../supabase/migrations/059_conversation_channel.sql#L75)
— e a resposta cai numa **thread diferente** daquela onde o operador escreveu.

O resultado é a pior forma de falha que este repositório já catalogou duas vezes (SPEC 048
§6.7): nada dá erro. O operador vê a própria mensagem na thread do oficial, sem resposta, e a
resposta do cliente aparece como conversa nova em outro lugar da lista — provavelmente atribuída
a outra pessoa, porque a thread nova não herda a atribuição da antiga.

**Não há como evitar isso pela UI.** O canal de resposta é determinado pelo número que enviou;
é física da rede, não escolha de produto. Então a decisão certa é a única coerente com ela:
**se a mensagem sai pelo canal B, ela nasce na thread do canal B, e o operador vai junto.**

Isso dissolve a dicotomia do pedido. Não existe "enviar sem transferir" — existe apenas
"transferir enviando", e o botão deve dizer isso ao operador antes do clique, não depois.

### 1.2 🔴 A transferência é assimétrica — "e vice-versa" não vale igual

Os dois sentidos parecem espelhados e não são, porque só um dos canais tem janela de sessão
([capabilities.ts:78](../src/lib/channels/capabilities.ts#L78) — `sessionWindow24h: false` no QR):

| Sentido        | É possível?                        | Quando                                                                                        |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Cloud → QR** | **Sempre**                         | O QR não tem janela. É o caso que motiva esta SPEC e o que funciona 100% das vezes             |
| **QR → Cloud** | **Só com a janela do Cloud aberta** | Exige que o contato tenha escrito **para o número oficial** nas últimas 24h                    |

E o segundo caso é perverso: o operador que quer transferir do QR para o oficial normalmente
quer fazê-lo com um contato que **nunca** escreveu para o número oficial — logo a janela nunca
esteve aberta, e o único envio possível é um **template pago**. Oferecer "transferir para o
WhatsApp Oficial" com a mesma cara de "transferir para o QRCode" entregaria um botão que, no
caso mais comum, leva a uma cobrança que o operador não pediu.

**Consequência de projeto:** a ação para um canal com `sessionWindow24h` só aparece habilitada
quando `resolveSessionWindow()` daquela thread-destino diz `isOpen`. Fora disso ela aparece
**explicando**, e o caminho oferecido é o template que o composer já tem — não um envio livre
que vai falhar na Meta.

### 1.3 🔴 O parâmetro `channel` explícito existe, e não é para isto

[`sendAndPersistOutbound`](../src/lib/channels/send.ts#L636) aceita `channel: { type, id }` para
enviar por um canal diferente do da conversa, e a migração
[063](../supabase/migrations/063_message_channel.sql) criou `messages.channel_id` como selo
dessa divergência. É tentador ler isso como "o encanamento já está pronto".

Está pronto para **outra coisa**. O comentário da 063 é explícito sobre o desenho: a bolha fica
na conversa original de propósito, porque _"a automação foi disparada por aquela thread e o log
tem de ser lá"_ e porque _"criar thread automaticamente faria uma conversa nascer sem o cliente
ter escrito"_ (SPEC 049 §6.1 ponto 2). Para um disparo automático de uma linha, isso é
defensável. Para um humano que está **mudando o canal de atendimento**, é exatamente o achado
1.1.

**Portanto: esta SPEC não usa o parâmetro `channel`.** Ela resolve a thread do canal de destino
**antes** de enviar e chama o caminho de envio normal — que, ao resolver o canal pela conversa
([send-message.ts:317](../src/lib/whatsapp/send-message.ts#L317)), já sai pelo número certo
sozinho. O núcleo de envio não muda **em nada**.

Este é o achado que barateia a SPEC inteira: o que parecia exigir um caminho de envio novo
exige apenas **resolver a outra conversa primeiro**.

### 1.4 ✅ Três das quatro peças já existem

| Peça                                     | Onde                                                                                        | Estado                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Criar a thread do contato num canal      | `findOrCreateConversationRow` ([resolve-conversation.ts:204](../src/lib/whatsapp/resolve-conversation.ts#L204)) | ✅ pronta — **falta exportar** (é privada)                   |
| Navegar para a thread irmã               | `handleOpenSiblingConversation` ([inbox/page.tsx:854](<../src/app/(dashboard)/inbox/page.tsx#L854>)) | ✅ pronta — busca, abre, seta `?c=`, limpa `?channel`        |
| Listar as threads irmãs do contato       | "Também neste contato" ([contact-sidebar.tsx:274](../src/components/inbox/contact-sidebar.tsx#L274)) | ✅ pronta — mas só mostra canais que **já têm** thread       |
| **A ação que liga as três**              | —                                                                                           | ❌ é o que esta SPEC constrói                                |

`findOrCreateConversationRow` já trata a corrida do índice único (23505 → re-resolve) e já
recebe `channelId`. Ela nasceu para a API pública resolver conversa **por telefone**; aqui o
inbox já tem `contact_id` em mãos, então o que falta é expor o miolo sem a resolução de
telefone em volta.

### 1.5 Achado colateral: o desvio de automação tem o mesmo problema — e ninguém viu

O raciocínio de 1.1 vale igual para `sendViaFallbackChannel`
([engine.ts:1000](../src/lib/automations/engine.ts#L1000)), que está em produção: a automação
entrega pelo número QRCode, a bolha fica na thread do oficial com o selo da 063, e **a resposta
do cliente cai na thread do QRCode**. O teste manual 12 da SPEC 049 (§7.3) verifica que a bolha
aparece com selo — mas não verifica o que acontece quando o cliente **responde**.

Não é regressão desta SPEC e não é bloqueio dela. Mas é a mesma classe de erro mudo, e o
conserto natural é o mesmo desenho: ver **D-6**.

### 1.6 Envio humano não verifica opt-out

`grep opted_out src/lib/whatsapp/send-message.ts`: **zero ocorrências**. O opt-out é respeitado
na audiência e no disparo em massa ([estimate.ts:148](../src/lib/audience/estimate.ts#L148)),
não no envio individual pelo inbox — e com razão: responder alguém que pediu para sair de
campanhas de marketing não é a mesma coisa que incluí-lo numa campanha.

Só que "resgatar por outro número um contato que está em silêncio" **não é responder** — é
iniciar contato. É o mesmo ato que o opt-out existe para impedir, com a agravante de vir de um
número que o contato nunca viu. Ver **D-4**.

---

## 2. Decisões que precisam da sua aprovação

Seis. As três primeiras definem o produto; as três últimas são contenção.

### D-1 — Onde a mensagem é persistida · **recomendação: na thread do canal de DESTINO**

| Opção                                                             | Consequência                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Thread de origem, com selo (o que o desvio de automação faz hoje) | Conversa partida: pergunta numa thread, resposta em outra (§1.1). Nada avisa                       |
| **Thread de destino** (criada sob demanda), operador navega junto | Pergunta e resposta na mesma thread. O núcleo de envio não muda (§1.3)                             |

A segunda também é a única que sobrevive ao teste "o cliente respondeu": é para onde a resposta
vai de qualquer jeito.

### D-2 — Existe "enviar sem transferir"? · **recomendação: não**

Um modo "só desta vez, sem mudar o canal" seria uma promessa que a rede não cumpre: a resposta
vem pelo número que enviou. Dois botões parecidos, um dos quais mente, é pior que um só que
diz a verdade. **Um fluxo, com o texto dizendo o que vai acontecer:** _"O contato vai receber
de [número], e a conversa continua por lá."_

### D-3 — Sentido QR → Cloud · **recomendação: oferecer só com a janela aberta**

Pelo §1.2. Com a janela fechada, em vez de sumir sem explicação, a ação aparece
**desabilitada com o motivo** e aponta para o template — que é o caminho legítimo, e que o
operador precisa saber que é pago.

Isto é uma exceção deliberada à regra da SPEC 049 §4.3 ("some, não desabilita"): lá o controle
some porque o canal **nunca** o terá; aqui a mesma ação estará disponível daqui a pouco, se o
cliente escrever. Sumir esconderia uma opção que existe.

### D-4 — Opt-out bloqueia? · **recomendação: sim, e é a única exceção**

Pelo §1.6. Contato em `opted_out` não pode ser resgatado por outro canal — a mensagem sequer é
tentada, e o diálogo explica. O envio comum pelo inbox **não muda** (continua sem verificar):
o escopo desta regra é a ação nova, não o composer.

### D-5 — Marcador de sistema na thread de origem? · **recomendação: não na v1**

Uma bolha "conversa continuou em [canal]" exigiria ampliar o CHECK de `messages.content_type`
([010_flows.sql:63](../supabase/migrations/010_flows.sql#L63)), que hoje aceita oito valores, e
todo consumidor que assume esse conjunto — bolha, preview, contagem de não-lidas, webhooks de
saída, API v1, exportação — passaria a receber um tipo que não conhece. É a única mudança que
transformaria uma SPEC sem migração numa SPEC com migração **e** com risco espalhado.

O que já responde "para onde foi": a seção "Também neste contato" (§1.4), que passa a mostrar a
thread de destino com atividade recente. E a auditoria de risco já vem de graça — quando o envio
é frio (que é o caso de uso), `channel_cold_sends` grava a linha com `origin='human'`
(migração [062](../supabase/migrations/062_channel_cold_sends.sql)).

Se você quiser o marcador mesmo assim, ele é uma fase própria, com a migração e a revisão dos
seis consumidores — não um detalhe desta.

### D-6 — Corrigir o desvio de automação junto? · **recomendação: não, mas registrar**

O §1.5 é real e vale conserto, mas mudar onde `sendViaFallbackChannel` persiste é mexer num
caminho de motor em produção, com teste manual próprio, enquanto esta SPEC não toca motor
nenhum. Misturar as duas coisas num PR é o oposto do que a SPEC 049 §10 decidiu ao isolar a
F6.3.

**Registrar como pendência** e decidir depois de esta SPEC estar em produção — momento em que
o desenho "thread de destino" já terá sido validado por um humano antes de ser aplicado a um
motor que roda sozinho.

---

## 3. Modelo de dados

**Nenhuma migração.** É consequência direta do §1.3 e do D-5, e vale escrever por extenso
porque a expectativa natural é a oposta:

| O que se poderia achar necessário             | Por que não é                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Coluna "canal de origem" na conversa          | A thread de destino não precisa saber de onde veio; a origem é derivável pelo contato (§1.4)      |
| Mutar `conversations.channel_id`              | **Proibido por trigger** ([059:84](../supabase/migrations/059_conversation_channel.sql#L84)), e o desenho desta SPEC não precisa: cria-se a thread do destino, não se muda a da origem |
| `messages.channel_id` (selo da 063)           | Fica **NULL**, corretamente: a mensagem sai pelo canal da própria conversa (§1.3)                  |
| Tipo de conteúdo "sistema"                    | D-5                                                                                               |
| Tabela de auditoria de transferência          | `channel_cold_sends` já registra o que importa (`origin='human'`) quando o envio é frio           |

O índice único da 059 é o que permite a thread de destino ser **encontrada ou criada** sem
duplicar, e o `ON DELETE` de 063 já cobre exclusão de instância. A 059 e a 062 fazem esta SPEC
inteira caber em código de aplicação.

---

## 4. O fluxo

### 4.1 O que o operador vê

**Ponto de entrada principal — a faixa de janela expirada.** É onde a dor acontece:
[message-composer.tsx:617](../src/components/inbox/message-composer.tsx#L617) já mostra a faixa
âmbar com o botão de template quando `sessionExpired`. Ao lado dele, uma segunda opção:

```
⚠️  A janela de 24h expirou. Você pode enviar um template (cobrado)
    ou continuar por outro canal.
                                  [ Usar template ]  [ Continuar por outro canal ▾ ]
```

A segunda ação **só aparece** quando existe pelo menos um canal elegível (§4.3). Numa conta que
só tem o oficial — que é toda conta que nunca pareou instância — a faixa fica **idêntica à de
hoje**.

**Ponto de entrada secundário — a ficha do contato.** A seção "Também neste contato"
([contact-sidebar.tsx:274](../src/components/inbox/contact-sidebar.tsx#L274)) hoje lista só os
canais que já têm thread. Passa a listar **todos os canais elegíveis da conta**: os que têm
thread continuam com "abrir"; os que não têm ganham "falar por este canal", que abre o mesmo
diálogo. Mantém-se o gate `accountChannels.count > 1` que a seção já tem.

**O diálogo**, em ambos os casos, mostra três coisas antes de qualquer campo de texto:

1. **Por qual número o contato vai receber** — `channels.name` e o identificador, não o tipo.
   "Vendas (11 98765-4321)" responde a pergunta que o operador tem; "WhatsApp QRCode" não.
2. **Que a conversa continua lá** — a frase do D-2, literal.
3. **O aviso de risco**, quando o destino não tem `sessionWindow24h`: é um número não-oficial,
   iniciando contato com alguém em silêncio. Junto, o consumo de envio frio da instância
   (`GET /api/channels/cold-send-limits`, que a SPEC 049 §6.2 já fez devolver consumo por
   instância).

Depois disso, o campo de texto — e só texto na v1 (§4.4).

### 4.2 O que acontece ao confirmar

```
1. valida elegibilidade do destino (§4.3) — servidor, não só UI
2. opt-out? (D-4) → recusa com motivo, nada é criado nem enviado
3. findOrCreateConversation(conta, contato, canalDestino)   ← thread de destino
4. sendMessageToConversation(conversaDestino, texto, coldSendOrigin:'human')
      ↑ resolve o canal PELA CONVERSA e sai pelo número certo sozinho (§1.3)
5. navega o operador para a thread de destino
```

Quatro exigências sobre esta ordem, cada uma por um motivo:

- **A thread nasce antes do envio, e é isso que dispensa o parâmetro `channel`.** Invertendo a
  ordem, voltaríamos ao desenho de 1.3.
- **Se o passo 4 falhar, a thread do passo 3 permanece** — vazia. É aceitável e preferível à
  alternativa: apagá-la exigiria distinguir "acabei de criar" de "já existia", e apagar a errada
  levaria junto o histórico de uma conversa real. Uma thread vazia é inerte: não aparece na lista
  (sem `last_message_at`) e será reaproveitada na próxima tentativa pelo mesmo índice único.
- **`coldSendOrigin: 'human'`** — conta na cota, não bloqueia (SPEC 049 D-1). Esta ação é o
  vetor de envio frio mais provável do sistema; deixá-la fora da contagem faria a cota parar de
  descrever o número.
- **A navegação reusa `handleOpenSiblingConversation`** (§1.4), que já limpa `?channel` — sem
  isso o operador cairia numa thread que o filtro de canal ativo esconde, e o inbox pareceria
  quebrado.

### 4.3 Quem é elegível como destino

Um canal da conta, diferente do canal da conversa atual, que satisfaça **todas**:

| Critério                              | Por quê                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `status === 'connected'`              | Uma instância caída entregaria `channel_unavailable` depois de já ter criado a thread    |
| `can(type, 'text')`                   | A v1 envia texto (§4.4)                                                                  |
| Janela aberta **se** `sessionWindow24h` | D-3 — no destino, não na origem                                                          |

A verificação vale **no servidor**, não só na montagem do menu: entre abrir o diálogo e
confirmar, a instância pode cair (é o mesmo risco que a SPEC 049 §6.1 registra para o desvio de
automação).

### 4.4 Só texto na v1

Mídia, template e interativo ficam de fora do diálogo — não por limitação de canal (o QR envia
mídia), mas porque a mensagem de resgate é uma frase curta, e cada tipo a mais traz o seu
caminho de upload e as suas capacidades a conferir. Depois de transferido, o operador está na
thread de destino com **o composer inteiro** à disposição, já sensível às capacidades daquele
canal (SPEC 049 §4.3). A segunda mensagem já tem tudo.

---

## 5. Implementação

| Peça                                                       | Arquivo                                        | Natureza                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `findOrCreateConversation(db, accountId, contactId, channelId, ownerUserId)` | `lib/whatsapp/resolve-conversation.ts` | **Exportar** o miolo já existente (L204), sem a resolução por telefone em volta |
| `eligibleTransferChannels(...)`                            | `lib/channels/transfer.ts` (novo)              | Módulo **puro** — recebe canais, tipo do canal atual e janela; devolve elegíveis com motivo de recusa |
| `POST /api/inbox/conversations/transfer`                   | `app/api/inbox/conversations/transfer/route.ts` (novo) | Valida (§4.3 + D-4), cria a thread, envia, devolve `conversation_id` de destino. Devolve `code` legível (`contact_opted_out`, `session_window_closed`, `not_connected`, `same_channel`) para a F3 traduzir — a rota responde em inglês, como todo `/api/**` |
| Ação na faixa de janela expirada                           | `components/inbox/message-composer.tsx`        | Segundo botão ao lado do de template (L617)                                    |
| Canais sem thread na ficha                                 | `components/inbox/contact-sidebar.tsx`         | A seção passa a listar canais elegíveis, não só threads existentes             |
| Diálogo                                                    | `components/inbox/…` (novo)                    | Texto + os três avisos da §4.1                                                 |
| Navegação                                                  | `app/(dashboard)/inbox/page.tsx`               | Reusa `handleOpenSiblingConversation` (L854)                                   |

**O que NÃO se toca:** `lib/channels/send.ts`, `sendMessageToConversation`, `ingest.ts`,
`engine.ts`, adaptadores, e qualquer migração. Um diff que os alcance é sinal de que o desenho
do §1.3 foi abandonado no meio do caminho.

`eligibleTransferChannels` é módulo puro pelo mesmo motivo que `window-fallback.ts` e
`cold-send-limit.ts` são: a decisão "este canal serve de destino, e se não serve, por quê" é
testável sem banco, e é lida em dois lugares (menu e rota) que **não podem discordar**.

### 5.1 🔴 Correção de desenho — existem DUAS `findOrCreateConversation`, e a F2 usa a outra

A tabela acima (escrita antes da implementação) mandava exportar o find-or-create de
`resolve-conversation.ts`. A F2 mostrou que aquela é a variante **errada** para este fluxo. Há
duas implementações no repositório, e a diferença é de semântica:

| | `resolve-conversation.ts` | `/api/whatsapp/send/route.ts` (era privada) |
| --- | --- | --- |
| Cliente | service-role (API pública, sem humano) | do usuário, sob RLS |
| Thread nasce atribuída? | Não | **Sim, a quem iniciou** |
| Colisão no índice único | Re-resolve a vencedora | **409** |

A transferência é um humano no inbox assumindo o atendimento, então precisa das três colunas da
direita. Em particular o **409**: sob a RLS da 039 a thread de outro agente é invisível ao
SELECT, então a colisão quase sempre significa "este contato já está sendo atendido" — e
re-resolver ali devolveria um id que o chamador não consegue ler, virando 500 opaco adiante.

**O que a F2 fez:** extraiu a variante do painel para
[`lib/inbox/find-or-create-conversation.ts`](../src/lib/inbox/find-or-create-conversation.ts)
como `findOrCreateInboxConversation`, sem uma linha de mudança de comportamento, e passou a usá-la
nas duas rotas. Os 8 testes da rota de envio seguem verdes sem edição — é o que prova que a
extração foi literal.

A exportação feita na F1 em `resolve-conversation.ts` **permanece** e continua correta: ela serve
a API pública, que não tem humano nem atribuição de propósito. O que muda é que ela não é a peça
que a transferência consome. Uma terceira cópia deste find-or-create era o desfecho a evitar —
é a mesma proliferação que a SPEC 048 §5 desmontou no caminho de envio.

### 5.2 F3 — o que foi construído

| Peça                                                | Arquivo                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Elegibilidade no cliente (mesma regra pura da F1)   | `src/hooks/use-transfer-channels.ts` (novo)                |
| Diálogo único dos dois pontos de entrada            | `src/components/inbox/transfer-channel-dialog.tsx` (novo)  |
| Botão na faixa de janela expirada                   | `message-composer.tsx` — `onTransferChannel?`, ao lado do de template |
| Canais sem thread na ficha ("falar por este canal") | `contact-sidebar.tsx` — estende a seção "Também neste contato" |
| Navegação até a thread de destino                   | `message-thread.tsx`/`contact-sidebar.tsx` reusam `onOpenConversation` (o mesmo handler de §4.4, já existente em `inbox/page.tsx`) |

Um único componente de diálogo é montado duas vezes — uma em `MessageThread` (sem
`initialChannelId`, para o operador escolher), outra em `ContactSidebar` (com `initialChannelId`,
pulando a escolha). Preferido a levantar o estado do diálogo até `inbox/page.tsx`: os dois pontos
de entrada já tinham cada um sua própria fonte de dados (`conversation` vs. `contact` +
`conversationId`), e coordenar um diálogo compartilhado entre componentes irmãos exigiria mais
plumbing do que duas montagens independentes do mesmo componente puro.

`useTransferChannels` roda a MESMA `evaluateTransferChannels` da F1 no cliente, com uma consulta
a `conversations` (canal → `last_customer_message_at`) por contato — o mesmo padrão de
`fetchSiblingThreads`, mas cobrindo todos os canais da conta, não só os que já têm thread.

**Sem teste automatizado de componente**: o repositório não tem `jsdom`/Testing Library
configurado (só um `.tsx` com `renderToStaticMarkup`, sem interação). A rota (F2) e o módulo puro
(F1) carregam a cobertura automatizada; a UI (F3) depende do teste manual §7.3 — que já era a
exigência da SPEC antes de qualquer decisão de tooling.

### 5.3 🔴 Bug achado no teste manual — loop de render infinito em `useAccountChannels`

O item 1 do checklist (§7.3) travou: o diálogo ficava preso em "Verificando canais
disponíveis…" para sempre, mesmo com um canal QRCode conectado. A causa **não é desta SPEC
sozinha** — é um defeito latente em [`use-account-channels.ts`](../src/lib/channels/use-account-channels.ts)
(F4.5 da SPEC 048) que só se manifestou porque a F3 foi a primeira a consumi-lo dentro de um
`useEffect` que depende do objeto INTEIRO:

```ts
return {
  byId: new Map((channels ?? []).map((c) => [c.id, c])),
  count: channels?.length ?? 0,
  loading: channels === null,
};
```

Sem `useMemo`, esse literal é um objeto **novo a cada render** — Map e tudo. Inofensivo para
quem só lê no corpo do render (a lista, a ficha do contato), mas
[`use-transfer-channels.ts`](../src/hooks/use-transfer-channels.ts) tem `accountChannels`
inteiro na dependência de um `useCallback` chamado de um `useEffect`: objeto novo → `load` novo
→ efeito refaz → `setLoading`/`setEvaluations` → re-render → objeto novo de novo. Loop.

**Correção:** `useAccountChannels()` agora envolve o retorno em `useMemo(() => (...), [channels])`
— a identidade só muda quando o array `channels` muda de verdade (fetch inicial, ou
`refreshAccountChannels()` depois de mexer em canais), nunca por render alheio. Zero mudança de
comportamento para os consumidores existentes (lista, ficha, `contact-detail-view.tsx`) — todos
só melhoram (menos recomputação); o que muda é que a F3 passa a funcionar.

**Lição:** um hook cujo retorno entra em dependência de outro hook precisa devolver identidade
estável — não é regra só de `useMemo`/`useCallback` de quem consome, é contrato de quem produz.

---

## 6. Riscos

| Risco                                                                     | Prob.  | Impacto     | Mitigação                                                                                                     |
| ------------------------------------------------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------------------------------- |
| **Vira ferramenta de prospecção fria em massa pelo número não-oficial**   | **Alta** | **Alto**    | É o risco central. Teto de envio frio conta (`origin='human'`) e o consumo aparece no diálogo; opt-out bloqueia (D-4); aviso de risco não dispensável; uma conversa por vez, sem seleção múltipla (escopo fora) |
| Operador transfere sem entender que o cliente vê outro número            | Média  | Médio       | §4.1 ponto 1 — o número, não o tipo do canal; §4.1 ponto 2 — a frase do D-2                                   |
| Resposta cai em thread que o filtro de canal esconde                     | Média  | Médio       | §4.2 — navegação reusa o handler que limpa `?channel`                                                          |
| Thread órfã vazia após falha de envio                                    | Baixa  | Baixo       | §4.2 — inerte por não ter `last_message_at`; reaproveitada pelo índice único da 059                            |
| Instância cai entre abrir o diálogo e confirmar                          | Média  | Baixo       | §4.3 — validação no servidor; o erro chega antes de qualquer envio                                             |
| QR→Cloud gera cobrança de template não esperada                          | Média  | Médio       | D-3 — a ação nem fica habilitada fora da janela, e o texto diz que template é cobrado                          |
| Ruído em conta de canal único                                            | Alta   | Baixo       | §4.1 — sem canal elegível, a faixa fica idêntica à de hoje; gate `count > 1` na ficha                          |
| Desvio de automação continua partindo a conversa (§1.5)                  | —      | Médio       | D-6 — registrado como pendência, fora do escopo, decidido depois desta SPEC em produção                        |

---

## 7. Plano de teste

### 7.1 Automatizado (co-locado, Vitest)

| Arquivo                                          | Cobre                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/channels/transfer.test.ts`              | §4.3 — canal desconectado recusado com motivo; canal atual nunca é destino de si mesmo; destino com `sessionWindow24h` e janela **fechada** recusado (D-3), aberta aceito; conta sem canal elegível devolve lista vazia |
| `src/lib/whatsapp/resolve-conversation.test.ts`  | Bloco novo: `findOrCreateConversation` **encontra** a thread existente daquele canal e **não** cria segunda; cria quando não existe; corrida 23505 re-resolve. E o já existente por telefone continua idêntico |
| `src/app/api/inbox/…/transfer/route.test.ts`     | D-4 opt-out → recusa **sem criar conversa nem enviar** (as duas asserções, não só a do envio); canal de outra conta → 400; instância caída no momento do POST → erro antes de criar; sucesso devolve o id de destino |

**Um teste que precisa ser escrito ao contrário** (lição da SPEC 048 §6.7): o de opt-out tem de
ser verificado **falhando** contra uma implementação que só bloqueia o envio — se ele passar
nos dois casos, ele não está provando que a conversa não foi criada.

### 7.2 Não-regressão — verdes sem edição

| Arquivo                                     | Protege                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/channels/send.test.ts`             | F4.1 — roteamento por conversa (esta SPEC **não** o toca)     |
| `src/lib/channels/ingest.test.ts`           | Ingestão e idempotência                                       |
| `src/lib/automations/engine.fallback-channel.test.ts` | O desvio de automação segue como está (D-6)         |
| `src/components/inbox/message-composer.test.ts` | A matriz de controles por canal (SPEC 049 §4.3)           |

Precisar editar qualquer um deles é sinal de que o §5 ("o que não se toca") foi violado.

### 7.3 Manual, obrigatório antes do merge

Contra a instância real da SPEC 048 §8.2 e um número de verdade.

1. **O caso que motiva a SPEC:** conversa no oficial com janela **fechada** → transferir para o
   QRCode → o celular recebe **do número QRCode** → o operador termina na thread do QRCode.
2. 🔴 **O cliente responde** → a resposta cai na **mesma thread** onde o operador escreveu.
   É o teste que valida o §1.1 inteiro; sem ele, a SPEC não fecha.
3. Transferir de volta (QR → oficial) com a janela do oficial **fechada** → ação desabilitada,
   com o motivo, apontando para o template (D-3).
4. O mesmo com a janela do oficial **aberta** (peça ao número de teste que escreva para o
   oficial) → transferência funciona.
5. Contato `opted_out` → recusa com motivo; conferir **no banco** que nenhuma conversa nova foi
   criada.
6. Instância QRCode desconectada → a ação não aparece; desconectar **com o diálogo aberto** e
   confirmar → erro claro, sem thread criada.
7. Conta só com o oficial → faixa de janela expirada **idêntica à de hoje**; ficha do contato
   sem a seção.
8. Transferir para um canal onde o contato **já tem** thread → reaproveita a existente, não cria
   segunda (conferir contagem no banco).
9. Contato em silêncio há mais de 24h → linha em `channel_cold_sends` com `origin='human'`, e o
   consumo sobe no diálogo e na aba WhatsApp QRCode.
10. Depois de transferido, enviar mídia e áudio pela thread de destino → composer completo,
    capacidades corretas (§4.4).

---

## 8. i18n e configuração

**Nenhuma variável de ambiente nova.** Os tetos de envio frio já são lidos (PRD 047 §12).

Chaves novas em `messages/en.json` (fonte da verdade) e `messages/pt-BR.json`, no namespace
`inbox`. `npm run i18n:check` falha se divergirem.

Três frases **não** podem ser traduzidas por aproximação, porque descrevem risco ou custo:

- a que diz que o contato vai receber de outro número e que a conversa continua lá (D-2);
- o aviso de número não-oficial + consumo de envio frio (§4.1 ponto 3);
- a explicação do template cobrado no sentido QR→Cloud (D-3).

---

## 9. Ordem de execução e modelo recomendado

| Fase     | Entrega                                                                      | Depende de |
| -------- | ---------------------------------------------------------------------------- | ---------- |
| **F1**   | `eligibleTransferChannels` + exportar `findOrCreateConversation` + testes    | —          |
| **F2**   | Rota `POST …/transfer` (validação, opt-out, criação, envio)                  | F1         |
| **F3**   | Diálogo + ação na faixa de janela expirada + ficha do contato + navegação    | F2         |
| **F4**   | i18n, teste manual §7.3, docs                                                | F3         |

**F2 merece PR próprio.** É o único ponto onde uma conversa nasce e uma mensagem sai por um
número que o contato não reconhece, para alguém que está em silêncio — as duas formas de errar
(criar thread sem enviar, enviar sem dever) são mudas, exatamente o critério que isolou a F6.3
na SPEC 049 §10.

### Modelo recomendado por fase

| Fase                              | Recomendação   | Motivo                                                                                         |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| **F1** — módulo puro + export     | **Sonnet 5**   | Desenho fechado nesta SPEC; lógica pura com testes especificados                               |
| **F2** — rota                     | **Opus 5**     | Ordem de criação × envio, fronteira do opt-out, e a falha parcial do §4.2 — três decisões sutis num corpo só |
| **F3** — UI                       | **Sonnet 5**   | Padrões já estabelecidos (`useAccountChannels`, faixa de janela, `handleOpenSiblingConversation`) |
| **F4** — i18n e docs              | **Sonnet 4.6** | Volume, baixa complexidade                                                                     |

---

## 10. Definição de pronto

1. O teste manual **2** (§7.3) demonstra a conversa **inteira** — pergunta e resposta — na
   mesma thread. É o critério que distingue esta SPEC de um envio por canal alheio.
2. O sentido QR→Cloud se comporta como o D-3 descreve nos dois estados da janela.
3. Contato `opted_out` não gera **nem** conversa **nem** mensagem (verificado no banco).
4. Uma conta de canal único não vê diferença nenhuma no inbox.
5. `git diff` não alcança `lib/channels/send.ts`, `ingest.ts`, `engine.ts` nem
   `supabase/migrations/` (§5).
6. `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — verde, na ordem, antes do push.
