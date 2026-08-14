# SPEC — Navegação em 3 abas do Inbox + atribuição de conversas por agente

> **Status:** Rascunho para revisão. **Nenhuma linha de implementação foi escrita.**
> **Escopo:** `src/components/inbox/`, `src/app/(dashboard)/inbox/page.tsx`, RLS de `conversations` / `messages` / `contacts`, novas rotas de API e migração SQL.
> **Data:** 2026-08-03

---

## 0. Resumo executivo

O pedido é de UI ("três abas"), mas o núcleo do trabalho é de **autorização**. Hoje o
modelo de permissão do ZAP CRM BR é **plano por conta**: qualquer membro (`viewer`+)
enxerga _todas_ as conversas e _todas_ as mensagens da conta via RLS
(`is_account_member(account_id)`). A coluna `conversations.assigned_agent_id` existe
desde a migração 001, mas é **puramente decorativa** — nenhuma policy, nenhum índice,
nenhuma FK, nenhuma checagem de servidor a consulta.

Implementar a aba "Chat" com a regra _"apenas o agente atribuído e Admins veem"_
significa passar de **isolamento por conta** para **isolamento por linha dentro da
conta**. Isso não pode ser feito no cliente: filtrar o array `conversations` em React
esconde a conversa da lista, mas **não impede** que o agente leia a linha (e todas as
mensagens) com uma chamada direta ao PostgREST usando a própria `anon key` que já está
no bundle.

Além disso, dois requisitos do enunciado **não têm suporte no schema atual** e precisam
de decisão de produto antes do código (ver §5, itens D1 e D2):

| Requisito                                           | Situação                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Aba 3: "agentes veem só contatos atribuídos a eles" | **Não existe** coluna de atribuição em `contacts`.                                           |
| Aba 2 "Open" = "não atribuídas (badge verde)"       | O badge verde hoje é `status = 'open'`, **não** "sem responsável". São conceitos diferentes. |

---

## 1. Análise de contexto (estado atual)

### 1.1 Onde mora cada pedaço de estado

