# SPEC 049 — Inbox multicanal e motores cientes de canal (F5 · F6)

| Campo         | Valor                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | **Rascunho — nada implementado.** Aguardando aprovação das decisões da §2                                                                                                                          |
| PRD           | [PRD 047](./prd-047-canais-e-whatsapp-qrcode.md) — esta SPEC cobre as fases **F5** e **F6**                                                                                                         |
| Pré-requisito | [SPEC 048](./spec-048-canal-whatsapp-qrcode.md) **F0–F4 concluídas e testadas contra número real**. Adaptador Evolution, `lib/channels/` e migrações 055/056/059/060 são **fatos**, não hipóteses   |
| Escopo extra  | As duas peças que o PRD rotulava "falta F4" e são, na prática, de motor: `sendViaFallbackChannel` ([engine.ts:975](../src/lib/automations/engine.ts#L975)) e a tabela `channel_cold_sends` (§6)     |
| Migrações     | **061** (filtro de contatos por canal) · **062** (`channel_cold_sends`) — a última aplicada é a 060                                                                                                 |
| Escopo fora   | Enquete no composer (§1.3), botão Pix, menus via `/polls/{id}/results`, importação de histórico, segundo número Cloud API, i18n/docs finais (**F7**)                                                |
| Data          | 2026-08-14                                                                                                                                                                                         |

---

## 1. O que o levantamento no código mudou

A F0 da SPEC 048 sondou um servidor HTTP porque a documentação da Evolution mentia. Aqui o
"servidor" é o **próprio código depois da F4**, e o método é o mesmo: ler o que roda antes de
decidir o que escrever. O PRD 047 descreveu F5 e F6 em dezembro do planejamento, antes de a
camada de canais existir; **quatro afirmações dele não sobrevivem ao código de hoje**.

| #   | O PRD dizia                                                                                | O código real                                                                                                                                | Impacto                            |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | §10.1: `send_buttons` degrada para texto numerado e "o `collect_input` seguinte casa"      | Não existe `collect_input` seguinte. O nó `send_buttons` **é ele mesmo** quem suspende, e o resume só casa `interactive_reply`                | 🔴 Muda o desenho inteiro da §10.1 |
| 2   | §7.1.1: os quatro consumidores da janela leem `resolveSessionWindow`                       | Três leem. O quarto (`checkWindowGuard`) **descarta `applicable`** e passa `windowApplicable: true` literal — funciona por coincidência       | 🔴 Acoplamento frágil a desfazer   |
| 3   | §9.2: "botão de enquete aparece" no composer do canal QR                                   | `capabilities.poll = true` e `evolution.sendPoll()` existem, mas **nada os alcança**: `OutboundContent` não tem variante `poll`               | 🔴 Reescopo — sai da F5            |
| 4   | §9.3: "filtro **Canal**: mostra contatos com conversa no canal escolhido"                  | O filtro de contatos é um **RPC** (025) por causa do teto de ~1000 do PostgREST. Filtrar por canal no cliente reintroduz o bug que a 025 curou | 🔴 Vira migração 061               |
| 5   | §10: disparo em canal QR precisa de guarda de runtime                                      | Disparo **nunca resolve canal**: `broadcast-core` lê `whatsapp_config` direto. Não há caminho pelo qual um disparo saia por QR                | Guarda vira UI + erro claro        |

Confirmado como previsto: `resolveConversationByPhone` já resolve e filtra por `channel_id`
(a API v1 sai barata, §5.4); `window-scan` já tem o guardrail de canal do PRD §7.1.2
implementado; `conversations.channel_id` é imutável por trigger.

### 1.1 🔴 A degradação de menu em flow é do MATCHER, não do sender

O PRD §10.1 descreve o problema pela metade. O que o código faz hoje:

```
sendButtonsAndSuspend()            flows/engine.ts:363
  → engineSendInteractiveButtons() → grava last_prompt_message_id
  → o run fica suspenso no nó send_buttons

resumeFlowRun()                    flows/engine.ts:970
  if (message.kind === 'interactive_reply' && nó é send_buttons|send_list)
       matched = matchReplyId(nó, reply_id)          ← casa por reply_id
  else if (message.kind === 'text' && nó é collect_input)
       captura em vars
  else → política de fallback (reprompt / handoff / ignore)
```

Degradar só o **envio** para texto numerado produz este roteiro: o cliente recebe
`1️⃣ 2️⃣ 3️⃣`, digita `2`, e a mensagem chega como `kind: 'text'` com o nó atual valendo
`send_buttons`. Nenhum ramo casa. O run cai na política de fallback, **reenvia o mesmo menu**,
e repete até estourar `reprompt_count` e ir para handoff. O operador vê um bot que pergunta a
mesma coisa três vezes e desiste — sem erro em log nenhum, porque do ponto de vista do motor
tudo funcionou.

`matchReplyId` ([engine.ts:71](../src/lib/flows/engine.ts#L71)) casa **exclusivamente**
`reply_id`. O rótulo que o cliente vê nunca é comparado com nada.

**Consequência de projeto:** a degradação é um par — um tradutor na saída e um matcher na
entrada — e o matcher é a metade que o PRD esqueceu. Desenho na §5.2.

### 1.2 🔴 `checkWindowGuard` só funciona por coincidência

[engine.ts:789](../src/lib/automations/engine.ts#L789) chama `resolveSessionWindow` e
desestrutura **apenas** `isOpen`. Vinte e sete linhas abaixo,
[engine.ts:816](../src/lib/automations/engine.ts#L816) passa `windowApplicable: true` como
literal, com um comentário que ainda diz "enquanto só existe canal Cloud".

Hoje o resultado é correto: num canal sem janela, `resolveSessionWindow` devolve
`isOpen: true`, e `resolveWindowRoute` para na regra 2 (janela aberta) antes de a regra 1
(janela inaplicável) importar. As duas rotas levam a `send`.

O problema é que **as duas afirmações deixaram de ser independentes**. `window-fallback.ts`
distingue os dois casos de propósito — a regra 1 existe para dizer "não há restrição a
contornar" e a regra 2 para dizer "há restrição e ela está satisfeita". Enquanto o motor
mentir na primeira, qualquer regra futura que dependa da distinção (por exemplo, contabilizar
"envios fora de janela" para métrica, ou aplicar o teto de envio frio só onde não há janela)
lê o valor errado. É a classe de bug que a SPEC 048 §6.7 já catalogou duas vezes: código
certo lendo dado que nunca foi carregado.

Correção na F6: uma linha — desestruturar `applicable` e repassá-lo. Custo zero, e o teste
que a acompanha é o que impede a regressão silenciosa.

### 1.3 🔴 Enquete no composer não é um botão — são quatro peças

O PRD §9.2 lista "botão de enquete aparece" ao lado de "botão de template desaparece", como se
fossem simétricos. Não são. Esconder o template é UI pura; oferecer enquete atravessa a pilha:

| Peça                                                            | Estado                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `evolution.sendPoll()`                                          | ✅ existe ([evolution.ts:220](../src/lib/channels/adapters/evolution.ts#L220)) |
| `ChannelAdapter.sendPoll?` na interface                         | ✅ existe (`types.ts:307`)                                  |
| `capabilities.poll = true` para QR                              | ✅ existe                                                   |
| `OutboundContent` com variante `poll`                           | ❌ **não existe** ([send.ts:105](../src/lib/channels/send.ts#L105)) |
| `case 'poll'` em `sendContentViaChannel`                        | ❌ não existe                                               |
| `messages.content_type` aceitando `'poll'`                      | ❌ **CHECK de [010_flows.sql:62](../supabase/migrations/010_flows.sql#L62)** permite `text, image, document, audio, video, location, template, interactive` |
| Bolha de enquete no inbox                                       | ❌ não existe                                               |
| Voto (`pollUpdateMessage` ou `GET /polls/{id}/results`)         | ❌ não existe — sem isso a enquete é escrita, não conversa  |

São uma variante de conteúdo, uma migração de CHECK, um componente de bolha e um caminho de
ingestão novo. **Fica fora da F5** (decisão D-3): entregar o botão sem o voto seria entregar
uma pergunta que o CRM não consegue ouvir. O canal QR não perde nada — texto e mídia cobrem
100% do atendimento, e o menu numerado da §5.2 cobre o caso de escolha.

### 1.4 🔴 Filtro de contatos por canal é migração, não `.in()`

[025_filter_contacts_by_tags.sql](../supabase/migrations/025_filter_contacts_by_tags.sql)
existe por um motivo documentado no próprio cabeçalho: resolver o filtro no cliente
(`SELECT contact_id …` → `.in('id', ids)`) estoura o teto de ~1000 linhas do PostgREST **em
silêncio**, derrubando contatos do resultado e quebrando `total_count` e paginação.

Um filtro "contatos com conversa no canal X" tem exatamente a mesma forma: uma consulta em
`conversations` devolvendo ids de contato, alimentando um `.in()`. Numa conta com 3 mil
conversas no canal oficial, o filtro perderia contatos e ninguém notaria — o número de
resultados é plausível.

E a página já mistura dois caminhos: com filtro de etiqueta ativo usa o RPC
([contacts/page.tsx:141](<../src/app/(dashboard)/contacts/page.tsx#L141>)), sem ele usa
`select('*', { count: 'exact' })`. Um filtro de canal precisa valer nos **dois**.

**Decisão:** o canal entra como parâmetro do RPC (migração 061, §3.1), e o caminho sem
etiqueta passa a usar o RPC também quando houver canal selecionado.

### 1.5 Nenhum módulo da F6 conhece canal — e o inbox só pela metade

`grep -rn "channel_id\|channelId\|channel_type"` em `src/lib/api/`, `src/lib/webhooks/`,
`src/lib/broadcasts/`, `src/lib/flows/` e `src/components/contacts/`: **zero ocorrências**.
Em `src/components/inbox/`: cinco, todas da F4.5 (selo na lista, tipo de canal no timer de
24h). É o mapa exato do que falta, e confirma que a F4.5 parou onde disse que pararia.

### 1.6 O composer não perde mensagem — ele erra ao clicar

Depois da F4.1, pedir template numa conversa QR vira `ChannelCapabilityError` → HTTP 400 com
motivo legível. Não há risco de a mensagem sair pelo número errado.

Mas o botão **continua na tela**: [message-composer.tsx:605](../src/components/inbox/message-composer.tsx#L605)
e o menu `+` (linhas 727–767) renderizam Template e Mensagem Interativa sem consultar
capacidade nenhuma. O agente clica, monta o payload, envia, e leva um erro. Isso viola o
princípio 5 do PRD ("degradar com aviso, nunca em silêncio") pelo outro lado: o aviso existe,
mas chega depois do trabalho.

Ponto positivo já resolvido: `sessionInfo.hidden` deixa `sessionExpired = false` numa thread
QR, então o composer **não** fica travado por uma janela que não existe.

### 1.7 A URL do inbox tem dono único

[use-inbox-tabs.ts](../src/hooks/use-inbox-tabs.ts) documenta a regra: o hook **só lê** a URL,
"para não haver duas fontes de verdade disputando o mesmo `router.replace`" — quem escreve é
`inbox/page.tsx`. E a divisão do que vai para a URL é deliberada: `?tab=` e `?viewAs=` vão
(refresh estável, link compartilhável); busca, etiquetas e empresa **ficam em memória**,
porque "a aba vale a pena persistir num link, os filtros de busca não".

O PRD §9.2 manda persistir o canal na URL. Isso é coerente com a regra — "olha a fila do
número de vendas" é exatamente o tipo de link que se manda a um colega —, mas a **escrita**
tem de nascer em `inbox/page.tsx`, junto com as outras, e não no hook. Detalhe pequeno que,
ignorado, produz duas `router.replace` concorrentes e um seletor que volta sozinho.

### 1.8 `flow_runs.last_prompt_message_id` resolve por um id que não é único

[flows/engine.ts:363](../src/lib/flows/engine.ts#L363) e o gêmeo de `send_list` fazem:

```ts
const { data: msg } = await db
  .from('messages')
  .select('id')
  .eq('message_id', whatsapp_message_id)   // sem account, sem conversa
  .maybeSingle();
```

`messages.message_id` **não é único** — a própria SPEC 048 §6.6 registra isso ao corrigir o
recibo de leitura (migração 009). Com um segundo canal em jogo, os ids da Evolution passam a
conviver com os `wamid` da Meta na mesma coluna, e `maybeSingle()` sobre duas linhas devolve
erro (`PGRST116`), não a primeira. O efeito é `last_prompt_message_id = null` — a citação do
prompt some da thread. Não perde mensagem, mas é a mesma armadilha, no mesmo arquivo, e o
conserto é escopar por `conversation_id` e ordenar por `created_at DESC`.

### 1.9 Disparo em massa é Cloud por construção

`broadcast-core.ts` carrega `whatsapp_config` (L137), monta `cloudChannelContext` (L335) e
reaproveita o contexto por milhares de destinatários. Não há seletor de canal em lugar nenhum
do assistente de disparo, e o disparo **não cria conversa** (`grep conversation` em
`broadcast-core.ts` e `broadcast-dispatch.ts`: nada) — a resposta volta pelo webhook e é o
`flagBroadcastReplyIfAny` do `ingest.ts` que a associa.

Ou seja: hoje um disparo **não tem como** sair por QR. A guarda de runtime que o PRD §10 pede
é barata (uma asserção de capacidade antes do fan-out) e serve de backstop; o trabalho real é
de **UI e mensagem**: uma conta que só tem canal QR precisa entender por que o disparo está
indisponível, em vez de encontrar "WhatsApp não configurado".

---

## 2. Decisões que precisam da sua aprovação

Quatro. As duas primeiras mudam comportamento observável; as duas últimas mudam escopo.

### D-1 — Onde o teto de envio frio bloqueia · **recomendação: contar sempre, bloquear só motor**

O PRD §10.3 fala em `automation_logs` e em `skip`, vocabulário de motor. Mas o risco de
banimento não distingue quem digitou: um agente humano prospectando pelo inbox, num número
não-oficial, é o mesmo padrão que derruba a conta.

| Caminho                                   | Conta na cota? | Bloqueia? | Por quê                                                                                                |
| ----------------------------------------- | -------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| Automação / flow / IA em canal sem janela | ✅             | ✅ `skip` | É a metralhadora que a §10.3 existe para frear                                                         |
| Inbox humano em canal sem janela          | ✅             | ❌        | Travar um agente no meio do atendimento é pior que o risco marginal de um envio manual                 |
| Qualquer envio em canal Cloud             | ❌             | ❌        | A Meta já tem tier e janela; contar duas vezes confundiria a leitura da cota                           |

Contar o envio humano é o que faz a cota **descrever o número**, não o motor. Se um agente
gastou 40 envios frios hoje, a automação que roda à noite precisa saber disso. Em vez de
bloquear a pessoa, o composer mostra um aviso quando a instância está perto do teto.

Alternativa se você discordar: bloquear humano também. É defensável, e o único ponto a mudar
é um `if` em `/api/whatsapp/send`.

### D-2 — Como o flow sabe que degradou · **recomendação: derivar no resume, sem coluna nova**

Para casar `"2"` com o segundo botão, o matcher precisa saber que aquele prompt saiu
degradado. Duas formas:

| Opção                                                         | Custo                    | Problema                                                                                                                            |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Gravar `degraded_options` em `flow_runs`                      | Migração + escrita/envio | Estado duplicado que pode divergir do nó; um flow editado no meio da execução passa a mentir                                        |
| **Derivar do canal da conversa na hora do resume**            | **Zero migração**        | Uma consulta a mais no resume — e ela já acontece (`resolveChannelForConversation` está no caminho de envio do mesmo run)           |

Derivar é mais barato **e** mais correto: a pergunta "este canal renderiza botão?" tem uma
resposta só, na matriz de capacidades, e ela é a mesma que decidiu a degradação no envio. Não
há como as duas divergirem porque são a mesma leitura.

### D-3 — Enquete no composer · **recomendação: fora da F5**

Justificada em §1.3. Vira candidata da F8, junto com `GET /polls/{id}/results` (que a SPEC 048
§1.1-bis já identificou como o caminho barato para menus interativos de verdade).

### D-4 — Assinatura do `filter_contacts_by_tags` · **recomendação: substituir, não sobrecarregar**

`CREATE OR REPLACE FUNCTION` com um parâmetro a mais **não substitui**: cria uma sobrecarga.
Com as duas versões vivas, uma chamada de 4 argumentos fica ambígua e o PostgREST escolhe uma
delas por critério que não controlamos. A 061 faz `DROP FUNCTION` da assinatura de 4
argumentos **explicitamente**, recria com 5, e reaplica `REVOKE`/`GRANT` — que não são
herdados pela nova assinatura. A asserção da migração confere isso (§3.1).

---

## 3. Modelo de dados

Duas migrações. A numeração começa em **061** — a última aplicada é a 060 (SPEC 048 §6.6).

> ⚠️ Existem três projetos Supabase (`vn`, `rs`, `jh`). **Confirmar com o mantenedor antes de
> aplicar em qualquer um.**

### 3.1 Migração 061 — filtro de contatos por canal (F5)

```sql
-- 1) Índice que serve o filtro. A 059 já criou
--    idx_conversations_channel (channel_id, last_message_at DESC), que
--    não cobre a projeção por contato. Este é o índice do filtro.
CREATE INDEX IF NOT EXISTS idx_conversations_channel_contact
  ON conversations (account_id, channel_id, contact_id);

-- 2) D-4: derrubar a assinatura antiga ANTES de criar a nova. Sem isto
--    ficam duas funções homônimas e a resolução de sobrecarga passa a
--    ser sorte.
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids     UUID[],
  p_search      TEXT DEFAULT NULL,
  p_limit       INT  DEFAULT 25,
  p_offset      INT  DEFAULT 0,
  -- NULL ou vazio = sem filtro de canal (comportamento da 025, byte a byte).
  p_channel_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$ … $$;

REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[]) TO authenticated;
```

Três exigências sobre o corpo, todas por motivo:

1. **`p_tag_ids` vazio deixa de ser proibido.** Hoje a função só é chamada com etiquetas
   selecionadas. Com filtro de canal sozinho, ela precisa aceitar `p_tag_ids = '{}'` e não
   filtrar por etiqueta — senão o caminho "só canal" volta para o `.in()` da §1.4.
2. **O filtro de canal é `EXISTS`, não `JOIN`.** Um contato com cinco conversas no mesmo canal
   apareceria cinco vezes num join, e o `DISTINCT` que a 025 já faz resolveria a duplicata mas
   não o custo. `EXISTS (SELECT 1 FROM conversations …)` para no primeiro acerto.
3. **`SECURITY INVOKER` permanece.** É o que faz a RLS de `contacts` e `conversations` valer.
   Trocar para `DEFINER` aqui vazaria contatos entre contas.

**Asserção de não-regressão** — o padrão de
[041_assert_039_intact.sql](../supabase/migrations/041_assert_039_intact.sql):

```sql
DO $$
DECLARE v_count int;
BEGIN
  -- D-4: exatamente UMA função com este nome.
  SELECT count(*) INTO v_count FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='filter_contacts_by_tags';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '061: % versoes de filter_contacts_by_tags — a sobrecarga antiga sobreviveu ao DROP.', v_count;
  END IF;

  -- O GRANT nao e herdado pela nova assinatura; sem ele a pagina de
  -- contatos 403 para todo mundo, e so em producao.
  IF NOT has_function_privilege('authenticated',
       'public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID[])', 'EXECUTE') THEN
    RAISE EXCEPTION '061: authenticated perdeu EXECUTE em filter_contacts_by_tags.';
  END IF;

  -- A 059 e a 060 continuam de pe.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='conversations'
                   AND indexname='idx_conversations_account_contact_channel') THEN
    RAISE EXCEPTION '061: dedupe de conversas por canal (059) desapareceu.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='conversations' AND column_name='last_customer_message_at') THEN
    RAISE EXCEPTION '061: coluna da SPEC 045 desapareceu.';
  END IF;
END $$;
```

### 3.2 Migração 062 — `channel_cold_sends` (F6)

Tabela do PRD §10.3, com três acréscimos que o levantamento justificou:

```sql
CREATE TABLE IF NOT EXISTS channel_cold_sends (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- D-1: de onde saiu. Sem isto a aba mostra um número que ninguem
  -- sabe explicar ("60 envios frios" — de automação? do agente?).
  origin     TEXT NOT NULL DEFAULT 'engine'
             CHECK (origin IN ('engine','human','api')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- O índice das TRÊS consultas do teto (24h, 1h, último envio): todas
-- filtram por canal e ordenam/limitam por tempo decrescente.
CREATE INDEX IF NOT EXISTS idx_cold_sends_channel_time
  ON channel_cold_sends (channel_id, sent_at DESC);

ALTER TABLE channel_cold_sends ENABLE ROW LEVEL SECURITY;

-- Leitura para membros da conta (a aba WhatsApp QRCode mostra consumo).
-- ESCRITA: nenhuma policy. Só o service_role grava — a linha é prova de
-- entrega, e um cliente que pudesse inserir/apagar poderia zerar o
-- proprio freio antispam.
CREATE POLICY channel_cold_sends_select ON channel_cold_sends
  FOR SELECT USING (is_account_member(account_id));
```

**Expurgo em 30 dias**, como `automation_window_claims`. A janela mais longa que o cálculo lê
é de 24 h; 30 dias existem para diagnóstico ("por que a automação de terça pulou?"), não para
o cálculo. Vai em `supabase/setup/cron-jobs.sql`, **não** na migração — é agendamento do
deployment (a regra do `AGENTS.md`).

Asserção da 062:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename='channels') THEN
    RAISE EXCEPTION '062: tabela channels ausente — rode a 055 primeiro.';
  END IF;
  -- Escrita pelo cliente e a falha que esta tabela nao pode ter.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='channel_cold_sends'
               AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '062: channel_cold_sends nao pode ter policy de escrita.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='channel_cold_sends' AND relrowsecurity) THEN
    RAISE EXCEPTION '062: RLS desligada em channel_cold_sends.';
  END IF;
END $$;
```

**Por que não contar direto em `messages`** — o PRD já respondeu, e vale repetir porque é a
pergunta que todo revisor faz: "era frio no momento do envio" **não é reconstituível**. Basta
o contato responder cinco minutos depois para a mesma linha de `messages` passar a parecer uma
resposta em conversa viva. A tabela append-only grava o julgamento, não os dados que o
produziram.

---

## 4. F5 — Inbox multicanal

Regra que atravessa a fase inteira: **nada aparece numa conta de um canal só.** O seletor, o
selo e a seção "também neste contato" são ruído puro para quem só usa o oficial — que é toda
conta hoje. `useAccountChannels().count > 1` é a condição, e ela já é o gate do selo da F4.5
([conversation-list.tsx:580](../src/components/inbox/conversation-list.tsx#L580)).

### 4.1 Seletor de canal, na URL

`?channel=<uuid>` ou `?channel=all` (ausente = `all`). Renderiza ao lado dos filtros
existentes, com o rótulo do canal e o mesmo ícone do selo.

Três exigências vindas da §1.7:

- **A escrita fica em `inbox/page.tsx`**, no mesmo padrão dos `router.replace` que já existem
  lá (`{ scroll: false }`, preservando os outros parâmetros). `use-inbox-tabs.ts` continua
  só lendo.
- **O filtro entra na query, não no cliente.** `use-conversation-feed.ts` já monta a consulta
  com predicado; o canal vira `.eq('channel_id', id)`, coberto por
  `idx_conversations_channel` (059). Filtrar em memória quebraria a paginação do feed, do
  mesmo jeito que quebra a de contatos (§1.4).
- **Canal inválido na URL degrada para `all`**, sem erro. Um link antigo apontando para uma
  instância excluída não pode deixar o inbox vazio e mudo.

Interação com as abas: o canal é **ortogonal** à aba (Chat/Open/Quadro). Combinar `?tab=chat`
com `?channel=<qr>` é "minhas conversas do número de vendas", e é o caso que motiva o filtro.

### 4.2 Selo de canal na lista e na thread

A lista **já tem** (F4.5). Falta o cabeçalho da thread, pelo mesmo motivo: o agente que abriu
uma conversa por link direto (`?c=`) não passou pela lista e não viu selo nenhum.

Fonte: `useAccountChannels()` cruzado em memória — **não** um embed em `CONVERSATION_SELECT`.
O raciocínio está escrito em [use-account-channels.ts](../src/lib/channels/use-account-channels.ts)
e não muda: um `PGRST200` de relacionamento novo derrubaria a lista inteira do inbox.

O selo mostra o **rótulo do canal** (`channels.name`), não o tipo. "Vendas" e "Suporte" são
duas instâncias QR, e dizer "WhatsApp QRCode" nas duas não responde a pergunta que o agente
tem, que é *por qual número*.

### 4.3 Composer sensível a capacidade

O composer recebe `channelType` e consulta a matriz. Nada de `if (type === 'whatsapp_qr')`
espalhado — a matriz é a fonte, princípio 2 do PRD.

| Controle                        | Regra                                       | Comportamento em QR       |
| ------------------------------- | ------------------------------------------- | ------------------------- |
| Enviar texto                    | `can(type,'text')`                          | mantém                    |
| Anexos (imagem/vídeo/doc)       | `canSendMedia(type, kind)`                  | mantém                    |
| Gravar áudio                    | `canSendMedia(type,'audio')`                | mantém (⚠️ ver abaixo)    |
| **Template**                    | `can(type,'templates')`                     | **some**                  |
| **Mensagem interativa** (menu `+`) | `can(type,'interactiveButtons')`         | **some**                  |
| Resposta rápida **interativa**  | idem                                        | some do picker            |
| Resposta rápida de texto        | `can(type,'text')`                          | mantém                    |
| Reação                          | `can(type,'reactions')`                     | mantém nos dois           |
| Faixa de janela 24h             | `resolveSessionWindow().applicable`         | já resolvido (F4.5)       |

**Some, não desabilita.** Um botão cinza convida a perguntar por quê; um botão ausente com o
selo do canal ao lado já responde. A exceção é o picker de respostas rápidas, onde o item
interativo é filtrado da lista mas o **contador** ("3 de 5 disponíveis neste canal") aparece —
ali o agente sabe que o snippet existe e precisaria entender por que sumiu.

⚠️ **`capabilities.ptt` é `false` no QR** e o botão de gravar áudio continua aparecendo, porque
`media.audio` é `true`: o áudio sai como arquivo, não como "gravado agora". A SPEC 048 deixou
isso explicitamente por verificar. **Requisito da F5:** um teste manual decide, e se sair como
arquivo o composer exibe a nota "neste canal o áudio chega como anexo, não como mensagem de
voz" — degradar com aviso, não em silêncio.

### 4.4 "Também neste contato: [outro canal]"

Na ficha lateral ([contact-sidebar.tsx](../src/components/inbox/contact-sidebar.tsx), que hoje
não sabe nada de conversas), uma seção com as **outras** threads do mesmo contato:

```
Também neste contato
  🟢 Vendas (QRCode) · 12 mensagens · última há 2 dias      [abrir]
```

Decisões de implementação:

- **Consulta por contato, não por canal**: `conversations` onde `contact_id = X` e
  `id <> atual`. Coberto pelo índice `(account_id, contact_id, channel_id)` da 059.
- **A contagem de mensagens é `count: 'exact', head: true` por irmã.** Parece caro e não é: o
  número de threads irmãs é limitado pelo número de canais da conta (tipicamente ≤ 4, teto
  duro de `EVOLUTION_MAX_INSTANCES_PER_ACCOUNT`). Se você preferir zero consultas extras, a
  alternativa é mostrar só o `last_message_at` — o PRD pede a contagem, e ela é o que dá noção
  de "onde a conversa de verdade acontece".
- **Só aparece se houver irmã.** Sem thread em outro canal, a seção não existe (nem vazia).
- **O link abre a outra thread**, trocando `?c=` — e, se o seletor de canal estiver filtrando
  outro canal, o clique também limpa `?channel` para `all`. Sem isso o link levaria a uma
  conversa que a lista não mostra, e o inbox pareceria quebrado.

Isto é **todo** o "compartilhamento entre canais" que o modelo precisa (princípio 4): não há
merge, não há sincronização, não há tabela de unificação. Tags, funil, notas e campos
personalizados já são do contato, não da conversa.

### 4.5 Filtro de contatos por canal

Chip "Canal" ao lado do filtro de etiquetas, alimentado por `useAccountChannels()`.
Server-side via o RPC da 061 (§1.4, §3.1). O caminho sem etiqueta passa a chamar o RPC quando
houver canal selecionado, com `p_tag_ids = '{}'`.

Semântica escrita na tela, porque não é óbvia: **"contatos que têm conversa neste canal"** —
não "contatos deste canal". Contato é identidade e não pertence a canal nenhum (princípio 1).

Coluna/chip de canais na listagem: **fora da F5**. Exigiria uma agregação por linha na
listagem paginada, e o valor (ver de relance quem fala por onde) não paga o custo enquanto o
filtro entrega a mesma resposta sob demanda.

### 4.6 Escolher canal ao abrir conversa nova

PRD §9.3: com mais de um canal ativo, iniciar conversa com um contato sem thread pergunta por
qual canal. Com um canal só, vai direto — que é o comportamento de hoje.

Os pontos que abrem conversa fora do `ingest.ts` já resolvem o canal padrão via
`resolveDefaultChannelId` ([send.ts:303](../src/lib/channels/send.ts#L303)). O seletor apenas
passa a informar um `channelId` explícito onde hoje o padrão é implícito.

⚠️ **Não existe "mover conversa de canal".** `conversations.channel_id` é imutável por trigger
(059) e a UI nunca deve sugerir o contrário. Falar com o mesmo contato por outro canal **abre
outra thread** — que é exatamente o que a seção 4.4 mostra.

### 4.7 O que a F5 não faz

- Enquete no composer (D-3).
- Coluna de canais na listagem de contatos (§4.5).
- Filtro por canal no dashboard (PRD §10) — fica com a F7/F8, junto com a rotulagem das
  métricas exclusivas do oficial.
- Qualquer mudança em `CONVERSATION_SELECT`.

---

## 5. F6 — Motores cientes de canal

O caminho de saída já roteia por canal desde a F4.1 (`resolveChannelForConversation`), e os
guards de capacidade de `sendContentViaChannel` já recusam com motivo. **A F6 não é sobre
fazer a mensagem sair pelo canal certo — isso está feito.** É sobre o que acontece *antes* do
envio: o que o editor deixa configurar, o que o motor decide, e o que o flow faz com uma
resposta que chegou noutro formato.

### 5.1 Automações

**5.1.1 `send_message` já roteia.** `sendAndPersistOutbound` resolve o canal da conversa
([send.ts:651](../src/lib/channels/send.ts#L651)). Nada a fazer no envio.

**5.1.2 Steps inválidos em QR avisam no editor.** `send_template`, `send_buttons` e
`send_list` numa conta cujos canais não têm a capacidade **nunca** vão funcionar. A validação
segue o padrão do `validate.ts`, que já barra `fallback_channel` em step interativo:

> Este passo envia um template, que só existe no WhatsApp Oficial. Se a automação disparar
> numa conversa de um canal QRCode, o passo falha com o motivo registrado.

Duas sutilezas que decidem se o aviso ajuda ou irrita:

- **É aviso, não bloqueio, quando a conta tem os dois canais.** A automação pode disparar numa
  conversa Cloud, onde o template é legítimo. Bloquear a ativação impediria um uso correto.
- **É erro de validação quando a conta **só** tem canais sem a capacidade.** Aí não existe
  conversa possível em que o passo funcione, e deixar ativar é a armadilha "não dispara, sem
  erro" do `AGENTS.md`.

**5.1.3 Gatilho `session_window_expiring` (PRD §7.1.5).** Não existe aviso nenhum hoje —
[automation-builder.tsx:1142](../src/components/automations/automation-builder.tsx#L1142)
renderiza só a configuração de margem. Numa conta sem canal com `sessionWindow24h`, esse
gatilho **nunca dispara**. O aviso do PRD entra ao lado da margem.

**5.1.4 `checkWindowGuard` passa `applicable` de verdade** (§1.2). Uma linha, um teste.

**5.1.5 Runtime registra o motivo.** Um passo recusado por capacidade vira
`ChannelCapabilityError`, e o motor já embrulha erro de passo em `automation_logs`. Requisito:
a mensagem que chega ao log é a do erro de capacidade (`channel type "whatsapp_qr" does not
support message templates`), **não** uma genérica — é ela que diz ao operador o que corrigir.

### 5.2 Flows — a degradação completa (PRD §10.1 corrigido)

O par que a §1.1 descreveu. **Saída:**

`sendButtonsAndSuspend` / `sendListAndSuspend` consultam a capacidade do canal da conversa.
Sem `interactiveButtons`, em vez de `engineSendInteractiveButtons`, montam texto:

```
Como posso ajudar?

1️⃣ Falar com vendas
2️⃣ Segunda via de boleto
3️⃣ Outro assunto
```

Ordem e numeração vêm da ordem de `cfg.buttons` (ou das linhas das seções, achatadas na ordem
em que aparecem). `header_text` e `footer_text` entram como primeira e última linha. O nó
continua suspenso do mesmo jeito — **o estado do run não muda**, só o transporte.

**Entrada** — o que faltava:

```
resumeFlowRun(), nó atual = send_buttons | send_list, mensagem = texto
  → o canal desta conversa renderiza botão?
      sim  → comportamento de hoje (só interactive_reply casa)
      não  → matchDegradedReply(nó, texto)
```

`matchDegradedReply` — módulo puro, ao lado de `matchReplyId`, testado sem banco:

| Ordem | Casa com                                      | Exemplo                     |
| ----- | --------------------------------------------- | --------------------------- |
| 1     | Índice: `1`, `2` … (1-based, na ordem exibida) | `"2"`                       |
| 2     | Emoji de teclado numérico                     | `"2️⃣"`                      |
| 3     | Rótulo exato, sem caixa e sem acento          | `"segunda via de boleto"`   |
| 4     | Rótulo por prefixo, se **inequívoco**         | `"segunda"` → item 2        |
| 5     | Nada casou                                    | política de fallback atual  |

A regra 4 é a única com risco, e por isso carrega o "inequívoco": prefixo que case com dois
itens **não** casa com nenhum. Um menu com "Vendas" e "Vendas corporativas" não pode mandar o
cliente para o lugar errado só porque ele digitou "vendas" — nesse caso o reprompt é a
resposta certa, e ele desempata digitando o número.

**A degradação nunca inventa opção.** Se `matchDegradedReply` não casa, cai na mesma política
de fallback de sempre (`reprompt` / `handoff` / `ignore`). O reprompt reenvia o menu **já
degradado**, porque passa pelo mesmo `sendButtonsAndSuspend`.

**Correção de vizinhança (§1.8):** enquanto o arquivo estiver aberto, escopar a busca de
`last_prompt_message_id` por `conversation_id` com `order('created_at', desc).limit(1)`.
`message_id` não é único e a coexistência de dois canais aumenta a colisão.

**`collect_input` não muda.** Ele já casa texto e continua casando. O que o PRD §10.1 descrevia
como "o `collect_input` seguinte casa número ou rótulo" só faz sentido num flow autorado
assim — e nesse desenho ele já funciona hoje, sem código novo.

### 5.3 Disparos em massa

Dado o §1.9, o trabalho é de contenção, em três camadas:

1. **Assistente de disparo:** se a conta não tem canal com `capabilities.broadcast` **e**
   `status='connected'`, o passo 1 explica em vez de deixar seguir:
   *"Disparo em massa só está disponível no WhatsApp Oficial. Instâncias conectadas por QRCode
   não podem enviar campanhas — é a regra que mais protege o número de banimento."*
2. **Seletor de canal:** quando existir mais de um canal com `broadcast`, o seletor lista só
   esses. Hoje resolve para um; a lista é a preparação para o segundo número Cloud API.
3. **Runtime:** `broadcast-core` assere a capacidade do canal resolvido antes do fan-out.
   Backstop para um disparo criado via API v1 ou enfileirado antes de uma mudança de canal.

**Não é regressão de nada:** hoje um disparo numa conta sem `whatsapp_config` falha com
"WhatsApp not configured". Depois da F6 ele falha com o motivo verdadeiro.

### 5.4 API pública v1

`POST /api/v1/messages` aceita `channel_id` **opcional**. Aditivo, sem quebra — omitir mantém
o comportamento atual (canal padrão da conta).

O caminho é curto porque `resolveConversationByPhone`
([resolve-conversation.ts:42](../src/lib/whatsapp/resolve-conversation.ts#L42)) **já** resolve
o canal padrão e **já** filtra a conversa por `channel_id`. Recebe o parâmetro e o repassa.

| Situação                                       | Resposta                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `channel_id` ausente                           | canal padrão (hoje)                                                  |
| `channel_id` de outra conta ou inexistente     | `400 bad_request` — nunca 404, que confirmaria a existência do id    |
| `channel_id` de canal desconectado             | `400` com o status no motivo                                         |
| Tipo de mensagem sem capacidade no canal       | `400` com a mensagem de `ChannelCapabilityError` (já em inglês)      |

`GET /api/v1/conversations` ganha `channel_id` na resposta e `?channel_id=` como filtro — pelo
mesmo argumento aditivo. Documentar em [docs/public-api.md](./public-api.md).

⚠️ **Mensagens de `/api/**` ficam em inglês** (regra do `AGENTS.md`). Os erros de capacidade já
nascem assim.

### 5.5 Webhooks de saída

`message.received` ([ingest.ts:554](../src/lib/channels/ingest.ts#L554)) e
`conversation.created` (L137) ganham `channel_id` e `channel_type`. `message.status_updated`
idem, no ponto onde já resolve a conversa.

Puramente aditivo — os assinantes existentes ignoram campos que não conhecem. Sem migração:
`WEBHOOK_EVENTS` não muda, só o corpo. Documentar em `docs/public-api.md`.

### 5.6 IA

`sendAndPersistOutbound` já roteia (F4.1), então rascunho e auto-resposta funcionam. Um item
só: o prompt de sistema não deve prometer o que o canal não tem. Se a IA sugerir "vou te
mandar os botões", o canal QR entrega texto. **Requisito mínimo:** a montagem do contexto
informa o tipo de canal, e a instrução para canal sem interativo diz para oferecer opções
numeradas em texto. Sem isso a IA escreve para um canal imaginário.

### 5.7 Fora da F6

Dashboard com filtro por canal (PRD §10). É consulta e rotulagem, sem risco de perder
mensagem, e não bloqueia nada. Vai para a F7/F8.

---

## 6. As duas pontas soltas do PRD

### 6.1 `sendViaFallbackChannel` — o desvio que hoje lança

[engine.ts:975](../src/lib/automations/engine.ts#L975) lança com motivo explícito, de
propósito: "um 'enviado' que não entregou é a pior falha possível num CRM de atendimento".
Toda a decisão já existe e está testada
([window-fallback.ts](../src/lib/automations/window-fallback.ts), 20 testes verdes); a UI já
oferece a opção quando há instância elegível; o `validate.ts` já barra step interativo.

**O corpo passa a ser:**

```
sendViaFallbackChannel(guard, text, conversationId, args)
  1. resolveChannelContext(db, accountId, 'whatsapp_qr', guard.channelId)
  2. teto de envio frio (§6.2) → negado ⇒ SKIP com describeDenial()
  3. sendWithPhoneVariants({ ctx, content: { kind:'text', text } })
  4. persiste messages + atualiza conversations
  5. registra a linha em channel_cold_sends
```

Cinco pontos que a implementação **não pode** simplificar:

1. **Não é `sendAndPersistOutbound` puro.** Aquela função resolve o canal *da conversa*, e o
   desvio existe justamente para sair por **outro** canal. É o único chamador legítimo do
   parâmetro de canal explícito, e o `channelType`/`channelId` precisam viajar juntos — a
   `resolveChannelContext` recusa `whatsapp_qr` sem id ([send.ts:169](../src/lib/channels/send.ts#L169)).
2. **A mensagem é persistida na conversa ORIGINAL** (a do canal Cloud onde a janela fechou),
   não numa thread nova do canal QR. Duas razões: a automação foi disparada por aquela thread
   e o log tem de ser lá; e criar thread automaticamente faria uma conversa nascer sem o
   cliente ter escrito, poluindo a lista. **Consequência a documentar na UI:** a bolha sai na
   thread do oficial embora o cliente tenha recebido do outro número — a bolha carrega o selo
   do canal de desvio para que o agente entenda.
3. **O teto de envio frio vem antes do envio, e negar é `skip`.** PRD §10.3, literal: cota
   estourada é adiamento, não defeito.
4. **A contagem é gravada DEPOIS da entrega confirmada.** Contar antes transforma uma falha de
   rede em cota consumida.
5. **A ordem "entregou, mas o INSERT falhou" não pode virar exceção de envio.** É o mesmo
   contrato de `sendAndPersistOutbound` (L677): o provedor já tem a mensagem, e fingir falha
   faria o motor tentar de novo.

**Um risco que a implementação precisa fechar:** a decisão da rota (`resolveWindowRoute`)
verifica `channel.status === 'connected'` a partir de `loadFallbackChannels`, que lê a tabela.
Entre a decisão e o envio a instância pode ter caído. O erro do adaptador nesse caso é
`channel_unavailable` — e ele tem de virar **falha do passo com motivo**, não `skip`: um canal
que caiu é problema a resolver, não cota a esperar.

### 6.2 Contagem de envio frio

`cold-send-limit.ts` está pronto e tem 27 testes verdes: parsing, `isColdSend`,
`effectiveDailyLimit` com aquecimento, `evaluateColdSend` e `describeDenial`. É módulo puro —
**quem chama reúne o uso**. Falta exatamente isso.

**Quem reúne:** um `loadColdSendUsage(db, channelId)` novo, em `lib/channels/`, devolvendo o
`ColdSendUsage` que o módulo já tipa:

```
last24h        count em channel_cold_sends, sent_at >= now()-24h
lastHour       idem, >= now()-1h
lastColdSendAt max(sent_at)
instanceCreatedAt   channels.created_at
```

Três consultas contra `idx_cold_sends_channel_time`, ou uma agregada. Só rodam quando o envio
**é frio** — `isColdSend(lastInboundAt, …)` primeiro, e ele já tem o dado à mão em todos os
caminhos (o motor acabou de ler a conversa).

**Onde entra no caminho de envio** (D-1):

| Chamador                                        | Verifica? | Registra? |
| ----------------------------------------------- | --------- | --------- |
| `sendViaFallbackChannel` (automação)            | ✅        | `engine`  |
| `sendAndPersistOutbound` em canal sem janela    | ✅        | `engine`  |
| `POST /api/whatsapp/send` (inbox) em canal QR   | ❌ avisa  | `human`   |
| `POST /api/v1/messages` em canal QR             | ✅        | `api`     |
| Qualquer envio em canal Cloud                   | —         | —         |

A API pública verifica **e** bloqueia (com `429` e `Retry-After` de
`decision.retryAfterSeconds`): é caminho automatizado por definição, e um integrador que
receba 200 vai continuar mandando.

**A rota de consulta já existe** (`GET /api/channels/cold-send-limits`, piso `viewer`) e hoje
devolve só os tetos. Ganha o **consumo por instância**, que é o que a aba WhatsApp QRCode
(F3) precisa para desenhar a barra e o selo de aquecimento.

**Um detalhe que o cálculo não pode perder:** `effectiveDailyLimit` usa
`instanceCreatedAt` para o aquecimento, e a fonte é `channels.created_at` — **não**
`evolution_instances.created_at`. As duas linhas nascem juntas hoje, mas quem reconecta uma
instância existente não reinicia o aquecimento, e é o canal que representa "este número no
CRM". Escrever isso no código evita que a próxima pessoa "corrija" para a tabela errada.

---

## 7. Plano de teste

### 7.1 Automatizado (co-locado, Vitest)

| Arquivo                                                     | Cobre                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/flows/degraded-menu.test.ts`                       | **§5.2 — o coração da F6.** Numeração 1-based na ordem exibida; emoji; rótulo sem caixa/acento; prefixo ambíguo **não** casa; nada casa → fallback. Achatamento de seções de `send_list`             |
| `src/lib/flows/engine.degraded.test.ts`                     | Nó `send_buttons` em canal sem `interactiveButtons`: envia texto, resume casa `"2"`, avança para `next_node_key` do 2º botão. **E o inverso**: em Cloud, texto num nó `send_buttons` continua caindo no fallback (byte a byte) |
| `src/lib/automations/engine.window.test.ts` (bloco novo)    | §1.2 — `applicable` chega em `resolveWindowRoute`. Fixture com canal QR e âncora **preenchida**: prova que a rota vem da regra 1, não da 2                                                          |
| `src/lib/automations/engine.fallback-channel.test.ts`       | §6.1 — envia pelo canal do desvio e **nunca** toca `whatsapp_config`; persiste na conversa original; `channel_unavailable` vira `fail`, não `skip`; teto negado vira `skip` com `describeDenial()`  |
| `src/lib/channels/cold-send-usage.test.ts`                  | §6.2 — janelas de 24h/1h corridas; `lastColdSendAt`; `instanceCreatedAt` vem de `channels`; envio não-frio não consulta nada                                                                        |
| `src/lib/channels/cold-send-wiring.test.ts`                 | D-1 — motor bloqueia, inbox humano não bloqueia mas grava `origin='human'`, API v1 responde `429` com `Retry-After`                                                                                 |
| `src/lib/automations/validate.test.ts` (blocos novos)       | §5.1.2 — `send_template` em conta só-QR é erro; em conta mista é aviso; `session_window_expiring` em conta sem canal com janela avisa                                                              |
| `src/lib/whatsapp/broadcast-core.test.ts` (bloco novo)      | §5.3 — canal sem `capabilities.broadcast` recusa antes do fan-out, com motivo                                                                                                                       |
| `src/lib/whatsapp/resolve-conversation.test.ts` (bloco novo) | §5.4 — `channelId` explícito escolhe a thread daquele canal; id de outra conta → erro; ausente = padrão (**idêntico ao de hoje**)                                                                  |
| `src/lib/channels/ingest.test.ts` (bloco novo)              | §5.5 — `message.received` e `conversation.created` carregam `channel_id`/`channel_type`; os campos antigos permanecem                                                                               |
| `src/components/inbox/message-composer.test.ts`             | §4.3 — matriz de controles por tipo de canal; nenhum controle sumindo em Cloud                                                                                                                      |
| `src/lib/inbox/channel-filter.test.ts`                      | §4.1 — `?channel` inválido degrada para `all`; predicado entra na query                                                                                                                             |

### 7.2 Não-regressão obrigatória

Estes já existem e **têm de continuar verdes sem edição**. Precisar mudar um deles é sinal de
mudança de comportamento não intencional, e o diff precisa de justificativa escrita:

| Arquivo                                          | Protege                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `src/lib/automations/window-fallback.test.ts`     | As 12 rotas da decisão de janela (20 testes)                   |
| `src/lib/channels/cold-send-limit.test.ts`        | O cálculo do teto (27 testes)                                  |
| `src/lib/automations/window-scan.test.ts`         | Guardrail de canal na varredura (PRD §7.1.2)                   |
| `src/lib/channels/session-window.test.ts`         | `applicable:false` em QR; paridade em Cloud                    |
| `src/lib/channels/send.test.ts`                   | F4.1 — roteamento por conversa                                 |
| `src/lib/flows/engine.test.ts`                    | Resume, fallback e reprompt no canal oficial                   |
| `src/lib/channels/ingest.test.ts`                 | Paridade da ingestão + idempotência                            |

Os **cinco critérios da PRD §7.1.6** continuam sendo o gate da F6, agora demonstráveis de
verdade (na 048 três dependiam de canal pareado):

1. `send_message` dispara normalmente em conversa QR sem âncora.
2. `send_message` em conversa Cloud fora da janela mantém `on_window_closed` idêntico.
3. Condição `session_window: open` → verdadeira em QR; em Cloud, decidida pela âncora.
4. `session_window_expiring` **nunca** seleciona conversa QR, mesmo com âncora forçada no banco.
5. Thread QR não exibe faixa de janela; thread Cloud exibe.

### 7.3 Manual, obrigatório antes do merge

Contra a instância real da SPEC 048 §8.2 (`--keep`) e um número de verdade.

**F5:**

1. Conta com dois canais: seletor aparece; conta com um canal: **não** aparece.
2. `?channel=<qr>` sobrevive ao refresh e ao compartilhamento do link.
3. `?channel=<uuid inexistente>` → lista completa, sem erro.
4. Selo no cabeçalho da thread aberta por link direto `?c=`.
5. Composer em thread QR: sem Template, sem Interativo, com anexo e áudio.
6. Composer em thread Cloud: **tudo como hoje** — a comparação lado a lado é o teste.
7. Contato com thread nos dois canais: "Também neste contato" lista a outra, o link abre e o
   filtro de canal se limpa.
8. Filtro de contatos por canal com **mais de 1000 conversas** no canal — é o cenário que a
   §1.4 existe para evitar; conferir contagem total e paginação.
9. **Áudio gravado no composer em canal QR** → conferir no aparelho se chega como mensagem de
   voz ou anexo (decide `capabilities.ptt`, §4.3).

**F6:**

10. Flow com `send_buttons` em conversa QR → chega numerado; responder `2` avança; responder
    `"segunda via"` avança; responder `"xyz"` reprompta com o mesmo menu numerado.
11. O mesmo flow em conversa Cloud → botões nativos, **inalterado**.
12. Automação com `on_window_closed: fallback_channel`: conversa Cloud com janela fechada,
    instância QR conectada → o cliente recebe **do outro número**; a bolha aparece na thread
    do oficial com selo do canal de desvio; `automation_logs` registra o desvio.
13. Repetir 12 com o contato `opted_out` → `skip`, nada enviado.
14. Repetir 12 com a instância **desconectada** → falha com o status no motivo.
15. Estourar o teto de envio frio (baixar `EVOLUTION_COLD_SEND_PER_HOUR=1`) → segundo envio
    vira `skip` com o texto de `describeDenial()` no log; a aba WhatsApp QRCode mostra o
    consumo.
16. Enviar pelo inbox, à mão, para contato em silêncio há mais de 24h → **não bloqueia**, mas
    a linha aparece em `channel_cold_sends` com `origin='human'` e o consumo sobe.
17. `POST /api/v1/messages` com `channel_id` de instância QR → sai por ela; sem `channel_id` →
    sai pelo padrão; com `channel_id` de outra conta → `400`.
18. Assistente de disparo numa conta só-QR → explicação, não "WhatsApp não configurado".
19. Webhook de saída recebe `channel_id`/`channel_type` nos três eventos.

---

## 8. i18n e configuração

**Nenhuma variável de ambiente nova.** As cinco do teto de envio frio já estão em
`.env.local.example` (PRD §12) e já são lidas.

Chaves novas em `messages/en.json` (fonte da verdade) e `messages/pt-BR.json`, nos namespaces
`inbox`, `contacts`, `automations`, `flows`, `broadcasts`. `npm run i18n:check` falha se
divergirem — rodar antes do push, como sempre.

Duas frases que **não** podem ser traduzidas por aproximação, porque descrevem risco:

- o aviso do desvio por canal ("o contato vai receber de um número diferente…", PRD §10.2);
- a explicação do disparo indisponível (§5.3).

Mensagens de `/api/**` permanecem em inglês.

---

## 9. Riscos

| Risco                                                              | Prob.  | Impacto     | Mitigação                                                                                                                     |
| ------------------------------------------------------------------ | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Degradação de menu roteia o cliente para o ramo errado**         | Média  | **Alto**    | §5.2 — prefixo ambíguo não casa; matcher é módulo puro com teste de cada regra; reprompt reenvia o menu numerado                |
| **Flow em canal Cloud regride junto com a degradação**             | Média  | **Crítico** | O ramo de Cloud é testado explicitamente como *inalterado* (§7.1); PR isolado da F6.2                                          |
| **Desvio de canal vira ferramenta de spam**                        | Média  | **Alto**    | Teto de envio frio ligado por padrão; opt-out bloqueia; aviso obrigatório na UI; `origin` na tabela para auditar               |
| **Teto de envio frio contado errado bloqueia atendimento legítimo** | Média  | Médio       | Só envio frio conta (`isColdSend` antes de qualquer consulta); `0` desliga; negar é `skip`, nunca `fail`                       |
| **`DROP FUNCTION` da 061 derrubar a página de contatos**           | Baixa  | **Alto**    | §3.1 — asserção de contagem de funções **e** de `EXECUTE` para `authenticated`, na própria migração                            |
| **Filtro de contatos por canal perder contatos em silêncio**       | Alta se feito no cliente | Médio | §1.4 — RPC server-side; teste manual #8 com >1000 conversas                                                        |
| **Duas fontes escrevendo `?channel` na URL**                       | Média  | Baixo       | §1.7 — escrita só em `inbox/page.tsx`; o hook continua somente-leitura                                                        |
| Selo/seletor virar ruído em conta de canal único                   | Alta   | Baixo       | `count > 1` como gate em todos os pontos (§4)                                                                                 |
| Aviso de step inválido irritar quem tem os dois canais             | Média  | Baixo       | §5.1.2 — aviso quando há canal compatível, erro só quando não há nenhum                                                       |
| `maybeSingle()` sobre `message_id` não-único quebrar o flow        | Baixa  | Baixo       | §1.8 — escopar por conversa e ordenar                                                                                         |

---

## 10. Ordem de execução, PRs e modelo recomendado

| Fase     | Entrega                                                                      | Depende de |
| -------- | ---------------------------------------------------------------------------- | ---------- |
| **F5.1** | Migração 061 + filtro de contatos por canal                                  | —          |
| **F5.2** | Seletor de canal na URL + selo na thread + "também neste contato"            | —          |
| **F5.3** | Composer sensível a capacidade + escolha de canal ao abrir conversa          | F5.2       |
| **F6.1** | Migração 062 + `loadColdSendUsage` + wiring do teto + rota de consumo        | —          |
| **F6.2** | **Degradação de menu em flows (saída + matcher)**                            | —          |
| **F6.3** | `sendViaFallbackChannel` real                                                | **F6.1**   |
| **F6.4** | Automações: avisos de editor, `applicable` de verdade, motivo no log         | —          |
| **F6.5** | Disparos, API v1, webhooks de saída, contexto de canal na IA                 | —          |

### As fases que merecem PR isolado

Pelo mesmo critério que isolou a F2 da SPEC 048 — **o erro não aparece como erro**:

🔴 **F6.2 (degradação de menu) — PR sozinho, sem nenhuma outra mudança.** É a única fase desta
SPEC que toca o caminho de *entrada*. Um erro no matcher não estoura: ele faz o flow reprompt
até desistir, num canal, enquanto o outro segue perfeito. E ele mexe no mesmo `resumeFlowRun`
que atende o canal oficial — um `if` mal colocado ali derruba os menus de quem paga template.
Revisar com os dois ramos (Cloud e QR) demonstrados lado a lado, e com o teste do ramo Cloud
verificado **falhando** contra uma implementação errada de propósito (a lição da SPEC 048
§6.7: fixture inventada reproduz a suposição do autor).

🔴 **F6.3 (`sendViaFallbackChannel`) — PR sozinho.** É o único ponto do sistema que manda
mensagem por um canal **diferente** daquele da conversa, para um contato que está em silêncio,
a partir de um número que ele não reconhece. As duas formas de errar são caras e mudas: um
"enviado" que não entregou (a razão de a função lançar hoje) e um envio que não deveria ter
saído. Depende da F6.1 estar mergeada — sem o teto, o PR entrega o desvio sem o freio.

🟡 **F5.1 (migração 061) — PR sozinho**, não pela lógica, mas pelo `DROP FUNCTION`: é a única
mudança desta SPEC que pode derrubar uma página inteira em produção com um erro de permissão,
e ela precisa ser revertível sem arrastar UI junto.

As demais (F5.2, F5.3, F6.4, F6.5) podem ir agrupadas — são aditivas, visíveis, e falham na
cara de quem usa.

### Modelo recomendado por fase

| Fase                                      | Recomendação   | Motivo                                                                                                       |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| **F6.2** — degradação de menu             | **Opus 5**     | Caminho de entrada compartilhado com o canal oficial; erro se manifesta como bot teimoso, não como exceção   |
| **F6.3** — `sendViaFallbackChannel`       | **Opus 5**     | Envio por canal alheio, ordem de persistência e a fronteira `skip` × `fail` — três decisões sutis num só corpo |
| **F6.1** — teto de envio frio             | **Sonnet 5**   | O cálculo já está pronto e testado; falta reunir contagens e ligar. Execução mecânica sobre desenho fechado  |
| **F5.1** — migração 061                   | **Sonnet 5**   | SQL com asserção já especificada aqui; o risco está no `DROP`, e ele está escrito                            |
| **F5.2 / F5.3** — inbox                   | **Sonnet 5**   | Padrões já estabelecidos pela F4.5 (`useAccountChannels`, selo, gate por `count > 1`)                        |
| **F6.4 / F6.5** — avisos, API, webhooks   | **Sonnet 5**   | Aditivo, com contrato definido nesta SPEC                                                                    |
| **F7** — i18n, docs, dashboard            | **Sonnet 4.6** | Volume, baixa complexidade                                                                                   |

**Ordem inegociável:** F6.1 antes de F6.3 (desvio sem freio é metralhadora). F5.2 antes de
F5.3 (o composer precisa saber o canal que o seletor resolve). Tudo o mais é paralelizável.

---

## 11. Definição de pronto

A SPEC 049 fecha quando:

1. Os **cinco critérios da PRD §7.1.6** estão demonstrados (§7.2) — agora com canal pareado de
   verdade, não por fixture.
2. Um flow com menu roda ponta a ponta **nos dois canais**, com o mesmo desenho de autoria e
   sem o autor ter feito nada diferente (métrica do PRD §17: "100% dos passos suportados").
3. O desvio da §10.2 entrega uma mensagem real, pelo número certo, com a linha correspondente
   em `channel_cold_sends` e o motivo no `automation_logs`.
4. O disparo em massa é recusado com mensagem que explica **por quê**, não com "não
   configurado".
5. `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — verde, na ordem, antes do push.
