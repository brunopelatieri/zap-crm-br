# SPEC 043 — Quadro de Atribuição (Team View) no Inbox

**Status:** ✅ Implementado — validado manualmente em 2026-08-06
**Módulo:** `src/components/inbox/assignment-board`
**Data:** 2026-08-05 (implementação: 2026-08-06)
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Referências de padrão:** [spec-inbox-kanban-integration.md](spec-inbox-kanban-integration.md) · [spec-042-supervisao-e-escopo-de-contatos.md](spec-042-supervisao-e-escopo-de-contatos.md) · [spec-041-atribuicao-fora-do-inbox.md](spec-041-atribuicao-fora-do-inbox.md)

> ⚠️ **Esta feature NÃO é o CRM.** O funil de vendas já existe em
> [`src/components/pipelines/`](../src/components/pipelines/) e opera sobre `deals`.
> Este quadro opera sobre `conversations`: as **colunas são pessoas**, não etapas
> de funil. O funil/etapa do contato aparece apenas como **badge somente-leitura**.
> A §3 lista os invariantes que impedem os dois módulos de se entrelaçarem.

> **Quem pode fazer o quê (resumo):**
>
> | Ação                                     | Role mínima     | Onde                                     |
> | ---------------------------------------- | --------------- | ---------------------------------------- |
> | **Ver** a aba "Time"                     | `admin`         | Barra de abas do Inbox                   |
> | Arrastar card entre colunas (reatribuir) | `admin`         | Quadro                                   |
> | Arrastar da fila para si mesmo           | `admin`         | Quadro (rota `/claim` — ver §5.1)        |
> | Devolver card à fila (desatribuir)       | `admin`         | Quadro                                   |
> | Ver funil/etapa do contato               | qualquer membro | Badge do card (read-only)                |
> | Editar funil/etapa                       | `agent`         | Fora de escopo — `/pipelines`            |
>
> A aba **não é renderizada** para `agent` e `viewer`. Não é uma escolha de
> produto: é a consequência direta da RLS da migração 039 — ver §2.1, que é a
> seção que decide o desenho inteiro desta feature.

---

## 1. Contexto e escopo

### 1.1 O problema

A atribuição de conversas hoje acontece em três lugares dispersos e sempre
**uma conversa por vez**:

