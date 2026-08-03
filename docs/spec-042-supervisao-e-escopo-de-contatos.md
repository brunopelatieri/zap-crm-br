# SPEC 042 — Supervisão e escopo de contatos: fechando D2, D5 e D7

> **Status:** Rascunho para revisão. **Nenhuma linha de implementação foi escrita.**
> **Severidade:** 🟡 Médio — não há vazamento novo aqui; há **capacidade perdida** e
> **promessa de UI que o banco não cumpre**.
> **Escopo:** `src/components/inbox/` (abas, lista, diretório de contatos),
> `src/hooks/use-inbox-tabs.ts`, `src/lib/inbox/tabs.ts`, `messages/*.json`.
> Sem migração obrigatória.
> **Data:** 2026-08-03

---

## 0. Resumo executivo

A §6 da [SPEC de abas + atribuição](spec-inbox-tabs-assignment.md) listou sete decisões
pendentes (D1–D7) declaradas como **bloqueadoras da implementação**. Quatro foram
resolvidas de forma explícita e documentada na entrega:

| | Decisão | Como ficou |
| --- | --- | --- |
| D1 | Aba "Open" = `IS NULL` ou `status='open'`? | `assigned_agent_id IS NULL` ([tabs.ts](../src/lib/inbox/tabs.ts)) |
| D3 | Filtro de status na aba "Chat" | mantido nas duas abas |
| D4 | Rótulos literais | `Chat` / **`Fila`** / `Contatos` em PT-BR ([pt-BR.json:212-216](../messages/pt-BR.json#L212-L216)) |
| D6 | Backfill | híbrido, com snapshot reversível (039, seção 12) |

**As outras três nunca foram decididas — foram implementadas por omissão.** O código
escolheu um caminho, ele funciona, mas ninguém registrou a escolha nem mediu o efeito.
Duas delas deixaram buracos concretos:

- **D7** — a UI não tem caminho nenhum para um admin ver a carteira de outro agente,
  embora a RLS autorize. **Supervisão perdida.**
- **D2** — a aba Contatos filtra no cliente sobre uma tabela sem RLS por atribuição.
  O texto na tela promete um isolamento que **não existe**.
- **D5** — o `viewer` perdeu a visão global sem que o impacto fosse validado.

Esta SPEC fecha as três: cada uma vira decisão registrada, com recomendação e plano.

---

## 1. 🟡 D7 / F-42-A — Admin e owner não têm como supervisionar

### Situação

A aba "Chat" é sempre "minhas conversas", para todo mundo. O predicado não tem ramo de
papel ([tabs.ts:81-88](../src/lib/inbox/tabs.ts#L81-L88)):

```ts
export function matchesConversationTab(tab, assignedAgentId, userId): boolean {
  const assigned = assignedAgentId ?? null;
  return tab === 'chat' ? assigned === userId : assigned === null;
}
```

E o fetch correspondente é `.eq('assigned_agent_id', user.id)`
([tabs.ts, `conversationTabPredicate`](../src/lib/inbox/tabs.ts)).

Enquanto isso, o **banco** autoriza o admin a ver tudo — é um dos três ramos de
`can_access_conversation` ([039:29-32](../supabase/migrations/039_conversation_assignment.sql#L29-L32)) —
e o **cliente** já tem a capacidade tipada para saber disso:
`useCan('view-all-conversations')` ([use-can.ts:61-62](../src/hooks/use-can.ts#L61-L62))
sobre `canViewAllConversations` ([roles.ts:114](../src/lib/auth/roles.ts#L114)), que
inclui corretamente o `owner` — a armadilha F-05 da SPEC original foi bem tratada.

**A permissão existe, a capacidade existe, a UI não a usa em lugar nenhum do fluxo de
conversas.** O único consumidor de `view-all-conversations` hoje é o diretório de
contatos ([contacts-directory.tsx:46](../src/components/inbox/contacts-directory.tsx#L46)).

### Por que importa

Antes da 039 o modelo era plano: o dono da conta abria o Inbox e via o atendimento
inteiro. Depois da 039 ele vê **as conversas atribuídas a ele** — que, para um dono que
não atende pessoalmente, é **nenhuma** — mais a fila. A conta ficou sem supervisão de
atendimento pela interface. Não há tela onde a pergunta *"o que o agente A está
respondendo?"* seja respondível.

Este era exatamente o alerta do D7 (*"Admin vê 'todas' na aba Chat (fica ilegível em
contas grandes) ou tem um seletor 'ver como: {agente}'?"*). A entrega não escolheu
nenhuma das duas: ficou sem opção alguma.

### Decisão recomendada: seletor "ver como"

**Recomendação: seletor de agente na aba "Chat", visível apenas para `admin`/`owner`.**

Descartada a alternativa "admin vê todas na Chat": mistura duas semânticas na mesma aba
(a Chat deixa de significar "minhas"), fica ilegível numa conta com centenas de
conversas ativas, e some com a fronteira que a própria SPEC estabeleceu entre as abas.

O seletor mantém o predicado com a mesma **forma** — `assigned_agent_id = <alguém>` —
apenas com um alvo variável. Isso é decisivo do ponto de vista de implementação: nada
muda no banco, nada muda no formato da query, nada muda no roteamento de realtime além
de comparar com o agente escolhido em vez de com `user.id`.

### Implementação

1. **[tabs.ts](../src/lib/inbox/tabs.ts)** — `conversationTabPredicate` e
   `matchesConversationTab` passam a receber o **`viewAsUserId`** em vez de assumir o
   usuário da sessão. Os dois já compartilham a obrigação de "descrever a MESMA regra,
   um em forma de filtro e o outro em forma de predicado booleano" (comentário no
   próprio arquivo) — a mudança tem de entrar nos dois, e [tabs.test.ts](../src/lib/inbox/tabs.test.ts)
   ganha casos com alvo diferente da sessão.
2. **[use-inbox-tabs.ts](../src/hooks/use-inbox-tabs.ts)** — `viewAs` entra no estado de
   aba. **Na URL** (`?tab=chat&viewAs=<uuid>`), pelo mesmo motivo que a aba já está lá
   (§3.1 da SPEC original): refresh estável e link compartilhável — um admin manda ao
   colega "olha a fila do Fulano". Ausente = eu.
3. **[use-conversation-feed.ts](../src/hooks/use-conversation-feed.ts)** — o `userId` que
   ele já recebe passa a ser o alvo; o hook não precisa saber que é "outra pessoa".
   Trocar de alvo é uma troca de predicado, logo **invalida o cache daquela aba**.
4. **UI** — o seletor vive junto das abas ([inbox-tabs.tsx](../src/components/inbox/inbox-tabs.tsx))
   ou no topo da lista, e só renderiza sob `useCan('view-all-conversations')`.
   **Reusar o fetch de `profiles` que o [message-thread.tsx:229-236](../src/components/inbox/message-thread.tsx#L229-L236)
   já faz** para o dropdown de atribuição — mesma lista, mesmo filtro de conta; vale
   extrair para um hook `use-account-members` em vez de duplicar a query.
5. **Estado visual obrigatório.** Quando `viewAs ≠ eu`, a lista precisa dizer de quem
   ela é ("Vendo a carteira de {nome}") e o composer deve deixar claro que responder
   ali **não** transfere a conversa. Sem isso o admin responde achando que assumiu.
6. **i18n** — `Inbox.tabs.viewAs*` em [pt-BR.json](../messages/pt-BR.json) e
   [en.json](../messages/en.json).

**Fora de escopo, registrado:** o `viewAs` não vale para a aba "Fila" (a fila é única e
já é visível a todos) nem para "Contatos" (§2).

---

## 2. 🟡 D2 / F-42-B — O isolamento de contatos é cosmético, e a tela diz o contrário

### Situação

A aba Contatos restringe o agente aos contatos com quem ele tem conversa atribuída,
resolvendo `contact_id` das conversas dele e filtrando com `.in('id', …)`
([contacts-directory.tsx:78-90](../src/components/inbox/contacts-directory.tsx#L78-L90)).

O componente é honesto sobre o que isso é
([contacts-directory.tsx:24-34](../src/components/inbox/contacts-directory.tsx#L24-L34)):

> `contacts` não tem RLS restrita por atribuição (não carrega conteúdo de conversa —
> Fase 1 deliberadamente não mexeu nela), então essa restrição é aplicada aqui

Correto e coerente com o escopo declarado da 039
([039:64-68](../supabase/migrations/039_conversation_assignment.sql#L64-L68)).
`contacts_select` segue `is_account_member(account_id)`
([017:386](../supabase/migrations/017_account_sharing.sql#L386)).

**O problema é o que a tela afirma.** O subtítulo em PT-BR é
*"Contatos das conversas atribuídas a você"* ([pt-BR.json:221](../messages/pt-BR.json#L221)),
lido naturalmente como um limite de acesso. Não é. Qualquer agente logado obtém a base
inteira de contatos da conta — nome, telefone, e-mail, empresa — com uma requisição
direta ao PostgREST usando a `anon key` que já está no bundle:

```bash
curl "$SUPABASE_URL/rest/v1/contacts?select=name,phone,email,company" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $AGENT_JWT"
```

É precisamente o **"falso isolamento"** contra o qual a F-10 da SPEC original alertava:
*"Filtrar a lista por `user_id` no cliente seria falso isolamento"*. A entrega evitou o
erro técnico (não fingiu que o filtro era segurança) mas deixou o erro **de
comunicação** na interface.

### Decisão recomendada: assumir o escopo de conta e ajustar o texto

**Recomendação: não endurecer `contacts`. Corrigir o que a UI afirma.**

Endurecer custa caro e rende pouco:

- a página `/contacts` inteira passa a ver menos linhas, e ninguém pediu isso;
- o RPC `filter_contacts_by_tags` ([025](../supabase/migrations/025_filter_contacts_by_tags.sql))
  é `SECURITY INVOKER` — herdaria o filtro (bom), mas o `total_count` que ele devolve
  muda e **toda a paginação de `/contacts` precisa ser retestada**, como a própria F-10
  antecipou;
- contatos não carregam conteúdo de conversa. O que a 039 se propôs a proteger — o que o
  cliente escreveu — continua protegido.

O contato é, no modelo do produto, um **ativo da conta**, não do agente. O filtro da aba
é **ergonomia** ("mostre primeiro quem é meu"), e é assim que deve ser apresentado.

### Implementação

1. **Texto**: `subtitleMine` deixa de sugerir limite de acesso. Sugestão PT-BR:
   *"Contatos das suas conversas"* com um subtexto ou tooltip *"Todos os contatos da
   conta permanecem acessíveis em Contatos"*, e link para `/contacts`. Ajustar
   [en.json](../messages/en.json) em paralelo.
2. **Comentário do componente**: atualizar
   [contacts-directory.tsx:20-34](../src/components/inbox/contacts-directory.tsx#L20-L34)
   para dizer que a decisão D2 **foi fechada** aqui, com o porquê — o comentário atual
   descreve a mecânica mas ainda soa provisório.
3. **Registro**: esta seção é o registro da decisão. Referenciá-la do cabeçalho da
   próxima migração que tocar `contacts`.

### Se a decisão for a oposta (custo, para constar)

`contacts_select` passaria a `is_account_member(account_id) AND (canViewAll OR EXISTS
(SELECT 1 FROM conversations c WHERE c.contact_id = contacts.id AND c.assigned_agent_id
= auth.uid()))`. Consequências: contato **novo, ainda sem conversa**, fica invisível
para quem o criou (quebra o fluxo de importação e o de criar-contato-e-mandar-mensagem);
`/contacts`, os funis, os disparos em massa e o `filter_contacts_by_tags` precisam de
reteste completo. **Não recomendado nesta entrega.**

---

## 3. 🟡 D5 / F-42-C — O `viewer` perdeu a supervisão

### Situação

O `viewer` enxerga apenas a fila. A regra está na 039 e a justificativa é sólida
([039:29-32](../supabase/migrations/039_conversation_assignment.sql#L29-L32)):

> O `viewer` segue a regra literal: enxerga apenas a fila. É o papel de MENOR rank (1);
> dar-lhe leitura ampla o faria ver mais que um `agent` (rank 2), invertendo a
> hierarquia de permissões.

O argumento está certo. O efeito colateral é que a aba "Chat" de um `viewer` fica
**permanentemente vazia** — `assigned_agent_id = auth.uid()` nunca casa, porque ele nunca
é atribuído a nada (não pode responder, `canSendMessages` é agent+) e nem pode
reivindicar (`INSUFFICIENT_ROLE` no `claim_conversation`). Era exatamente o cenário
descrito na F-06 da SPEC original.

**Isto é uma mudança de comportamento não anunciada.** Antes da 039 o `viewer` via tudo —
era, na prática, o papel de auditoria/observação da conta. Depois, virou um papel que só
observa a fila. Ninguém validou se alguém dependia disso.

### Decisão recomendada: manter, e dar a válvula certa

**Recomendação: manter o `viewer` restrito à fila.** Inverter a hierarquia de ranks para
resolver um caso de uso seria pior do que o problema — passaria a existir um papel que vê
mais do que o papel acima dele, e todo `hasMinRole` do repo deixaria de significar o que
significa.

A supervisão passa a ser atendida pelo **seletor "ver como" da §1**, que é `admin`+.
Quem precisa auditar atendimento é promovido a `admin`.

### Implementação

1. **Aba "Chat" vazia para `viewer` precisa de estado vazio explicativo**, não de uma
   lista em branco: *"Conversas atribuídas a você aparecem aqui. Seu papel (Leitor) não
   recebe atribuições."* Hoje o `viewer` vê um vazio indistinguível de erro.
2. **Documentar a mudança de papel** onde os papéis são explicados ao usuário (tela de
   membros / convite): o `viewer` deixou de ser "vê tudo, não escreve" e passou a ser
   "vê a fila, não escreve".
3. **Avisar o mantenedor** para checar se há `viewer` ativo em produção usado como
   auditor — se houver, a resposta é promoção a `admin`, não mudança de regra.

---

## 4. Plano de deploy

Nenhuma migração obrigatória. Tudo é cliente + i18n, e cada fase é independente.

| Fase | # | Alvo | Ação |
| --- | --- | --- | --- |
| **1 — texto** | 1.1 | [messages/pt-BR.json](../messages/pt-BR.json), [en.json](../messages/en.json) | `subtitleMine` deixa de prometer isolamento (§2) |
| | 1.2 | [contacts-directory.tsx](../src/components/inbox/contacts-directory.tsx) | comentário: D2 fechada, com o porquê |
| | 1.3 | Inbox | estado vazio explicativo da aba "Chat" para `viewer` (§3) |
| **2 — supervisão** | 2.1 | `src/hooks/use-account-members.ts` | **novo** — extrair o fetch de `profiles` hoje embutido no [message-thread.tsx:229](../src/components/inbox/message-thread.tsx#L229) |
| | 2.2 | [tabs.ts](../src/lib/inbox/tabs.ts) + [tabs.test.ts](../src/lib/inbox/tabs.test.ts) | predicados recebem `viewAsUserId` |
| | 2.3 | [use-inbox-tabs.ts](../src/hooks/use-inbox-tabs.ts) | `viewAs` na URL |
| | 2.4 | [use-conversation-feed.ts](../src/hooks/use-conversation-feed.ts) | invalidar cache ao trocar de alvo |
| | 2.5 | [inbox-tabs.tsx](../src/components/inbox/inbox-tabs.tsx) | seletor sob `useCan('view-all-conversations')` |
| | 2.6 | [inbox/page.tsx](../src/app/(dashboard)/inbox/page.tsx) | roteamento de realtime comparando com o alvo, não com `user.id` |
| | 2.7 | `messages/*.json` | `Inbox.tabs.viewAs*` |
| **3 — docs** | 3.1 | esta SPEC | registro de D2/D5/D7 como fechadas |

---

## 5. Riscos e critérios de aceite

**Riscos**
- **Roteamento de realtime com `viewAs`** (2.6) é o ponto delicado: `convTabMapRef`
  ([inbox/page.tsx](../src/app/(dashboard)/inbox/page.tsx)) mapeia conversa → aba
  assumindo "minhas". Com alvo variável, um evento de conversa do agente observado tem
  de cair no feed certo — e trocar o alvo tem de **limpar** o mapa junto com o cache,
  senão sobram entradas apontando para a aba errada.
- **A conversa ativa sobrevive à troca de alvo?** Recomendação: **sim** — a thread
  continua aberta (o admin tem acesso pela RLS), só a lista muda. Fazer
  `setActiveConversation(null)` reintroduziria o bug de remount já documentado em
  [inbox/page.tsx:658](../src/app/(dashboard)/inbox/page.tsx#L658).
- **Admin respondendo na carteira alheia**: o envio dispara o claim automático do
  servidor (F-07 da SPEC original) e **transfere a conversa para o admin**. É por isso
  que o aviso do item 5 da §1 não é enfeite — sem ele, um admin "só dando uma olhada"
  rouba a conversa do agente ao responder.

**Critérios de aceite**
1. `admin` e `owner` conseguem, pela UI, abrir a carteira de outro agente e ler a thread.
2. `agent` **não** vê o seletor; forçar `?viewAs=<outro>` na URL não devolve linha alguma
   (a RLS decide — o front não precisa bloquear, mas deve degradar sem quebrar).
3. Trocar de alvo e voltar não mistura conversas de agentes diferentes na mesma lista.
4. Nenhum texto da UI afirma que um agente só acessa "seus" contatos.
5. `viewer` vê um estado vazio explicativo na aba "Chat", não uma lista em branco.
6. Admin que responde numa conversa observada recebe aviso claro de que vai assumi-la.

---

## 6. Registro das decisões

Para citar em migrações e SPECs futuras:

| Decisão | Fechamento | Onde |
| --- | --- | --- |
| **D2** | `contacts` permanece com escopo de **conta**. O filtro da aba Contatos é ergonomia, não controle de acesso. | §2 |
| **D5** | `viewer` permanece restrito à fila. Supervisão se obtém por promoção a `admin`. | §3 |
| **D7** | Admin/owner supervisionam por **seletor "ver como"**, não por "ver todas na aba Chat". | §1 |