| Estado                                              | Dono hoje                                                                             | Observação                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `conversations[]` (array completo)                  | [inbox/page.tsx:42](<src/app/(dashboard)/inbox/page.tsx#L42>)                         | Fonte única; alimentada pelo filho.                            |
| `activeConversation` / `activeContact` / `messages` | [inbox/page.tsx:43-46](<src/app/(dashboard)/inbox/page.tsx#L43-L46>)                  |                                                                |
| **Fetch** das conversas                             | [conversation-list.tsx:101-135](src/components/inbox/conversation-list.tsx#L101-L135) | O filho busca e devolve pelo callback `onConversationsLoaded`. |
| `search`                                            | [conversation-list.tsx:74](src/components/inbox/conversation-list.tsx#L74)            | Local ao filho.                                                |
| `filter` (`InboxFilter`)                            | [conversation-list.tsx:75](src/components/inbox/conversation-list.tsx#L75)            | Default `'open'`.                                              |
| `selectedTagIds` / `selectedCompany`                | [conversation-list.tsx:81-82](src/components/inbox/conversation-list.tsx#L81-L82)     |                                                                |
| `tags[]` (definições)                               | [conversation-list.tsx:139-149](src/components/inbox/conversation-list.tsx#L139-L149) | Fetch próprio, uma vez.                                        |
| Realtime (`messages` + `conversations`)             | [use-realtime.ts](src/hooks/use-realtime.ts) via page.tsx                             | Canal único `inbox-realtime`, sem filtro.                      |
| Deep-link `?c=<id>`                                 | [inbox/page.tsx:40](<src/app/(dashboard)/inbox/page.tsx#L40>)                         | Auto-seleção com guarda por `useRef`.                          |

**Inversão de responsabilidade a corrigir:** o componente de _apresentação da lista_
é quem faz o fetch. Com três abas isso vira um problema real — cada aba tem um
predicado de servidor diferente, e três fetches concorrentes escrevendo no mesmo
`setConversations(loaded)` (substituição total, [page.tsx:399](<src/app/(dashboard)/inbox/page.tsx#L399>)) se
sobrescrevem mutuamente.

### 1.2 Desacoplamento proposto

```
InboxPage (page.tsx)
├── useInboxTabs()            ← NOVO hook: aba ativa + sincronização com a URL
├── useConversationFeed(tab)  ← NOVO hook: fetch + cache POR ABA + realtime
│      └── caches: { chat: Conversation[], open: Conversation[] }
├── <InboxTabs />             ← NOVO: barra de 3 abas (Chat | Open | 👤)
├── <ConversationList />      ← vira PURO (apresentação); recebe `conversations`
│                                e o predicado já aplicado; mantém search/tags/company
└── <ContactsDirectory />     ← NOVO: aba 3 (lista + busca, paginada)
```

Regras do refactor:

1. **`ConversationList` perde o `useEffect` de fetch** (linhas 101-135) e a prop
   `onConversationsLoaded`. Passa a receber `conversations` já resolvidas + `loading`.
   Isso remove de quebra o acoplamento documentado no comentário das linhas 86-95
   (o `onConversationsLoadedRef` só existe porque o fetch vivia ali).
2. **O `filter` de status (`all | unread | open | pending | closed`) permanece**, mas
   passa a ser **estado por aba** e é renderizado **somente na aba "Open"**, conforme a
   _Migration Note_ do enunciado. Na aba "Chat" o dropdown de status é ocultado ou
   reduzido (ver D3).
3. **`search`, `selectedTagIds`, `selectedCompany` sobem** para o hook de aba, guardados
   num `Record<TabId, FilterState>` — trocar de aba e voltar preserva os filtros
   (requisito §3).
4. `matchesContactFilters` e `normalizeConversations` ([lib/inbox/conversations.ts](src/lib/inbox/conversations.ts))
   **não mudam** — são puros e continuam válidos.
5. `CONVERSATION_SELECT` ganha, no máximo, o join do perfil do responsável
   (`assignee:profiles!conversations_assigned_agent_id_fkey(user_id, full_name, avatar_url)`)
   — **depende de criar a FK** (§5, passo 1). Sem FK o PostgREST não resolve o embed.

### 1.3 Colisão de nomenclatura (i18n)

`Inbox.conversationList.filterOpen` já significa **"Abertas"** (status). A aba nova
também se chama "Open". Para não sobrecarregar a chave, as abas ficam em um namespace
novo `Inbox.tabs.*` (`chat`, `open`, `contacts`), e em PT-BR sugere-se
`"Chat"` / `"Abertas"` — **atenção:** o enunciado pede os rótulos literais `"Chat"` e
`"Open"`. Se forem literais mesmo em PT-BR, isso precisa ser explicitado (ver D4).

---

## 2. Segurança e detecção de brechas (seção crítica)

### 2.1 Superfície de ataque atual

O cliente Supabase do browser ([lib/supabase/client.ts](src/lib/supabase/client.ts)) usa a
`anon key` + JWT do usuário. **Toda** tabela é acessível por PostgREST direto:

```bash
# Qualquer agente logado, hoje, com o próprio token:
curl "$SUPABASE_URL/rest/v1/conversations?select=*,messages(*)" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $AGENT_JWT"
# → devolve TODAS as conversas e mensagens da conta.
```

Não há gateway: o front fala com o banco. **Portanto, filtro em React nunca é
controle de acesso** — é apenas ergonomia. Toda regra do enunciado precisa existir
como _policy_ de RLS.

---

### 🔴 F-01 — Filtro de aba no cliente não é autorização (CRÍTICO)

**Onde:** `conversations_select` ([017_account_sharing.sql:414](supabase/migrations/017_account_sharing.sql#L414))

```sql
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (is_account_member(account_id));
```

**Cenário:** Agente A recebe a UI com a aba "Chat" mostrando 3 conversas suas.
Abre o DevTools, roda o `curl` acima, e lê as 400 conversas dos colegas — incluindo
o histórico completo de mensagens, pois `messages_select`
([017:511](supabase/migrations/017_account_sharing.sql#L511)) só verifica
`is_account_member(c.account_id)`.

**Mitigação (obrigatória):** reescrever as policies para visibilidade por linha.

```sql
-- Predicado central, SECURITY DEFINER, STABLE, reusável por conversations,
-- messages, message_reactions, message_actions e chat-media storage.
CREATE OR REPLACE FUNCTION can_access_conversation(conv_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conv_id
      AND is_account_member(c.account_id)             -- tenancy (inalterado)
      AND (
        c.assigned_agent_id IS NULL                   -- fila "Open": visível a todos
        OR c.assigned_agent_id = auth.uid()           -- dono
        OR is_account_member(c.account_id, 'admin')   -- admin E owner (rank >= 3)
      )
  );
$$;
```

Notas de implementação que **não podem ser esquecidas**:

- `is_account_member(..., 'admin')` já cobre `owner` (rank 4 ≥ 3) — ver a tabela de
  ranks em [017:145-163](supabase/migrations/017_account_sharing.sql#L145-L163). **Não** usar
  `role = 'admin'`.
- `SECURITY DEFINER` é necessário porque a policy de `messages` precisa ler
  `conversations`, que por sua vez tem RLS — sem `DEFINER` a subconsulta é filtrada
  recursivamente e o resultado fica errado (falso-negativo).
- **Tabelas satélite esquecidas são vazamento:** `messages`, `message_reactions`
  (035), `message_actions` (009), `contact_notes`, `notifications` (027) e o bucket de
  `chat-media` (023) todos referenciam a conversa. Se apenas `conversations` for
  endurecida, o agente lê o conteúdo pela tabela filha. **Checklist obrigatório no PR.**

---

### 🔴 F-02 — Race condition na reivindicação de conversa "Open" (CRÍTICO)

**Onde:** o único caminho de atribuição hoje é client-side, sem condição:
[message-thread.tsx:878-896](src/components/inbox/message-thread.tsx#L878-L896)

```ts
await supabase
  .from('conversations')
  .update({ assigned_agent_id: agentId })
  .eq('id', conversation.id);
```

**Cenário:** dois agentes clicam na mesma conversa da fila "Open" no mesmo instante.
Ambos os `UPDATE` passam (o segundo simplesmente sobrescreve o primeiro). Resultado:

1. Agente A vê "atribuída a mim", digita e envia uma resposta.
2. O `UPDATE` de B chega 40 ms depois; a conversa passa a ser de B.
3. A resposta de A já foi para o WhatsApp do cliente, mas A **perde o acesso à thread**
   no meio da digitação — e o cliente recebe duas saudações de agentes diferentes.
4. O trigger `on_conversation_assigned` ([027:115](supabase/migrations/027_notifications.sql#L115))
   dispara **duas** notificações contraditórias.

**Mitigação:** claim atômico via RPC com _compare-and-set_, nunca `UPDATE` direto:

```sql
CREATE OR REPLACE FUNCTION claim_conversation(conv_id UUID)
RETURNS conversations LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE result conversations;
BEGIN
  UPDATE conversations
     SET assigned_agent_id = auth.uid(), updated_at = NOW()
   WHERE id = conv_id
     AND assigned_agent_id IS NULL   -- ← a condição É o lock
  RETURNING * INTO result;

  IF NOT FOUND THEN
    -- Já reivindicada. Se fui eu mesmo, é idempotente (retry / duplo clique).
    SELECT * INTO result FROM conversations WHERE id = conv_id;
    IF result.assigned_agent_id <> auth.uid() THEN
      RAISE EXCEPTION 'CONVERSATION_ALREADY_CLAIMED' USING ERRCODE = '55006';
    END IF;
  END IF;
  RETURN result;
END $$;
```

O `WHERE assigned_agent_id IS NULL` faz o Postgres serializar as duas transações na
mesma linha: a segunda espera o commit da primeira, reavalia o predicado, encontra 0
linhas e falha. **Um único vencedor, garantido pelo banco.** O front trata
`CONVERSATION_ALREADY_CLAIMED` como estado normal (toast "Esta conversa acabou de ser
atendida por {nome}" + remove da lista), não como erro.

**Caso derivado:** o botão de envio do composer deve ficar desabilitado enquanto o
claim está em voo (`isClaiming`). Sem isso, o agente perdedor consegue disparar a
mensagem antes de descobrir que perdeu a corrida.

---

### 🔴 F-03 — Escalada de privilégio na reatribuição (CRÍTICO)

**Requisito:** _"apenas o agente atribuído ou um Admin podem reatribuir"_.

**Onde:** `conversations_update` ([017:416](supabase/migrations/017_account_sharing.sql#L416)) é
`is_account_member(account_id, 'agent')` — **qualquer** agente pode escrever qualquer
coluna de qualquer conversa, inclusive `assigned_agent_id`. E o dropdown de atribuir
([message-thread.tsx:1062-1123](src/components/inbox/message-thread.tsx#L1062-L1123)) não tem
nenhuma gate de papel.

**Cenário:** agente malicioso B roda um `UPDATE` roubando para si a carteira inteira de
A, ou (pior) atribui as conversas de A para um `viewer` inerte, sabotando o SLA.

**Mitigação:** policy de `UPDATE` com `WITH CHECK`, mais o RPC dedicado.

```sql
DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent') AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'agent') AND (
      assigned_agent_id = auth.uid()                 -- claim / manter comigo
      OR is_account_member(account_id, 'admin')      -- admin move para quem quiser
      OR assigned_agent_id IS NULL                   -- devolver à fila
    )
  );
```

> **`USING` vs `WITH CHECK` — a pegadinha:** `USING` decide _quais linhas posso tocar_;
> `WITH CHECK` decide _como a linha pode ficar depois_. Só com `USING`, o agente dono
> conseguiria transferir a conversa para um terceiro arbitrário — que é exatamente o que
> o requisito proíbe fora do caso Admin.

**Validação extra necessária no RPC de reatribuição:** o `assigned_agent_id` de destino
tem de ser um `profiles.user_id` **da mesma conta**. Sem isso, um Admin (ou um payload
forjado) atribui a conversa a um UUID de outra conta e a linha some para todos —
a coluna **não tem FK** hoje. Ver §5, passo 1.

---

### 🟠 F-04 — Vazamento de dados na transição de estado (Realtime)

**Onde:** [use-realtime.ts:42-83](src/hooks/use-realtime.ts#L42-L83) — canal `postgres_changes`
sem filtro, escutando `messages` e `conversations` inteiras.

O Supabase aplica a policy de `SELECT` por assinante nos eventos `postgres_changes`,
então a RLS nova **corta o fluxo automaticamente**. O problema é o inverso:

**Cenário A — estado obsoleto (leitura persistente).** Agente A está com a conversa X
aberta. Um Admin reatribui X para B. O `UPDATE` já **não passa** na policy de A, logo A
**não recebe evento nenhum**. O React de A continua com `activeConversation = X` e a
thread renderizada na tela — e `messages` continua no `useState`. A perde o acesso ao
_banco_, mas a _tela_ segue exibindo o histórico até um F5.
→ **Mitigação:** ao receber qualquer evento (ou no `resyncToken`), reconciliar por
_ausência_: se a conversa ativa não voltar no refetch, limpar `activeConversation`,
`messages`, `activeContact` e mostrar "Esta conversa foi reatribuída". Nunca confiar
apenas em eventos `UPDATE` para revogação — **revogação é silêncio, não evento.**

**Cenário B — eventos DELETE.** O Supabase **não aplica RLS a payloads de `DELETE`**
(entrega só a PK). Isso não vaza conteúdo aqui (só o UUID), mas o handler
não deve inferir existência a partir disso.

**Cenário C — o refetch de segurança.** `resyncToken` é bumpado em reconexão de WS e em
`visibilitychange` ([page.tsx:357-385](<src/app/(dashboard)/inbox/page.tsx#L357-L385>)). Esse refetch
tem de respeitar a aba ativa; caso contrário reintroduz na memória do cliente as linhas
que a aba deveria ter descartado.

---

### 🟠 F-05 — `isAdmin` exclui o `owner` (armadilha de implementação)

**Onde:** [use-auth.tsx:93](src/hooks/use-auth.tsx#L93)

```ts
/** True if `accountRole === 'admin'` (does NOT include owner ...) */
isAdmin: boolean;
```

Escrever `if (isAdmin) showAllConversations()` deixa **o dono da conta sem acesso ao
próprio inbox**. O caminho correto no cliente é `canManageMembers` (admin+) ou uma nova
ação tipada `useCan('view-all-conversations')` em [use-can.ts](src/hooks/use-can.ts) — o
union `CanAction` é fechado, então adicionar a capacidade força o compilador a cobrir
todos os call sites. **Recomendado: adicionar a ação nova, não reaproveitar
`canManageMembers`** (semânticas distintas divergem depois).

---

### 🟠 F-06 — `viewer` e a aba "Chat"

Um `viewer` nunca é atribuído a nada (não pode responder — `canSendMessages` é agent+).
Com a policy nova, `assigned_agent_id = auth.uid()` nunca casa e a aba "Chat" fica
permanentemente vazia; a aba "Open" mostra a fila inteira porque
`assigned_agent_id IS NULL` é público. Resultado: **o `viewer` perde a visão de
supervisão que tem hoje** (ele enxerga tudo). Precisa de decisão (D5) — a opção mais
provável é tratar `viewer` como leitura ampla (predicado `OR is_account_member(account_id,'viewer') AND <somente SELECT>`),
o que **conflita** com o requisito literal "apenas o agente atribuído e Admins".

---

### 🟡 F-07 — Auto-atribuição implícita no envio (bypass do claim)

**Onde:** [/api/whatsapp/send/route.ts](src/app/api/whatsapp/send/route.ts) resolve/cria a conversa
e envia — **sem** tocar em `assigned_agent_id`. Com a regra nova, "quem responde assume"
tem de ser atômico _com_ o envio:

- A rota deve chamar `claim_conversation` **antes** de falar com a Meta.
- Se o claim falhar (`CONVERSATION_ALREADY_CLAIMED`) → **abortar com 409**, nunca enviar.
  A ordem inversa (enviar e depois atribuir) produz uma mensagem entregue ao cliente
  numa conversa que pertence a outro agente — irreversível, o WhatsApp já entregou.
- O envio a partir de `contact_id` (Contact detail, [send/route.ts:215-248](src/app/api/whatsapp/send/route.ts#L215-L248))
  cria a conversa; nesse caminho o `assigned_agent_id` deve nascer com `auth.uid()`.

---

### 🟡 F-08 — Interação com a IA (auto-reply)

[/api/ai/autoreply/[conversationId]/route.ts:75-84](src/app/api/ai/autoreply/[conversationId]/route.ts#L75-L84)
já escreve `assigned_agent_id` (take over = atribui a mim; resume = `= null`). Dois pontos:

- O `resume` **libera a atribuição de qualquer um** (`update.assigned_agent_id = null`
  incondicional). Sob as regras novas isso é uma reatribuição — precisa passar pelo
  mesmo gate de F-03 (dono ou admin), senão vira o _bypass_ mais fácil: "resume" para
  soltar a conversa de outro agente e "take over" para pegá-la.
- O bot responde em conversas **sem dono** (fila "Open"). Ele roda com service role e
  ignora RLS — comportamento correto, mas significa que a aba "Open" pode ter
  conversas já respondidas pela IA. Sinalizar isso no item da lista.

---

### 🟡 F-09 — Webhook / service role

[whatsapp/webhook/route.ts:30](src/app/api/whatsapp/webhook/route.ts#L30) usa
`SUPABASE_SERVICE_ROLE_KEY` — **bypassa RLS por design** e cria conversas com
`assigned_agent_id` nulo (fila "Open"). Correto e não deve mudar. **Verificar apenas**
que a chave nunca é importada por componente cliente (o import atual está dentro de
`app/api/`, ok) e que o webhook não passa a repassar o assignee em payloads públicos.

---

### 🟡 F-10 — Diretório de contatos (aba 3): sem coluna, sem RLS possível

`contacts` ([001:36-52](supabase/migrations/001_initial_schema.sql#L36-L52)) tem `user_id`
(auditoria de quem criou) e `account_id` (tenancy), **nada de responsável**. Além disso
`contacts.user_id` foi explicitamente aposentado como mecanismo de isolamento pela
migração 017. Filtrar a lista por `user_id` no cliente seria **falso isolamento** —
`contacts_select` continua `is_account_member(account_id)`.

Some-se a isso: a página de contatos existente usa o RPC
`filter_contacts_by_tags` (`SECURITY INVOKER`, [025](supabase/migrations/025_filter_contacts_by_tags.sql#L33-L42)).
Se a RLS de `contacts` for endurecida, esse RPC herda o filtro (bom) — mas o `total_count`
que ele devolve muda, e a paginação da página `/contacts` precisa ser retestada.

**Sem uma decisão em D2, a aba 3 não é implementável com segurança.**

---

### 🟡 F-11 — Enumeração via deep-link `?c=<id>`

Com a RLS nova, `/inbox?c=<id-de-outro-agente>` retorna 0 linhas e a auto-seleção
([page.tsx:405-438](<src/app/(dashboard)/inbox/page.tsx#L405-L438>)) simplesmente não encontra o match
— **fail-closed, correto**. Cuidado apenas para que a mensagem de erro seja genérica
("Conversa não encontrada"), e não "Você não tem permissão para esta conversa", que
confirmaria a existência do recurso.

---

### 🟡 F-12 — Notificações e contadores agregados

- `notifications` (027) já é por destinatário; o trigger `on_conversation_assigned`
  passa a disparar em _todo_ claim. Com a auto-atribuição do F-07, isso gera uma
  notificação para o próprio agente que acabou de assumir → **ruído**. O trigger deve
  ignorar `NEW.assigned_agent_id = auth.uid()`.
- [use-total-unread.ts](src/hooks/use-total-unread.ts) conta não lidas para o badge da sidebar.
  Sob RLS por linha o número muda por agente — verificar se a query respeita a nova
  policy (respeita, se for PostgREST) e se o produto quer "minhas não lidas" ou
  "minhas + fila".

---

## 3. Fluxo de dados e arquitetura

### 3.1 Estado das abas

```ts
type TabId = 'chat' | 'open' | 'contacts';

interface TabFilters {
  search: string;
  statusFilter: InboxFilter; // só usado em 'open'
  selectedTagIds: string[];
  selectedCompany: string | null;
}
```

- **Fonte de verdade da aba: a URL** (`/inbox?tab=chat&c=<id>`), via `useSearchParams` +
  `router.replace(..., { scroll: false })` — mesmo padrão já usado para `?c=`
  ([page.tsx:478](<src/app/(dashboard)/inbox/page.tsx#L478>)). Ganha-se refresh estável,
  compartilhamento de link e botão "voltar" coerente. `useState` local perderia a aba a
  cada re-render de navegação.
- **Filtros: `Record<TabId, TabFilters>` em memória**, não na URL (poluiria o link).
  Trocar de aba preserva; recarregar a página reseta — comportamento aceitável e
  consistente com o `localStorage` já usado só para o painel de contato
  ([page.tsx:29](<src/app/(dashboard)/inbox/page.tsx#L29>)).

### 3.2 Cache por aba (não perder dados ao alternar)

```ts
const [feeds, setFeeds] = useState<Record<'chat'|'open', Conversation[]>>({ chat: [], open: [] });
const [fetchedAt, setFetchedAt] = useState<Record<'chat'|'open', number|null>>(...);
```

- Cada aba faz **seu próprio fetch com predicado de servidor** (não filtra o array da
  outra): `chat` → `.eq('assigned_agent_id', user.id)`; `open` → `.is('assigned_agent_id', null)`.
  Filtrar no cliente um array que veio do outro predicado dá contagens erradas na
  primeira renderização e mantém em memória linhas que a aba não deveria ter.
- Fetch **lazy + cacheado**: a aba só busca na primeira visita ou quando
  `resyncToken` muda. Alternar aba não refaz a rede.
- **`activeConversation` vive fora dos caches** — é estado global da página. Assim,
  clicar em "Chat", abrir a conversa X, ir em "Contacts" e voltar mantém X aberta e as
  `messages` carregadas (o `MessageThread` só refaz o fetch quando `conversationId`
  muda — ver o comentário em [page.tsx:443-449](<src/app/(dashboard)/inbox/page.tsx#L443-L449>)).

### 3.3 Transição de aba após o claim (o caso mais delicado)

Quando o agente reivindica uma conversa da aba "Open", ela **sai da "Open" e entra na
"Chat"** — enquanto ele está com ela aberta na tela.

Sequência prescrita:

```
1. clique → optimistic: marcar item como "claiming" (spinner, item bloqueado)
2. rpc('claim_conversation', { conv_id })
3a. sucesso → mover a linha de feeds.open para feeds.chat
             → setActiveTab('chat')   [a thread permanece aberta, sem remount]
             → router.replace('/inbox?tab=chat&c=' + id)
3b. 55006  → remover de feeds.open, toast "já atendida por {nome}", NÃO abrir a thread
4. o evento realtime do UPDATE chega depois e converge (idempotente)
```

**Não** fazer `setActiveConversation(null)` na troca de aba: isso desmontaria a thread e
zeraria `messages` — exatamente o bug já documentado nas linhas 411-419 do `page.tsx`.

### 3.4 Realtime sob o novo modelo

O canal continua único. O que muda é o roteamento do evento para o cache certo:

| Evento                                                | Ação                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `INSERT` conversation (`assigned_agent_id` nulo)      | entra em `feeds.open`                                                                  |
| `UPDATE` com `old.assigned = null → new.assigned = X` | remove de `feeds.open`; se `X === user.id`, entra em `feeds.chat`                      |
| `UPDATE` com `new.assigned` ≠ eu e não sou admin      | **não chega** (RLS) → tratar por ausência no resync (F-04)                             |
| `INSERT` message                                      | patch de preview no cache que contiver a conversa; se em nenhum, `hydrateConversation` |

`knownConvIdsRef` ([page.tsx:112](<src/app/(dashboard)/inbox/page.tsx#L112>)) passa a ser um
`Map<convId, TabId>` — o handler precisa saber _em qual cache_ a conversa está,
sincronamente, pelo mesmo motivo já documentado nas linhas 100-111.

---

## 4. Modelo de dados (migração proposta)

```sql
-- supabase/migrations/039_conversation_assignment.sql (idempotente, como as demais)

-- 1. FK + índices (a coluna existe desde 001, sem nenhum dos dois)
ALTER TABLE conversations
  ADD CONSTRAINT conversations_assigned_agent_id_fkey
  FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id) ON DELETE SET NULL;
--    ^ ON DELETE SET NULL: agente desligado devolve a carteira à fila "Open",
--      em vez de apagar as conversas em cascata.

CREATE INDEX IF NOT EXISTS idx_conversations_assigned
  ON conversations(account_id, assigned_agent_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_unassigned
  ON conversations(account_id, last_message_at DESC)
  WHERE assigned_agent_id IS NULL;   -- índice parcial: a fila "Open" é a query quente

-- 2. can_access_conversation()      (§2, F-01)
-- 3. policies conversations_select / _update  (F-01, F-03)
-- 4. policies messages_select / _modify + satélites (F-01)
-- 5. claim_conversation() / reassign_conversation() (F-02, F-03)
-- 6. ajuste do trigger notify_conversation_assigned (F-12)
```

**Backfill:** conversas existentes ficam com `assigned_agent_id` nulo → todas caem na
aba "Open" no dia do deploy. Isso é a migração menos surpreendente, mas significa que
**no primeiro dia a aba "Chat" de todo mundo estará vazia**. Alternativa (D6): backfill
por "último agente que enviou mensagem na thread" —
`SELECT DISTINCT ON (conversation_id) sender_id FROM messages WHERE sender_type='agent' ORDER BY conversation_id, created_at DESC`.

---

## 5. Plano de ação (roteiro de deploy)

Ordem importa: **banco antes do front**. A RLS nova é compatível com a UI antiga
(a UI antiga simplesmente passa a ver menos linhas), mas a UI nova **quebra** sem a RLS.

### Fase 1 — Banco (PR isolado, deploy independente)

| #   | Arquivo                                               | Ação                                                                                                                                                                                         |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | `supabase/migrations/039_conversation_assignment.sql` | **novo** — FK, 2 índices, `can_access_conversation()`, policies de `conversations`/`messages`/satélites, `claim_conversation()`, `reassign_conversation()`, ajuste do trigger de notificação |
| 1.2 | —                                                     | Rodar `get_advisors` (security + performance) após aplicar                                                                                                                                   |
| 1.3 | —                                                     | Testes manuais de RLS: `curl` direto ao PostgREST com JWT de agent / admin / owner / viewer (§2 §2.1)                                                                                        |

### Fase 2 — Servidor

| #   | Arquivo                                                                                                  | Ação                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 2.1 | `src/app/api/inbox/conversations/[id]/claim/route.ts`                                                    | **novo** — `POST`, `requireRole('agent')`, chama `claim_conversation`, mapeia `55006` → **409** |
| 2.2 | `src/app/api/inbox/conversations/[id]/assign/route.ts`                                                   | **novo** — `POST`, valida destino na mesma conta, gate dono-ou-admin                            |
| 2.3 | [src/app/api/whatsapp/send/route.ts](src/app/api/whatsapp/send/route.ts)                                 | claim **antes** do envio; 409 aborta (F-07)                                                     |
| 2.4 | [src/app/api/ai/autoreply/[conversationId]/route.ts](src/app/api/ai/autoreply/[conversationId]/route.ts) | aplicar o gate de reatribuição ao `resume` (F-08)                                               |
| 2.5 | [src/lib/auth/roles.ts](src/lib/auth/roles.ts)                                                           | novo predicado `canViewAllConversations(role)` (admin+)                                         |

### Fase 3 — Cliente

| #    | Arquivo                                                                                  | Ação                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `src/lib/inbox/tabs.ts`                                                                  | **novo** — `TabId`, predicados de fetch, `TAB_DEFINITIONS`                                                                                                                                                           |
| 3.2  | `src/hooks/use-inbox-tabs.ts`                                                            | **novo** — aba ativa ↔ URL, filtros por aba                                                                                                                                                                          |
| 3.3  | `src/hooks/use-conversation-feed.ts`                                                     | **novo** — fetch por aba, cache, roteamento de realtime                                                                                                                                                              |
| 3.4  | `src/components/inbox/inbox-tabs.tsx`                                                    | **novo** — barra das 3 abas (a 3ª só ícone + `aria-label`)                                                                                                                                                           |
| 3.5  | `src/components/inbox/contacts-directory.tsx`                                            | **novo** — aba 3 (busca + paginação; reusar `filter_contacts_by_tags`)                                                                                                                                               |
| 3.6  | [src/components/inbox/conversation-list.tsx](src/components/inbox/conversation-list.tsx) | **refactor** — remover fetch (101-135) e `onConversationsLoaded`; virar apresentação pura; dropdown de status só na aba "Open"                                                                                       |
| 3.7  | [src/app/(dashboard)/inbox/page.tsx](<src/app/(dashboard)/inbox/page.tsx>)               | **refactor** — orquestrar abas, cache duplo, reconciliação por ausência (F-04)                                                                                                                                       |
| 3.8  | [src/components/inbox/message-thread.tsx](src/components/inbox/message-thread.tsx)       | trocar o `UPDATE` direto (878-896) pela rota 2.2; esconder o dropdown de atribuir para não-dono/não-admin                                                                                                            |
| 3.9  | [src/hooks/use-can.ts](src/hooks/use-can.ts)                                             | nova `CanAction: 'view-all-conversations'` \| `'reassign-conversation'`                                                                                                                                              |
| 3.10 | [src/hooks/use-realtime.ts](src/hooks/use-realtime.ts)                                   | (provável) expor o `payload.old` completo para detectar transição de assignee                                                                                                                                        |
| 3.11 | `messages/pt-BR.json`, `messages/en.json`                                                | namespace `Inbox.tabs.*` + strings de erro do claim (D4)                                                                                                                                                             |
| 3.12 | `src/types/index.ts`                                                                     | `assigned_agent_id` de `string \| undefined` → `string \| null` (o banco usa `null`; o código já converte com `?? undefined` em [page.tsx:533](<src/app/(dashboard)/inbox/page.tsx#L533>) — inconsistência a limpar) |

### Fase 4 — Testes

| #   | Alvo                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| 4.1 | `src/lib/inbox/tabs.test.ts` — predicados de aba (Vitest, padrão do repo)                                               |
| 4.2 | Teste de concorrência do `claim_conversation` (2 sessões simultâneas → exatamente 1 vencedor)                           |
| 4.3 | Matriz de RLS: {owner, admin, agent-dono, agent-outro, viewer} × {conversa atribuída, não atribuída} × {SELECT, UPDATE} |
| 4.4 | Regressão: deep-link `?c=`, reset de `unread_count`, resync por reconexão/visibilidade                                  |

---

## 6. Decisões pendentes (bloqueiam a implementação)

| #      | Questão                                                                                                                                                                                                                                                         | Impacto                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | Aba "Open" = `assigned_agent_id IS NULL` ou `status = 'open'`? O enunciado diz "não atribuídas (badge verde)", mas o badge verde hoje é `status='open'` ([conversation-list.tsx:41](src/components/inbox/conversation-list.tsx#L41)). São conjuntos diferentes. | Define o predicado central. **Recomendação: `assigned_agent_id IS NULL`**, e o `status` vira filtro _dentro_ da aba.                       |
| **D2** | Aba "Contacts": como um contato é "atribuído a um agente"? Nova coluna `contacts.assigned_agent_id`? Ou derivado ("tenho ao menos uma conversa com este contato")?                                                                                              | **Recomendação: derivado**, via view/RPC — evita nova coluna + UI de atribuição de contatos, e casa naturalmente com o modelo de conversa. |
| **D3** | Na aba "Chat", o filtro de status (`Todas/Não lidas/Abertas/Pendentes/Encerradas`) aparece?                                                                                                                                                                     | O enunciado só o ancora na "Open".                                                                                                         |
| **D4** | Rótulos literais `"Chat"` e `"Open"` mesmo em PT-BR, ou traduzidos (`"Chat"` / `"Fila"`)?                                                                                                                                                                       | Strings de i18n; "Open" em PT-BR conflita com "Abertas".                                                                                   |
| **D5** | O `viewer` perde a visão global do inbox? (F-06)                                                                                                                                                                                                                | Sob a regra literal, sim. Pode quebrar o uso de supervisão.                                                                                |
| **D6** | Backfill: tudo para a fila, ou inferir dono pelo último agente que respondeu?                                                                                                                                                                                   | "Tudo para a fila" esvazia a aba "Chat" no dia 1.                                                                                          |
| **D7** | Admin vê "todas" na aba "Chat" (fica ilegível em contas grandes) ou tem um seletor "ver como: {agente}"?                                                                                                                                                        | UX + performance da query.                                                                                                                 |

---

## 7. Riscos e critérios de aceite

**Riscos**

- **Performance:** `can_access_conversation` roda por linha em `messages`. Com o índice
  parcial e `STABLE` o planner cacheia dentro da query, mas threads longas devem ser
  medidas antes do deploy (`EXPLAIN ANALYZE` em uma conta real).
- **RLS quebrando o que já funciona:** dashboard, pipelines, broadcasts e automações
  também leem `conversations`. Endurecer o `SELECT` pode zerar métricas de agregação —
  auditar todo `from('conversations')` do repo (há ocorrências em `dashboard`,
  `notifications`, `automations/engine`, `flows`).
- **API pública v1** (`/api/v1/conversations`) usa API keys, não JWT de usuário —
  verificar sob qual identidade roda e se a nova RLS a afeta.

**Critérios de aceite (segurança)**

1. `curl` direto ao PostgREST com JWT de agente não-dono retorna **0 linhas** para
   conversa alheia — e **0 mensagens** dela.
2. Dois claims simultâneos → exatamente 1 sucesso, 1 × HTTP 409.
3. Agente não-dono recebe 403 ao tentar `assigned_agent_id` de terceiro; Admin **e**
   Owner recebem 200.
4. Reatribuição enquanto a vítima está com a thread aberta → a tela dela limpa em até
   um ciclo de resync, sem exigir F5.
5. Nenhum papel consegue atribuir uma conversa a um `user_id` de outra conta.