1. Botão "Assumir" na fila — [conversation-list.tsx:594-614](../src/components/inbox/conversation-list.tsx#L594-L614);
2. Dropdown de atribuição no header da thread — [message-thread.tsx:1165-1231](../src/components/inbox/message-thread.tsx#L1165-L1231);
3. "Assumir" do banner de IA — [ai-thread-banner.tsx](../src/components/inbox/ai-thread-banner.tsx).

Nenhum deles responde à pergunta de supervisão **"como está distribuída a
carteira do time agora?"**, nem permite rebalancear. O seletor "ver como" da
SPEC 042 chegou perto — mostra a carteira de **um** agente por vez — mas obriga
o supervisor a trocar de alvo repetidamente para formar a visão do conjunto.

### 1.2 O que esta feature entrega

Uma **4ª aba no Inbox** (após "Fila"), com um quadro Kanban onde:

- a **primeira coluna** é sempre a fila de conversas sem dono;
- cada **coluna seguinte** é um membro atribuível da conta, com as conversas dele;
- cada **card** é uma conversa, mostrando nome do contato, trecho da última nota,
  etiquetas e o badge read-only de funil › etapa;
- **arrastar** um card entre colunas grava `conversations.assigned_agent_id`.

### 1.3 O que já existe (e é reusado sem alteração)

Esta feature **não cria modelo de dados, não altera RLS e não cria rota**.
Tudo o que ela precisa do backend já foi entregue pela migração 039 e pela
SPEC 041.

| Peça existente                        | Localização                                                                                                              | Papel aqui                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `conversations.assigned_agent_id`     | [001](../supabase/migrations/001_initial_schema.sql) + FK/índices na [039:109-126](../supabase/migrations/039_conversation_assignment.sql#L109-L126) | A coluna que o drop escreve                  |
| RPC `claim_conversation`              | [039:457](../supabase/migrations/039_conversation_assignment.sql#L457)                                                    | Lock atômico ao puxar da fila (§5.1)         |
| RPC `reassign_conversation`           | [039:519](../supabase/migrations/039_conversation_assignment.sql#L519)                                                    | Reatribuição e devolução à fila              |
| `claimConversation` / `reassignConversation` | [src/lib/inbox/assignment.ts](../src/lib/inbox/assignment.ts)                                                       | Wrapper + `mapError` SQLSTATE→HTTP           |
| `POST …/[id]/claim` e `…/[id]/assign` | [claim/route.ts](<../src/app/api/inbox/conversations/[id]/claim/route.ts>) · [assign/route.ts](<../src/app/api/inbox/conversations/[id]/assign/route.ts>) | **Rotas reusadas sem uma linha de mudança**  |
| `useAccountMembers()`                 | [src/hooks/use-account-members.ts:34](../src/hooks/use-account-members.ts#L34)                                            | Roster das colunas                           |
| `usePresence()` + `PresenceDot`       | [use-presence.ts:45](../src/hooks/use-presence.ts#L45) · [presence-dot.tsx](../src/components/presence/presence-dot.tsx)  | Estado online/ausente no cabeçalho da coluna |
| `useRealtime()`                       | [src/hooks/use-realtime.ts](../src/hooks/use-realtime.ts)                                                                 | Canal `postgres_changes`                     |
| `normalizeConversation()`             | [src/lib/inbox/conversations.ts](../src/lib/inbox/conversations.ts)                                                       | Achata `contact_tags → contact.tags`         |
| `TAB_DEFINITIONS` / `InboxTabs`       | [tabs.ts:43](../src/lib/inbox/tabs.ts#L43) · [inbox-tabs.tsx](../src/components/inbox/inbox-tabs.tsx)                     | Barra de abas                                |
| Padrão DnD `@dnd-kit`                 | [pipeline-board.tsx:58-98](../src/components/pipelines/pipeline-board.tsx#L58-L98)                                        | Referência de sensores/colisão — **copiado, não importado** (§3.1) |

**Nenhuma dependência nova.** `@dnd-kit/core` 6.3.1 já está no `package.json`.

**Nenhuma migração.** Note que no repo os números de SPEC e de migração vinham
pareados (039↔039, 041↔041, 042↔042). Aqui a série se rompe de propósito:
**não existe migração 043**, e a ausência é o principal indício de que a camada
de escrita da 039 foi desenhada certa — uma superfície de UI inteiramente nova
cabe sobre ela sem nenhuma concessão.

### 1.4 Fora de escopo

- **Editar deal, etapa ou funil** a partir do quadro. O badge é estritamente
  read-only (§6.3); editar continua em `/pipelines`.
- **Reordenar cards dentro da coluna.** `conversations` não tem coluna de
  posição — a mesma limitação que a §2.3 da SPEC de Kanban registrou para
  `deals`. A ordem é sempre `last_message_at DESC`.
- **Atribuição em lote por multi-seleção.** Registrado como pendência (§9).
- **DnD por toque em telas pequenas.** O quadro renderiza no mobile, mas a
  operação confiável é desktop — ver §7 e a pendência correspondente.
- **Relaxar a RLS** para que agentes vejam a carteira dos colegas. Seria uma
  reversão do isolamento por atribuição que as migrações 039/041 protegem
  (a [041](../supabase/migrations/041_assert_039_intact.sql) existe justamente
  como tripwire contra isso). Descartado explicitamente na análise.

---

## 2. Restrições descobertas na análise

### 2.1 A RLS é quem define o público da feature

```sql
-- supabase/migrations/039_conversation_assignment.sql:250
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );
```

Consequência dupla — e é ela, não uma preferência de produto, que fecha a
decisão de gating:

**(a) Um `agent` não consegue LER as conversas dos colegas.** Renderizar o
quadro para ele produziria colunas vazias **sem nenhum erro** — o pior modo de
falha possível, porque parece um dado ("o João não tem nada") em vez de uma
restrição. Note que o `PostgREST` não devolve 403 aqui: a policy simplesmente
filtra as linhas.

**(b) O DnD falharia mesmo se ele visse as colunas.** O
`reassign_conversation` levanta `ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS`
([039:555](../supabase/migrations/039_conversation_assignment.sql#L555))
para quem não é admin.

Gate a usar — sempre pelos predicados de
[`roles.ts`](../src/lib/auth/roles.ts), nunca comparando strings de role inline:

```ts
const canSeeBoard = useCan('view-all-conversations'); // canViewAllConversations → admin+
```

`useCan` já devolve `false` enquanto `profileLoading` é `true`
([use-can.ts](../src/hooks/use-can.ts)), então não há flash de "você pode!"
para um agente. **Não** usar `useAuth().isAdmin`: aquele flag é estritamente
`role === 'admin'` e exclui o `owner` — nota explícita em
[roles.ts:110](../src/lib/auth/roles.ts#L110).

### 2.2 Colunas só para papéis atribuíveis

Filtrar o roster por `ASSIGNABLE_ACCOUNT_ROLES`
([roles.ts:146](../src/lib/auth/roles.ts#L146) — `owner | admin | agent`).

Um `viewer` renderizado como coluna seria uma armadilha visual: o supervisor
arrastaria o card e receberia `INVALID_ASSIGNEE` (400,
[039:566](../supabase/migrations/039_conversation_assignment.sql#L566)) sem
nenhuma pista prévia de que aquela coluna não aceitava drops. Melhor não
existir.

### 2.3 Não existe `profiles.is_active`

O pedido fala em "usuários ativos do sistema", mas **não há flag de atividade em
`profiles`**. `is_active` existe só em tabelas não relacionadas (`automations`,
`webhook_endpoints`, `ai_config`).

O único sinal de liveness é a tabela `member_presence` (migração 024). Desenho
adotado: renderizar **todos** os membros atribuíveis e usar
[`usePresence()`](../src/hooks/use-presence.ts#L45) +
[`PresenceDot`](../src/components/presence/presence-dot.tsx) no cabeçalho da
coluna para indicar online / ausente / offline — exatamente o que
[members-tab.tsx](../src/components/settings/members-tab.tsx) já faz no roster
de Configurações.

Esconder colunas de quem está offline seria pior: a carteira do agente **não
desaparece quando ele fecha o navegador**, e uma coluna sumindo levaria junto
as conversas dele da visão do supervisor.

### 2.4 Não existe funil/etapa no contato

O vínculo é `contacts → deals → pipeline_stages → pipelines`, e um contato pode
ter **N deals em N funis** — não há escalar "etapa atual". Ver
[contact-sidebar.tsx:63-75](../src/components/inbox/contact-sidebar.tsx#L63-L75),
que lista todos os deals do contato justamente porque não há um "o" deal.

Por isso a regra de qual deal mostrar (§4.4) precisa ser uma **decisão
declarada**, não um join óbvio.

### 2.5 `contacts` não tem coluna `notes`

O "trecho de notas" pedido no card vem do registro mais recente de
`contact_notes.note_text` (tabela criada em
[001](../supabase/migrations/001_initial_schema.sql)).

Cuidado com a ambiguidade já registrada no repo: **`deals.notes`** (texto livre
no negócio) e **`contact_notes.note_text`** (log de notas por contato) são
coisas diferentes. O card mostra a segunda.

### 2.6 `conversations` roda com `REPLICA IDENTITY DEFAULT`

No evento realtime de `UPDATE`, o payload `old` traz **apenas a PK** — é
impossível descobrir de qual coluna o card saiu olhando o evento. A restrição
está documentada em [use-realtime.ts:11-27](../src/hooks/use-realtime.ts#L11-L27)
e é o motivo de `inbox/page.tsx` manter o próprio `convTabMapRef`.

O quadro precisa da mesma construção: um `Map<conversationId, columnId>` em ref
(§4.6). Registrar como restrição de arquitetura, não como detalhe de
implementação — quem tentar derivar o movimento do payload vai escrever um bug
silencioso.

### 2.7 O rate limit das rotas é atingível por uso normal

Ambas as rotas usam `RATE_LIMITS.send` com chave `inbox-assign:{userId}` /
`inbox-claim:{userId}`. Um supervisor rebalanceando a carteira do time —
o caso de uso central desta feature — arrasta dezenas de cards em sequência e
**vai** bater no limite. O 429 precisa de tratamento próprio (§5.3), não do
toast genérico.

---

## 3. Arquitetura de componentes — separação do CRM

### 3.1 Invariantes de não-entrelaçamento

Pasta nova e estanque: **`src/components/inbox/assignment-board/`**. As cinco
regras abaixo são o contrato desta seção e reaparecem nos critérios de aceite
(§10):

1. **Nenhum arquivo de `assignment-board/` importa de
   `src/components/pipelines/`.** Nada de reusar `DealCard`, `PipelineBoard` ou
   `StageColumn`: eles são tipados em `Deal` / `PipelineStage` e carregam
   semântica de valor e moeda (`formatCurrency`, `totalValue`,
   `useAuth().defaultCurrency`) que aqui não significa nada — a soma dos valores
   de uma coluna de agente não é uma métrica.

2. **Nenhum arquivo de `src/components/pipelines/` importa de
   `assignment-board/`.** A dependência não pode existir em nenhuma direção.

3. **O quadro é somente-leitura sobre `deals` / `pipelines` /
   `pipeline_stages`.** Só `SELECT`. Nenhum `INSERT`, `UPDATE` ou `DELETE`
   nessas três tabelas parte deste módulo — verificável na aba Network.

4. **Vocabulário separado.** Nesta pasta, "coluna" é um **agente** e "card" é
   uma **conversa**. Nenhum identificador chamado `stage`, `deal` ou `pipeline`,
   exceto os do badge read-only, que são prefixados (`primaryDeal`,
   `dealBadge`, `pickPrimaryDeal`) justamente para se destacarem como o único
   ponto de contato com o outro domínio.

5. **Não extrair uma abstração "Kanban genérica".** O que os dois boards
   compartilham são ~15 linhas de configuração de sensores do `@dnd-kit`.
   Copiar sai mais barato que um componente genérico sobre dois domínios sem
   nada em comum — o genérico teria que ser parametrizado em tipo de item, tipo
   de coluna, regra de drop, regra de contagem e regra de mutação, ou seja,
   tudo. Reavaliar apenas se surgir um terceiro board.

> **Reforço opcional, recomendado:** uma regra `no-restricted-imports` do
> ESLint com `patterns` cruzados entre as duas pastas trava os itens 1 e 2 no
> CI, para que o invariante não dependa de disciplina de revisão.

### 3.2 Por que copiar o padrão de DnD em vez de compartilhá-lo

O que é copiado de [pipeline-board.tsx](../src/components/pipelines/pipeline-board.tsx)
é conhecimento já validado em produção, e vale enumerar para não se perder na
cópia:

- `useSensor(PointerSensor, { activationConstraint: { distance: 5 } })` — os 5px
  são o que permite ao card ser clicável **e** arrastável
  ([pipeline-board.tsx:58-64](../src/components/pipelines/pipeline-board.tsx#L58-L64));
- `useSensor(KeyboardSensor)` — arrasto por teclado;
- `collisionDetection={closestCorners}`;
- `useDroppable({ id })` com o `ref` na **lista interna**, não na casca da
  coluna, para que passar sobre o cabeçalho não acenda a coluna inteira
  ([:232-238](../src/components/pipelines/pipeline-board.tsx#L232-L238));
- `style={{ touchAction: 'none' }}` no draggable — obrigatório no mobile
  ([:287](../src/components/pipelines/pipeline-board.tsx#L287));
- `DragOverlay` com `dropAnimation` de 200ms.

O que **não** é copiado: `SortableContext` (nenhum dos dois boards persiste
ordem dentro da coluna), `formatCurrency`, `totalValue`, e o rodapé
"adicionar" (não se cria conversa a partir do quadro).

### 3.3 Arquivos novos

| Arquivo                                                                | Responsabilidade                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/inbox/assignment-board.ts`                                    | **Módulo puro** — sem React, sem Supabase, testável isolado. Modelo de colunas (`UNASSIGNED_COLUMN_ID`, `buildBoardColumns`, `boardColumnIdToAgentId`, `pickPrimaryDeal`, `BOARD_CONVERSATION_SELECT`, `BOARD_PAGE_SIZE`) **e os redutores de estado** (`moveCard`, `restoreCard`, `settleCard`, `insertCard`, `removeCard`, `appendCards`, `applyColumnCounts`, `hydrateCards`) — ver §5.5. Mesma filosofia declarada no cabeçalho de [tabs.ts](../src/lib/inbox/tabs.ts). |
| `src/lib/inbox/assignment-board.test.ts`                               | Vitest para o modelo de colunas e para todos os redutores.                                                                                                                           |
| `.../assignment-board/assignment-board.tsx`                            | `DndContext`, sensores, `DragOverlay`, `announcements`, orquestração do drop. Recebe dados e callbacks por prop.                                                                      |
| `.../assignment-board/agent-column.tsx`                                | `useDroppable`; cabeçalho (avatar, nome, `PresenceDot`, contagem total), lista, "carregar mais", estado vazio.                                                                        |
| `.../assignment-board/conversation-card.tsx`                           | Card puro: nome, trecho de nota, etiquetas, badge de CRM. **Sem hooks de DnD e sem rede.**                                                                                            |
| `.../assignment-board/draggable-conversation-card.tsx`                 | Wrapper fino com `useDraggable`, espelhando `DraggableDealCard`.                                                                                                                      |
| `.../assignment-board/use-assignment-board.ts`                         | Toda a rede: colunas, cards, hidratação em 2 ondas, realtime, mutação otimista.                                                                                                       |

A divisão "componente puro + wrapper draggable" é a mesma de
`DealCard` / `DraggableDealCard`, e existe pelo mesmo motivo: o `DragOverlay`
precisa renderizar o card **sem** os listeners de arrasto.

### 3.4 Arquivos alterados

| Arquivo                                                              | Alteração                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/lib/inbox/tabs.ts](../src/lib/inbox/tabs.ts)                    | `TabId` ganha `'board'`; `TAB_IDS` e `TAB_DEFINITIONS` ganham a entrada **após `open`**; `TabDefinition` ganha `minRole?: AccountRole`; novas funções puras `visibleTabDefinitions(role)` e `resolveTab(raw, role)`. `isConversationTab` e `DEFAULT_TAB` **não mudam** (§3.5). |
| [src/lib/inbox/tabs.test.ts](../src/lib/inbox/tabs.test.ts)          | Casos novos: `resolveTab` degradando `board → DEFAULT_TAB` para agente/viewer/`null`; `visibleTabDefinitions` por papel; `isConversationTab('board') === false`.                                                                                                          |
| [inbox-tabs.tsx](../src/components/inbox/inbox-tabs.tsx)             | `TAB_ICONS` ganha `board`; nova prop opcional `tabs?: readonly TabDefinition[]` com default `TAB_DEFINITIONS` (§3.6).                                                                                                                                                     |
| [use-inbox-tabs.ts:77](../src/hooks/use-inbox-tabs.ts#L77)           | Trocar `isTabId(tabParam) ? tabParam : DEFAULT_TAB` por `resolveTab(tabParam, accountRole, profileLoading)`. O hook passa a receber o papel (§3.7).                                                                                                                       |
| [inbox/page.tsx](<../src/app/(dashboard)/inbox/page.tsx>)            | Passa `tabs={visibleTabDefinitions(accountRole)}` ao `InboxTabs`; novo branch de render `activeTab === 'board'`, no mesmo lugar em que `contacts` já se ramifica.                                                                                                          |
| `messages/pt-BR.json`, `messages/en.json`                            | `Inbox.tabs.board` + namespace `Inbox.assignmentBoard` (§8).                                                                                                                                                                                                              |

### 3.5 Mudanças em `tabs.ts`

```ts
export type ConversationTabId = 'chat' | 'open';
export type TabId = ConversationTabId | 'contacts' | 'board';

export const TAB_IDS: readonly TabId[] = ['chat', 'open', 'contacts', 'board'] as const;

export interface TabDefinition {
  id: TabId;
  labelKey: string;
  /**
   * Papel mínimo para a aba SEQUER APARECER. Ausente = todos os
   * membros. Isto NÃO é controle de acesso — a regra real continua na
   * RLS da 039 (ver cabeçalho deste arquivo); é só o que decide o que
   * renderizar, para não oferecer uma aba que voltaria vazia.
   */
  minRole?: AccountRole;
}

export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { id: 'chat', labelKey: 'chat' },
  { id: 'open', labelKey: 'open' },
  // A aba nova entra AQUI — logo após "Fila", conforme especificado.
  { id: 'board', labelKey: 'board', minRole: 'admin' },
  { id: 'contacts', labelKey: 'contacts' },
];

export function visibleTabDefinitions(
  role: AccountRole | null
): readonly TabDefinition[] {
  return TAB_DEFINITIONS.filter(
    (def) => !def.minRole || (role !== null && hasMinRole(role, def.minRole))
  );
}
```

Pontos que a implementação precisa preservar:

- **`isConversationTab` não muda.** `board` não é uma aba de feed — não tem
  predicado de `assigned_agent_id`, não instancia `useConversationFeed`, não
  entra em `visitedTabs`. A função já testa `tab === 'chat' || tab === 'open'`,
  então continua correta por construção; o teste novo apenas trava isso.
- **`DEFAULT_TAB` continua `'open'`.**
- **`conversationTabPredicate` não muda.**
- `visibleTabDefinitions` usa `hasMinRole`, não comparação de string —
  `minRole: 'admin'` precisa deixar o `owner` passar.

### 3.6 `InboxTabs` continua agnóstico de papel

O componente documenta, no comentário da prop `trailing`
([inbox-tabs.tsx:11-19](../src/components/inbox/inbox-tabs.tsx#L11-L19)), que é
**deliberadamente genérico, sem noção de papel de conta** — quem decide o que
aparece é o chamador. Manter essa propriedade:

```ts
interface InboxTabsProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  /**
   * Abas a renderizar. Default = todas. O chamador
   * (`inbox/page.tsx`) passa `visibleTabDefinitions(accountRole)` —
   * a filtragem por papel mora lá, não aqui, pelo mesmo motivo que o
   * `trailing` existe.
   */
  tabs?: readonly TabDefinition[];
  trailing?: React.ReactNode;
}
```

O ícone entra em `TAB_ICONS`
([inbox-tabs.tsx:25](../src/components/inbox/inbox-tabs.tsx#L25)) — sugestão
`Columns3` do `lucide-react`. Como o mapa é um `Record<TabId, …>` **exaustivo**,
o `tsc` obriga a entrada nova; não há como esquecer.

A aba renderiza **com rótulo** (não compacta): `compact` segue valendo só para
`contacts`.

### 3.7 Fechando o buraco do `?tab=board` na URL

`useInboxTabs` hoje faz `isTabId(tabParam) ? tabParam : DEFAULT_TAB`
([use-inbox-tabs.ts:77](../src/hooks/use-inbox-tabs.ts#L77)). Com `board` em
`TAB_IDS`, um agente que digitasse `?tab=board` na barra de endereço cairia num
quadro de colunas vazias — o modo de falha da §2.1(a), agora por outra porta.

```ts
export function resolveTab(
  raw: string | null,
  role: AccountRole | null,
  profileLoading: boolean
): TabId | null {
  if (!isTabId(raw)) return DEFAULT_TAB;
  // Papel ainda carregando: NÃO degradar ainda — devolver `null` e
  // deixar o chamador segurar o render. Degradar aqui faria um
  // admin com deep link para ?tab=board ver a "Fila" piscar antes
  // do quadro, e — pior — a página reescreveria a URL para ?tab=open
  // no meio do caminho, destruindo o link compartilhado.
  if (profileLoading) return null;
  const def = TAB_DEFINITIONS.find((d) => d.id === raw);
  if (def?.minRole && (role === null || !hasMinRole(role, def.minRole))) {
    return DEFAULT_TAB;
  }
  return raw;
}
```

`useInboxTabs()` passa a aceitar `{ accountRole, profileLoading }` (a página já
os tem de `useAuth()`) e expõe `activeTab: TabId | null`. Enquanto for `null`, a
página renderiza o esqueleto de carregamento que já existe — não a `DEFAULT_TAB`.

> Vale repetir o que o cabeçalho de [tabs.ts](../src/lib/inbox/tabs.ts) já diz:
> **isto não é controle de acesso.** Um agente que force `?tab=board` e vença
> este guarda por algum caminho ainda não veria linha nenhuma dos colegas — a
> RLS é a fronteira real. `resolveTab` existe por UX, para que a degradação
> seja explícita em vez de um quadro vazio ambíguo.

---

## 4. Estado e busca de dados

### 4.1 Stack

**Sem React Query, sem SWR, sem server action** — o repo não usa nenhum dos
três, e introduzir um aqui deixaria a base inconsistente. Manter a convenção
universal: `useState` + `useEffect` + flag `cancelled` no cleanup +
`resyncToken: number` como mecanismo de invalidação, exatamente como
[use-conversation-feed.ts:85-130](../src/hooks/use-conversation-feed.ts#L85-L130).

Gatilhos de `resyncToken`, os mesmos do resto do Inbox: reconexão do WS
(`SUBSCRIBED`), `visibilitychange → visible`, e o botão de atualizar manual.

### 4.2 Modelo de colunas

```ts
// src/lib/inbox/assignment-board.ts

/**
 * Id sentinela da primeira coluna. String literal, não `null`: o
 * `over.id` do @dnd-kit é sempre `string | number`, e um `null` ali
 * seria indistinguível de "soltou fora de qualquer coluna". O prefixo
 * `__` garante que nunca colide com um UUID de usuário.
 */
export const UNASSIGNED_COLUMN_ID = '__unassigned__';

export interface BoardColumn {
  id: string;              // UNASSIGNED_COLUMN_ID ou profile.user_id
  agent: Profile | null;   // null ⇒ a fila
}

export function buildBoardColumns(members: Profile[]): BoardColumn[];
export function boardColumnIdToAgentId(columnId: string): string | null;
```

`buildBoardColumns` põe a fila sempre em primeiro, depois os membros com
`account_role` em `ASSIGNABLE_ACCOUNT_ROLES` (§2.2), ordenados por `full_name`
— a mesma ordenação que `useAccountMembers` já pede na query.

### 4.3 Onda 1 — uma query por coluna, em paralelo

O PostgREST não faz "LIMIT por grupo", e teto por coluna é exatamente o que a
decisão de volume exige. Solução: `Promise.all` de N+1 queries (1 fila + N
agentes):

```ts
const q = supabase
  .from('conversations')
  .select(BOARD_CONVERSATION_SELECT, { count: 'exact' })
  .in('status', ['open', 'pending'])
  .order('last_message_at', { ascending: false })
  .range(0, BOARD_PAGE_SIZE - 1);          // BOARD_PAGE_SIZE = 50

const query = agentId === null
  ? q.is('assigned_agent_id', null)        // coluna "Não atribuídos"
  : q.eq('assigned_agent_id', agentId);    // coluna de agente
```

**Por que o N+1 aqui não é um anti-padrão** — vale documentar, porque parece
um:

- A migração 039 criou **exatamente** os dois índices que essas queries usam:
  `idx_conversations_assigned (account_id, assigned_agent_id, last_message_at DESC)`
  ([039:119](../supabase/migrations/039_conversation_assignment.sql#L119)) e o
  parcial `idx_conversations_unassigned … WHERE assigned_agent_id IS NULL`
  ([039:123](../supabase/migrations/039_conversation_assignment.sql#L123)).
  Cada query é uma varredura de índice já ordenada.
- **N é o número de membros atribuíveis** — unidades, não centenas — e as
  queries são paralelas: o tempo total é o da mais lenta, não a soma.
- É o **único** desenho que dá teto por coluna **e** contagem total real. Uma
  query única com `limit` global truncaria colunas inteiras de forma arbitrária
  (as 500 conversas mais recentes da conta podem ser todas de dois agentes).

O `count` alimenta o cabeçalho da coluna; o `data` (truncado em 50) alimenta a
lista. Os dois números são exibidos de forma distinta (§6.2), então a lista
truncada nunca faz o cabeçalho mentir.

`BOARD_CONVERSATION_SELECT` é deliberadamente **mais enxuto** que o
`CONVERSATION_SELECT` do Inbox (que faz `contact:contacts(*)`) — o quadro
carrega N vezes mais linhas que a lista, então cada coluna a mais custa:

```ts
export const BOARD_CONVERSATION_SELECT =
  'id, contact_id, assigned_agent_id, status, last_message_at, unread_count, ' +
  'contact:contacts(id, name, phone, avatar_url, company, contact_tags(tags(*)))';
```

Reusar `normalizeConversation` de
[src/lib/inbox/conversations.ts](../src/lib/inbox/conversations.ts) para achatar
`contact_tags → contact.tags` — não reimplementar o achatamento.

### 4.4 Onda 2 — hidratação em lote (notas + deal)

Concluída a onda 1, coletar os `contact_id` distintos visíveis
(≤ nº de colunas × 50) e disparar duas queries em paralelo:

```ts
supabase.from('contact_notes')
  .select('contact_id, note_text, created_at')
  .in('contact_id', ids)
  .order('created_at', { ascending: false });

supabase.from('deals')
  .select('contact_id, status, created_at, stage:pipeline_stages(id,name,color), pipeline:pipelines(id,name)')
  .in('contact_id', ids)
  .order('created_at', { ascending: false });
```

Reduzir cada resultado a um `Map<contactId, …>` guardando a **primeira**
ocorrência por contato — as queries já vêm ordenadas `desc`, então a primeira é
a mais recente.

**Regra do badge de CRM** (decisão registrada — §2.4 explica por que precisa
ser uma decisão):

```ts
export function pickPrimaryDeal(dealsDoContato: BoardDealRow[]): PrimaryDeal | null {
  // Já vem ordenado por created_at desc.
  const open = dealsDoContato.find((d) => d.status === 'open');
  if (open) return toPrimary(open, { stale: false });
  const latest = dealsDoContato[0];
  // Sem deal aberto: mostra o mais recente (won/lost) esmaecido — a
  // informação "este contato JÁ passou pelo funil" é útil ao supervisor,
  // e apagá-la seria indistinguível de "nunca entrou no funil".
  return latest ? toPrimary(latest, { stale: true }) : null;
}
```

Funções puras, testadas em `assignment-board.test.ts`.

> **Trade-off registrado:** um contato com centenas de notas infla a resposta da
> primeira query. Se isso doer em produção, a correção é uma view
> `contact_latest_note` (§9) — **não** um `.limit()` arbitrário, que truncaria
> contatos inteiros de forma silenciosa e faria cards perderem a nota sem
> nenhum sinal.

**Sem layout shift:** o card renderiza logo após a onda 1. A linha de metadados
(nota + badge) tem altura reservada e mostra placeholder até a onda 2 chegar —
caso contrário todas as colunas saltariam ao mesmo tempo.

### 4.5 Estado do hook

```ts
interface BoardCard {
  conversation: Conversation;
  latestNote: string | null;
  primaryDeal: {
    pipelineName: string;
    stageName: string;
    stageColor: string;
    stale: boolean;
  } | null;
  hydrated: boolean;   // onda 2 já chegou para este contato
  pending: boolean;    // mutação em voo
}

interface BoardColumnState {
  column: BoardColumn;
  cards: BoardCard[];
  total: number;        // count exato do servidor, NÃO cards.length
  loadingMore: boolean;
}
```

Os dados derivados ficam **fora** do tipo `Conversation` compartilhado. Enfiar
`latestNote` ou `primaryDeal` dentro dele poluiria um tipo usado por toda a
aplicação com campos que só este quadro conhece — e faria o próximo
`normalizeConversation` parecer incompleto.

### 4.6 Realtime

```ts
useRealtime({
  channelName: 'inbox-assignment-board',   // canal PRÓPRIO
  enabled: activeTab === 'board',
  onConversationEvent: handleBoardEvent,
});
```

Canal separado do `'inbox-realtime'` da página, e ativo **só enquanto a aba
está aberta** — o custo é limitado ao tempo de uso.

Por causa da §2.6, `handleBoardEvent` **não** pode ler `old.assigned_agent_id`.
O algoritmo é:

| Evento                                            | Ação                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `UPDATE`, id conhecido no `cardColumnRef`         | Move o card da coluna registrada para a derivada de `new.assigned_agent_id`; atualiza os dois `total`.      |
| `UPDATE`, id conhecido, `new.status === 'closed'` | Remove o card; decrementa o `total` da coluna de origem.                                                    |
| `UPDATE`/`INSERT`, id desconhecido, status elegível | Busca a linha com `BOARD_CONVERSATION_SELECT`, insere no topo da coluna correspondente, incrementa `total`. |
| `DELETE`                                          | Remove pelo id; decrementa `total`.                                                                          |

**Sempre ajustar `total` junto do movimento.** Mover o card sem mexer na
contagem faz o cabeçalho começar a mentir depois do primeiro evento, e o erro
só some no próximo `resyncToken`.

Manter `cardColumnRef: MutableRefObject<Map<string, string>>` sincronizado em
**todo** caminho que mexe nas colunas — carga inicial, "carregar mais", drop
otimista, rollback e eventos realtime. Ele é a **autoridade** sobre onde um
card está (§5.4): é atualizado sincronamente, enquanto o espelho do estado só
reflete o último commit do React.

**Conversas fora da página carregada.** Com teto de `BOARD_PAGE_SIZE` por
coluna, um evento pode ser sobre uma conversa que não está em nenhuma lista
local. Aí não há como ajustar as duas pontas: sabemos para onde ela foi, mas
não de onde veio — consequência direta da §2.6. Incrementar o destino sem
decrementar a origem faria o cabeçalho mentir de forma **permanente**, já que
nada no fluxo normal reconcilia.

A correção é reler só as contagens: uma query por coluna com
`count: 'exact', head: true` — sem devolver linha nenhuma, batendo nos mesmos
índices da 039. Disparada com debounce de 3s (uma rajada de webhooks vira uma
consulta) sempre que um evento chega para um id ausente de `cardColumnRef`,
incluindo `DELETE` e a transição para `closed`. Escreve **exclusivamente** em
`total`, nunca em `cards`, e é adiada enquanto houver card `pending`: com um
drop em voo o servidor ainda responde a contagem anterior à escrita, e
aplicá-la sobrescreveria o ajuste otimista com um número velho que nada
corrigiria depois.

**Custo do canal.** O quadro assina só `conversations`
(`tables: ['conversations']` em [`useRealtime`](../src/hooks/use-realtime.ts)):
tudo o que o card mostra e que muda sozinho vive nessa linha, e assinar
`messages` traria o firehose inteiro da conta para ser descartado. Em
contrapartida, `inbox/page.tsx` **desliga o canal dele** enquanto a aba está
aberta (`enabled: activeTab !== 'board'`) — sem isso as duas assinaturas
coexistiriam e o tráfego de realtime do cliente dobraria. Voltar para uma aba
conversacional reassina, e a transição desconectado → conectado já dispara o
`resyncToken` que cobre os eventos perdidos no intervalo.

> **Nota de escopo:** a mesma "revogação é silêncio" documentada em
> [use-total-unread.ts:29-42](../src/hooks/use-total-unread.ts#L29-L42) vale
> aqui, mas com impacto baixo: o quadro é `admin+`, e um admin vê todas as
> linhas da conta. O refetch em reconexão e em `visibilitychange` cobre o
> resíduo.

---

## 5. Mutação — o fluxo do drop

### 5.1 Escolha da rota

Reusar **a mesma regra** que o dropdown do header da thread já aplica
([message-thread.tsx:946-993](../src/components/inbox/message-thread.tsx#L946-L993)),
em vez de inventar uma segunda:

| Origem → Destino                    | Rota                                       | Body                              |
| ----------------------------------- | ------------------------------------------ | --------------------------------- |
| Não atribuídos → **minha** coluna   | `POST /api/inbox/conversations/{id}/claim` | —                                 |
| Não atribuídos → coluna de terceiro | `POST /api/inbox/conversations/{id}/assign` | `{ assigned_agent_id: "<uuid>" }` |
| Coluna A → Coluna B                 | `POST …/assign`                            | `{ assigned_agent_id: "<uuid>" }` |
| Qualquer coluna → Não atribuídos    | `POST …/assign`                            | `{ assigned_agent_id: null }`     |

```ts
const targetAgentId = boardColumnIdToAgentId(targetColumnId);
const isClaimFromQueue =
  sourceColumnId === UNASSIGNED_COLUMN_ID && targetAgentId === user.id;
```

**Usar `/claim` nesse caso não é cosmético.** O `claim_conversation` faz
`UPDATE … WHERE assigned_agent_id IS NULL`, e **esse predicado é o lock**
([assignment.ts:13-18](../src/lib/inbox/assignment.ts#L13-L18)): dois
supervisores puxando o mesmo card no mesmo milissegundo são serializados pelo
Postgres, e o perdedor recebe `CONVERSATION_ALREADY_CLAIMED` (55006,
[039:499](../supabase/migrations/039_conversation_assignment.sql#L499)) — ou
seja, uma mensagem correta em vez de uma sobrescrita silenciosa. Via `/assign`
os dois passariam e o último venceria sem que ninguém soubesse.

> **Limitação declarada, não escondida:** para os demais movimentos,
> `reassign_conversation` **não** tem esse lock — dois admins arrastando o mesmo
> card ao mesmo tempo resultam em "último ganha", sem erro. É aceitável porque
> (a) o público é pequeno e coordenado, (b) o evento realtime corrige os dois
> quadros em ~1s, e (c) o resultado é sempre um estado válido, só não
> necessariamente o que o primeiro esperava. A correção definitiva seria um
> lock otimista no RPC — registrado em §9.

### 5.2 Fluxo otimista

```
onDragEnd(cardId, targetColumnId)
 │
 ├─ guarda: over == null                        → no-op
 ├─ guarda: targetColumnId === sourceColumnId   → no-op
 ├─ guarda: coluna de destino existe no board   → no-op
 ├─ guarda: card.pending === true               → no-op (já há mutação em voo)
 │
 ├─ snapshot = { sourceColumnId, index, card, totalOrigem, totalDestino }
 │
 ├─ OTIMISTA: move o card entre as colunas, ajusta os dois `total`,
 │            atualiza `cardColumnRef`, marca card.pending = true
 │            (pending ⇒ opacidade reduzida + spinner + pointer-events:none,
 │             para que o mesmo card não possa ser arrastado de novo em voo)
 │
 ├─ await fetch(rota da §5.1)
 │
 ├─ ok   → card.pending = false
 │         PATCH APENAS `assigned_agent_id` com o valor da resposta.
 │         ⚠️ Os RPCs declaram `RETURNS conversations` — a linha volta
 │            CRUA, sem o embed de contato/tags. Substituir o card inteiro
 │            pela resposta apagaria nome, telefone, etiquetas, nota e
 │            badge de CRM que já estavam hidratados em memória.
 │
 └─ erro → rollback pelo snapshot + toast por código (§5.3)
```

O rollback é por **snapshot**, não por refetch. É a divergência deliberada em
relação ao `handleDealMoved` de
[pipelines/page.tsx:310-326](<../src/app/(dashboard)/pipelines/page.tsx#L310-L326>),
que reverte com `refreshDeals()`: aqui um refetch custaria N+1 queries mais as
duas ondas de hidratação para desfazer o movimento de **um** card. O snapshot
é exato e instantâneo.

### 5.3 Matriz de erros

Os códigos vêm de `ASSIGNMENT_ERROR`
([assignment.ts:75](../src/lib/inbox/assignment.ts#L75)) e do `mapError` que os
traduz ([:98](../src/lib/inbox/assignment.ts#L98)). Cada um merece um
comportamento próprio — um toast genérico para todos desperdiçaria informação
que o backend já se deu ao trabalho de distinguir:

| Status / `code`                                                    | Comportamento                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `409 CONVERSATION_ALREADY_CLAIMED`                                 | **Não fazer rollback** — outro agente ficou com ela, e devolvê-la à fila mostraria uma mentira. Toast informativo + refetch pontual daquela conversa para recolocá-la na coluna certa. |
| `404 CONVERSATION_NOT_FOUND`                                       | Remove o card do quadro + toast. Sob a RLS, "não é sua" e "não existe" são indistinguíveis **por desenho** ([assignment.ts:89-97](../src/lib/inbox/assignment.ts#L89-L97)) — não tentar diferenciar. |
| `400 INVALID_ASSIGNEE`                                             | Rollback + toast + refetch do roster: a coluna renderizada está velha (membro removido da conta ou rebaixado a `viewer`). Sem o refetch, o supervisor repete o erro.        |
| `403 ONLY_ADMIN_CAN_REASSIGN_TO_OTHERS` / `NOT_CONVERSATION_OWNER` / `INSUFFICIENT_ROLE` | Rollback + toast. Não deveria ocorrer (a aba é `admin+`); se ocorrer, é sinal de sessão trocada em outra aba do navegador.                       |
| `429`                                                              | Rollback + toast "muitas ações seguidas, aguarde". **Caso real, não hipotético** — ver §2.7. Desabilitar o DnD por alguns segundos evita a cascata de 429.                  |
| `401`                                                              | Rollback + toast de sessão expirada.                                                                                                                                        |
| Rede / `500 ASSIGNMENT_FAILED`                                     | Rollback + toast genérico.                                                                                                                                                  |

### 5.4 A corrida entre o otimista e o realtime

O `postgres_changes` do Supabase **não exclui o cliente que originou a
escrita**: todo drop volta como evento para quem o fez. Isso é absorvido
porque `cardColumnRef` é atualizado **antes** do `fetch`, então o eco cai
no ramo `knownColumnId === targetColumnId` do handler e vira no-op. Essa
ordenação é load-bearing — mover o `set` para depois do `await` faria o
eco reprocessar o movimento.

O caso difícil é outro: um **terceiro** evento chegando enquanto o POST
está em voo (outro admin movendo a mesma conversa). Três invariantes
protegem contra ele, e os três valem para toda a §5:

1. **`cardColumnRef` é a autoridade sobre onde um card está.** Todos os
   caminhos que mexem em colunas o atualizam sincronamente, enquanto
   `columnsStateRef` só reflete o último commit do React. `settleCard`,
   `rollbackDrop` e a resolução da origem do drop consultam o ref, nunca
   uma coluna capturada antes.
2. **Todo redutor é idempotente e devolve a mesma referência quando nada
   muda.** Sem isso, um card já ausente da origem ainda decrementaria
   `total[origem]`, e um card já presente no destino seria inserido em
   duplicata.
3. **Quando o card mudou de coluna durante o voo, o realtime vence.**
   `settleCard` limpa o `pending` mas não sobrescreve
   `assigned_agent_id`; `rollbackDrop` não restaura — apenas limpa o
   `pending` e deixa a posição que o servidor ditou.

Sem (1) e (3), o modo de falha é um card preso em `pending` — esmaecido,
`disabled` no `useDraggable`, sem saída até um resync. Sem (2), é um card
duplicado em duas colunas.

### 5.5 Onde essa lógica mora, e por quê

Os redutores vivem em [`src/lib/inbox/assignment-board.ts`](../src/lib/inbox/assignment-board.ts),
não dentro do hook. O motivo é testabilidade: o repo não tem
`@testing-library`/`renderHook` — só testa módulos puros — e esta é a
parte da feature onde uma corrida produz **corrupção visível** em vez de
um erro. Como funções puras sobre um `Record<string, BoardColumnState>`,
os três invariantes acima ficam cobertos por Vitest sem mock de rede.

O hook fica responsável só pelo que é genuinamente efeito: refs, queries,
canal de realtime, debounce.

### 5.6 Nada muda no backend

Esta entrega **não toca** em
[assignment.ts](../src/lib/inbox/assignment.ts), nas duas rotas, nos RPCs, nas
policies nem no esquema. Toda a lógica de autorização e de concorrência
continua em SQL, e o quadro é só mais um cliente das mesmas duas rotas que o
dropdown da thread já usa — o que também significa que qualquer correção futura
naquela camada beneficia as duas superfícies de uma vez.

---

## 6. UI

### 6.1 Layout do quadro

O quadro **substitui** o painel de 3 colunas (lista + thread + sidebar) quando a
aba está ativa — mesma estrutura de ramificação que `contacts` já usa em
`inbox/page.tsx`:

```tsx
{activeTab === 'contacts' ? <ContactsDirectory /> :
 activeTab === 'board'    ? <AssignmentBoard /> : (
   <TagPickerProvider…><DealPickerProvider>…</DealPickerProvider></TagPickerProvider>
)}
```

O quadro **não** precisa dos providers de tag/deal picker: não edita nem
etiqueta nem negócio.

Rolagem horizontal copiando as classes de
[pipeline-board.tsx:106](../src/components/pipelines/pipeline-board.tsx#L106)
(`snap-x snap-mandatory` no mobile, `lg:snap-none` + `flex-1` no desktop) e o
CSS de scrollbar temática de [:147-184](../src/components/pipelines/pipeline-board.tsx#L147-L184).

### 6.2 Coluna

```
┌──────────────────────────────┐
│ 📥 Não atribuídos        12  │   ← primeira coluna, sempre
├──────────────────────────────┤
│ (cards)                      │
└──────────────────────────────┘

┌──────────────────────────────┐
│ (av) João Silva ●        34  │   ← PresenceDot ao lado do nome
├──────────────────────────────┤
│ (cards, máx. 50)             │
│ [ Mostrando 50 de 34… ]      │
└──────────────────────────────┘
```

- **Contagem no cabeçalho = `total`** (o `count` exato do servidor), com o mesmo
  chip `bg-muted text-muted-foreground rounded-full` de
  [pipeline-board.tsx:224](../src/components/pipelines/pipeline-board.tsx#L224).
- Quando `cards.length < total`, um rodapé "Mostrando {shown} de {total}" +
  botão "Carregar mais" (avança o `range` em `BOARD_PAGE_SIZE`). Assim o número
  do cabeçalho nunca é confundido com o tamanho da lista.
- Coluna "Não atribuídos" com ícone `Inbox` (o mesmo da aba "Fila") e um
  tratamento visual distinto — é a fila, não uma pessoa.
- Avatar via [`ui/avatar.tsx`](../src/components/ui/avatar.tsx) com
  `AvatarFallback`; `PresenceDot` com `label={presenceLabel(status)}`
  ([src/lib/presence.ts:97](../src/lib/presence.ts#L97)).
- Estado vazio: `dropHere` numa área tracejada, espelhando
  [:240-243](../src/components/pipelines/pipeline-board.tsx#L240-L243).

### 6.3 Card

```
┌──────────────────────────────────────┐
│ Maria Silva                14:32  ②  │  ← nome · último msg · não lidas
│ Cliente pediu retorno na segunda…    │  ← contact_notes mais recente, 1 linha
│ [VIP] [Suporte] +2                   │  ← etiquetas
│ ◈ Funil de Vendas › Qualificação     │  ← badge CRM read-only
└──────────────────────────────────────┘
```

| Elemento          | Regra                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nome              | `contact.name \|\| contact.phone`, truncado.                                                                                                                                                                                                                             |
| Não lidas         | Chip só quando `unread_count > 0`.                                                                                                                                                                                                                                       |
| Nota              | `latestNote`, uma linha, `line-clamp-1`. Sem nota → linha vazia com a altura preservada (§4.4).                                                                                                                                                                            |
| Etiquetas         | Máx. 3 chips + "+N". Usar a fórmula universal do repo — `backgroundColor: ${color}20`, `color: ${color}` — como em [contact-sidebar.tsx:222-235](../src/components/inbox/contact-sidebar.tsx#L222-L235). **Não** usar [`ui/badge.tsx`](../src/components/ui/badge.tsx): o repo nunca o usa para etiquetas. |
| Badge de CRM      | **Visualmente distinto das etiquetas** (ícone + formato `{funil} › {etapa}`), para que ninguém o confunda com uma tag. `borderColor: ${stage.color}40`, texto em `text-muted-foreground`. `title` com o texto completo. Quando `stale`, `opacity-60`. Sem deal → nada renderizado. |

**O badge é estritamente read-only** — nenhum `onClick`, nenhum cursor de
ponteiro, nenhum menu. É o invariante 3 da §3.1 na superfície.

**Clique no card** (que sobrevive ao `activationConstraint: { distance: 5 }`,
como o `DealCard` documenta em
[deal-card.tsx:38-40](../src/components/pipelines/deal-card.tsx#L38-L40))
navega para a conversa reusando o mecanismo "ver como" da SPEC 042:

- card atribuído → `/inbox?tab=chat&c={id}&viewAs={agentId}`
- card da fila → `/inbox?tab=open&c={id}`

Reusar o `?viewAs=` em vez de inventar uma rota nova é o que faz o supervisor
abrir a conversa de um agente **sem** precisar reatribuí-la para si.

### 6.4 Menu "atribuir a…" — o caminho sem arrasto

Cada card tem um menu (⋮) com "Abrir conversa" e a lista de colunas de destino,
chamando o **mesmo** `moveConversation` do drop — todas as guardas da §5 valem
sem duplicação. É o que torna a feature operável no toque e por teclado, onde o
DnD é frágil ou impossível (§7).

Três decisões de implementação que não são óbvias:

**A raiz do card é um `<div>`, não um `<button>`.** O wrapper de
`useDraggable` já injeta `role="button"` + `tabIndex={0}` para o arrasto por
teclado; um botão real aninhado ali criava conteúdo interativo aninhado e um
segundo tab-stop por card. O clique na raiz vira conveniência de mouse, e o
caminho de teclado para as mesmas ações passa a ser o menu — que é um botão de
verdade e por isso inclui o item "abrir conversa".

**O gatilho barra `pointerdown`, não só `click`.** O `PointerSensor` do dnd-kit
ativa em qualquer `pointerdown` primário sobre o elemento arrastável e **não**
exclui filhos interativos (ver `PointerSensor.activators` no core). Sem
`stopPropagation` no `pointerdown`, tocar o menu no celular e mover o dedo 5px
inicia um arrasto em vez de abrir o menu — no dispositivo em que o menu existe
justamente para substituir o arrasto. Vale também para o conteúdo do menu:
apesar de portalado no DOM, eventos sintéticos do React continuam propagando
pela árvore de componentes.

**Sem `PresenceDot` no menu**, ao contrário do dropdown do `MessageThread`. A
presença de cada agente já está no cabeçalho da coluna, uma linha acima, e
trazê-la para o card exigiria injetar a API inteira de `usePresence` num
componente-folha — chamar o hook lá dentro abriria **um canal realtime por
card**. Os destinos chegam como `BoardAssignTarget[]` com o rótulo já
resolvido, calculado uma vez no `AssignmentBoard`.

---

## 7. Acessibilidade

- `PointerSensor` + **`KeyboardSensor`**, como no board de pipelines — é o que
  dá arrasto por teclado (Espaço pega, setas movem, Espaço solta, Esc cancela).
- **`announcements` do `DndContext`, traduzidos.** O board de pipelines não faz
  isso hoje; aqui é obrigatório, porque o efeito da ação (mudar o dono de uma
  conversa) é completamente invisível sem anúncio. Chaves `a11yDragStart`,
  `a11yDragOver`, `a11yDragEnd`, `a11yDragCancel` (§8).
- Cada droppable com `aria-label` = nome da coluna (`columnAriaLabel`).
- Card com `pending` recebe `aria-busy="true"`.
- Nenhum estado depende só de cor: `stale` no badge vem acompanhado de `title`;
  o erro vai para `toast` do sonner, já anunciado por leitor de tela.
- Contraste dos chips de etiqueta: a fórmula `${color}20` sobre `bg-card` é a
  mesma já em uso no repo — nenhum novo risco introduzido.

> **Nota honesta sobre toque:** DnD por toque em telas pequenas é frágil mesmo
> com `touchAction: 'none'`. Por isso o card tem o menu "atribuir a…" da §6.4 —
> o caminho alternativo que não depende de arrasto, tanto no toque quanto para
> quem navega por teclado. O arrasto continua sendo o gesto principal no
> desktop; o menu é o que garante que nenhuma ação seja exclusiva dele.

---

## 8. Internacionalização

Nenhuma string hard-coded; tudo via `useTranslations`, nos dois idiomas, com
paridade garantida por `npm run i18n:check`.

Uma chave em `Inbox.tabs`, junto de `chat` / `open` / `contacts`:

| Chave   | pt-BR  | en     |
| ------- | ------ | ------ |
| `board` | `Time` | `Team` |

Namespace novo `Inbox.assignmentBoard`:

| Chave                  | pt-BR                                                        | en                                                       |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `unassignedColumn`     | `Não atribuídos`                                             | `Unassigned`                                             |
| `columnAriaLabel`      | `Conversas de {name}`                                        | `{name}'s conversations`                                 |
| `dropHere`             | `Solte uma conversa aqui`                                    | `Drop a conversation here`                               |
| `emptyColumn`          | `Nenhuma conversa`                                           | `No conversations`                                       |
| `loadMore`             | `Carregar mais`                                              | `Load more`                                              |
| `showingOf`            | `Mostrando {shown} de {total}`                               | `Showing {shown} of {total}`                             |
| `crmBadge`             | `{pipeline} › {stage}`                                       | `{pipeline} › {stage}`                                   |
| `crmBadgeClosedTitle`  | `Negócio encerrado — {pipeline} › {stage}`                   | `Closed deal — {pipeline} › {stage}`                     |
| `moreTags`             | `+{count}`                                                   | `+{count}`                                               |
| `moving`               | `Movendo…`                                                   | `Moving…`                                                |
| `noMembers`            | `Nenhum agente nesta conta ainda.`                           | `No agents in this account yet.`                         |
| `toastAssigned`        | `Conversa atribuída a {name}`                                | `Conversation assigned to {name}`                        |
| `toastUnassigned`      | `Conversa devolvida à fila`                                  | `Conversation returned to the queue`                     |
| `toastAlreadyClaimed`  | `Outro agente acabou de assumir esta conversa`               | `Another agent has just taken this conversation`         |
| `toastNotFound`        | `Esta conversa não está mais disponível`                     | `This conversation is no longer available`               |
| `toastInvalidAssignee` | `Este membro não pode mais receber conversas`                | `This member can no longer be assigned conversations`    |
| `toastForbidden`       | `Você não tem permissão para esta ação`                      | `You don't have permission for this action`              |
| `toastRateLimited`     | `Muitas ações seguidas. Aguarde alguns segundos.`            | `Too many actions in a row. Wait a few seconds.`         |
| `toastFailed`          | `Falha ao mover a conversa`                                  | `Failed to move the conversation`                        |
| `a11yDragStart`        | `Conversa de {contact} levantada da coluna {from}`           | `Picked up {contact}'s conversation from {from}`         |
| `a11yDragOver`         | `Sobre a coluna {over}`                                      | `Over column {over}`                                     |
| `a11yDragEnd`          | `Conversa de {contact} movida para {to}`                     | `{contact}'s conversation moved to {to}`                 |
| `a11yDragCancel`       | `Movimento cancelado; conversa de {contact} voltou a {from}` | `Move cancelled; {contact}'s conversation back to {from}` |

Reusar, sem duplicar: `Inbox.tabs.viewAsUnknownMember` para membro sem nome, e
o rótulo de presença de `src/lib/presence.ts`.

> Nomes de agente, contato, funil, etapa e etiqueta **nunca** são traduzidos —
> são dados da conta.

---

## 9. Pendências e trabalho futuro

- [x] ~~**Menu "atribuir a…" no card**, para operar sem arrasto.~~ Entregue —
      ver §6.4.
- [ ] **View `contact_latest_note`**, caso a query de notas da §4.4 pese em
      contas com histórico longo de anotações.
- [ ] **Cobertura de teste do hook.** Os redutores estão cobertos (§5.5), mas a
      orquestração em si — ordem das ondas, debounce, ciclo de vida do canal —
      não, porque o repo não tem `@testing-library`/`renderHook`. Introduzir
      essa infraestrutura é uma decisão maior que esta feature.
- [ ] **Multi-seleção para atribuição em lote** — "selecionar 10 e mover para o
      João" ainda exige 10 arrastos.
- [ ] **Lock otimista no `reassign_conversation`** (comparar o
      `assigned_agent_id` esperado antes do `UPDATE`), eliminando o "último
      ganha" da §5.1. Exigiria migração e mudança de assinatura do RPC —
      fora do escopo desta entrega por isso.
- [ ] **Filtros no topo do quadro** (busca, etiquetas, status) refazendo a query
      no servidor. Ficou de fora da decisão de volume; o teto por coluna + o
      recorte `status IN ('open','pending')` cobrem o caso comum.
- [ ] **`announcements` no board de `/pipelines`** — a lacuna de acessibilidade
      apontada na §7 existe lá também; corrigir num diff próprio.

---

## 10. Critérios de aceite

### Verificados por build / teste automatizado

- [ ] `tsc --noEmit`, `eslint`, a suíte `vitest` e `next build` passam.
- [ ] `npm run i18n:check` em paridade entre `pt-BR` e `en`.
- [ ] Nenhuma dependência nova no `package.json`.
- [ ] **Nenhuma migração nova** em `supabase/migrations/`.
- [ ] `src/lib/inbox/assignment-board.test.ts` cobre `buildBoardColumns`,
      `boardColumnIdToAgentId` e `pickPrimaryDeal` (incluindo: sem deals; só
      deals fechados → `stale: true`; deal aberto antigo vencendo um fechado
      recente).
- [ ] O mesmo arquivo cobre os redutores (§5.5), com um caso por invariante da
      §5.4: card ausente da origem não mexe em `total`; card já no destino não
      duplica; `restoreCard` de um card que o realtime já moveu é no-op;
      `settleCard` sem `patchAssignment` preserva o dono atual; `appendCards`
      deduplica; `applyColumnCounts` ignora `count: null`.
- [ ] `src/lib/inbox/tabs.test.ts` cobre `resolveTab` (agente com
      `?tab=board` → `DEFAULT_TAB`; `profileLoading` → `null`; owner → `board`)
      e `isConversationTab('board') === false`.
- [ ] **Invariante 1 e 2 da §3.1:** `grep -r "components/pipelines" src/components/inbox/assignment-board/`
      e `grep -r "assignment-board" src/components/pipelines/` não retornam nada.

### Verificados manualmente no app

- [ ] A aba "Time" aparece **imediatamente após "Fila"** para admin/owner.
- [ ] A aba **não** aparece para `agent` nem `viewer`.
- [ ] Um agente com `?tab=board` forçado na URL cai em "Fila", sem quadro vazio.
- [ ] Um owner com deep link `?tab=board` abre no quadro **sem** piscar a "Fila"
      e sem a URL ser reescrita (§3.7).
- [ ] A primeira coluna é sempre "Não atribuídos".
- [ ] Há uma coluna por membro `owner`/`admin`/`agent` e **nenhuma** para
      `viewer`.
- [ ] Membro offline continua tendo coluna, com o `PresenceDot` cinza.
- [ ] Arrastar da fila para a **própria** coluna atribui (e a rede mostra
      `/claim`, não `/assign`).
- [ ] Arrastar entre dois agentes reatribui (rede mostra `/assign`).
- [ ] Arrastar de volta para "Não atribuídos" desatribui.
- [ ] Arrasto por teclado funciona (Tab até o card, Espaço, setas, Espaço).
- [ ] **Menu (⋮) do card** (§6.4): atribui, devolve à fila e abre a conversa,
      com a coluna atual desabilitada e marcada.
- [ ] **No celular**, tocar o ⋮ abre o menu — não inicia um arrasto, mesmo com o
      dedo se movendo um pouco.
- [ ] Clicar num item do menu **não** abre a conversa junto com a atribuição.
- [ ] Só por teclado (sem mouse): é possível atribuir uma conversa do início ao
      fim pelo menu.
- [ ] O card mostra nome, trecho de nota, etiquetas e o badge `funil › etapa`.
- [ ] Contato sem deals → sem badge; contato só com deal ganho/perdido → badge
      esmaecido.
- [ ] O badge de CRM não é clicável e não abre nada.
- [ ] A contagem do cabeçalho é o **total real** mesmo com a lista truncada em
      50; "Carregar mais" acrescenta sem duplicar e o rodapé desaparece ao
      chegar no total.
- [ ] Falha de rede (DevTools offline) devolve o card à coluna de origem, com as
      etiquetas e o badge **intactos**, e mostra toast.
- [ ] Card em voo fica esmaecido e não pode ser arrastado de novo.
- [ ] Dois navegadores lado a lado: mover um card num reflete no outro via
      realtime, **com as contagens dos dois cabeçalhos corretas**.
- [ ] Dois navegadores, corrida real: A arrasta um card e, antes da resposta, B
      move o mesmo card para uma terceira coluna. Em A o card **não** fica
      esmaecido/travado e **não** aparece duplicado (§5.4).
- [ ] Numa coluna com mais de 50 conversas, reatribuir pelo Inbox uma que está
      **fora** da página carregada: o cabeçalho da coluna de origem corrige
      sozinho em poucos segundos, sem F5 (§4.6).
- [ ] Sair da aba Time e voltar para "Chat"/"Fila": a lista de conversas volta a
      atualizar em tempo real (o canal da página reassina) e um refetch acontece
      na volta.
- [ ] Arrastar ~25 cards em sequência produz o toast de 429 (e não um erro
      genérico), e o quadro permanece consistente.
- [ ] Clicar num card atribuído abre a conversa em `?tab=chat&c=…&viewAs=…`;
      num card da fila, em `?tab=open&c=…`.
- [ ] Trocar para outra aba e voltar não perde o estado do quadro nem duplica o
      canal realtime.
- [ ] **Nenhuma requisição de escrita a `deals`, `pipelines` ou
      `pipeline_stages`** é disparada pelo quadro (aba Network).
