# SPEC 041 — Coerência da atribuição fora do Inbox

> **Status:** Rascunho para revisão. **Nenhuma linha de implementação foi escrita.**
> **Severidade:** 🔴 Crítico (F-41-A) → 🟡 Médio (F-41-E).
> **Escopo:** `src/lib/automations/engine.ts`, `supabase/migrations/017_account_sharing.sql`,
> `docs/public-api.md`, `src/hooks/use-total-unread.ts`,
> `src/components/pipelines/deal-form.tsx`, nova migração de asserção.
> **Data:** 2026-08-03

---

## 0. Resumo executivo

A [SPEC de abas + atribuição](spec-inbox-tabs-assignment.md) endureceu o Inbox com
capricho: RLS por linha, RPCs atômicos de claim/reassign, reconciliação por ausência no
realtime, `.select()` em todo `.update()` para não engolir recusa de RLS. Dentro do
Inbox, o modelo está coerente.

**Fora dele, não.** `conversations` é lida e escrita por mais oito lugares no repositório
— automações, flows, API pública, pipelines, sidebar, IA — e só o dashboard foi migrado
junto (`src/lib/dashboard/queries.ts`, RPCs `SECURITY DEFINER` escopadas por conta). Os
demais ficaram com premissas do modelo antigo:

- quem **escreve** com service role continua escrevendo sem as validações que os RPCs
  da 039 passaram a fazer — e o pior deles pode tornar uma conversa **invisível para
  todos** (F-41-A);
- quem **lê** com o cliente do browser passou a receber menos linhas e trata isso como
  "não existe", em silêncio (F-41-D, F-41-E);
- e a própria 039 pode ser **apagada sem erro** por uma reaplicação da 017 (F-41-B).

O risco §7 da SPEC original antecipou parte disso — *"dashboard, pipelines, broadcasts e
automações também leem `conversations`; auditar todo `from('conversations')` do repo"* —
mas a auditoria não foi feita. Esta SPEC é a auditoria, com correção item a item.

---

## 1. 🔴 F-41-A — Automação atribui conversa sem validar conta nem papel

**Onde:** passo `assign_conversation` do motor de automações,
[engine.ts:474-497](../src/lib/automations/engine.ts#L474-L497):

```ts
case 'assign_conversation': {
  const cfg = step.step_config as AssignConversationStepConfig;
  if (!args.contactId) throw new Error('assign_conversation needs a contact');
  let agentId = cfg.agent_id;
  if (cfg.mode === 'round_robin') {
    const { data: profiles } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', args.automation.account_id)
      .limit(1);                                   // ← qualquer papel, inclusive viewer
    agentId = profiles?.[0]?.user_id;
  }
  if (!agentId) return 'no agent resolved';
  await db
    .from('conversations')
    .update({ assigned_agent_id: agentId })        // ← service role: RLS não opina
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId);
```

O `db` aqui é o cliente de service role ([automations/admin-client.ts](../src/lib/automations/admin-client.ts)),
que **bypassa RLS por design** — o próprio `engine.ts` documenta isso em
[engine.ts:77](../src/lib/automations/engine.ts#L77). Logo, nenhuma das travas da 039 se
aplica: nem a policy `conversations_update` com `WITH CHECK`, nem o RPC
`reassign_conversation`, nem a validação de que o destino é membro **desta** conta com
papel `agent`+.

O `.eq('account_id', …)` protege a **conversa** (não dá para atribuir conversa de outro
inquilino). Não protege o **destino**: `agent_id` vem de `step_config`, um JSON gravado
quando a automação foi criada, e nada o revalida na hora da execução.

### Três cenários, todos plausíveis sem má-fé

**1. Agente desligado.** A conta remove o agente A. A seção 11 da 039 existe justamente
para isso — *"HIGIENE — REMOÇÃO DE MEMBRO DEVOLVE A CARTEIRA À FILA"*
([039:786](../supabase/migrations/039_conversation_assignment.sql#L786)) — e a FK com
`ON DELETE SET NULL` cobre a exclusão do usuário. Mas a automação segue com
`agent_id = <uuid de A>` no `step_config`. A cada disparo, ela **reatribui conversas
vivas a um ex-membro**. Sob a 039 essa conversa some da fila (tem dono) e some da aba
"Chat" de todos (o dono não é ninguém da conta). **Ninguém a vê. Ninguém responde.
Nenhum erro é logado.** É perda de atendimento silenciosa, recorrente e difícil de
diagnosticar — a conversa "desaparece" sem rastro na UI.

**2. `round_robin` sorteando um `viewer`.** O `limit(1)` sem `order` nem filtro de papel
pega qualquer `profiles` da conta. Se cair num `viewer`, a conversa passa a ter dono,
sai da fila — e o `viewer` **não pode responder** (`canSendMessages` é agent+) nem
devolvê-la (`INSUFFICIENT_ROLE` no RPC). Fica travada.

**3. UUID de outra conta.** `step_config` é JSON editável pela API de automações. Um
`agent_id` de outro inquilino passa pela FK da 039 (ela referencia `auth.users`, não
`profiles` — a própria [assignment.ts:147-149](../src/lib/inbox/assignment.ts#L147-L149)
avisa que *"a FK sozinha não garante que seja o MESMO inquilino"*) e produz o mesmo
resultado do cenário 1.

### Mitigação

O motor já sabe fazer isso — para **custom fields**, e o comentário explica exatamente o
princípio ([engine.ts:515-524](../src/lib/automations/engine.ts#L515-L524)):

```ts
// Defense in depth: the service-role client bypasses RLS, so confirm
// the field definition belongs to this account before writing.
```

Aplicar o mesmo padrão ao destino da atribuição, com o mesmo predicado de papel que o
backfill da 039 já usa ([039:962-968](../supabase/migrations/039_conversation_assignment.sql#L962-L968)):

```ts
// O destino tem de ser membro DESTA conta com papel que possa atender.
// `viewer` não entra: a conversa sairia da fila e ninguém poderia
// responder — o mesmo motivo pelo qual `reassign_conversation` levanta
// INSUFFICIENT_ROLE (039, seção 9).
const { data: target } = await db
  .from('profiles')
  .select('user_id')
  .eq('user_id', agentId)
  .eq('account_id', args.automation.account_id)
  .in('account_role', ['owner', 'admin', 'agent'])
  .maybeSingle();

if (!target) {
  // Retorno de passo, não exceção: a automação continua, e o log da
  // execução registra por quê. Igual ao que `update_contact_field` faz
  // com um custom field de outra conta.
  return `agent ${agentId} is not an eligible member of this account`;
}
```

E o `round_robin` ganha o mesmo `.in('account_role', […])`. Vale registrar na SPEC de
implementação que o `round_robin` **não é round-robin** — o comentário em
[engine.ts:481-483](../src/lib/automations/engine.ts#L481-L483) admite que devolve
sempre o mesmo membro. Corrigir de verdade (menor carga, ou rodízio por
`last_assigned_at`) é fora de escopo aqui, mas o filtro de papel **não é**: sem ele o
bug 2 continua.

**Verificar também** o `close_conversation` ([engine.ts:615](../src/lib/automations/engine.ts#L615))
e os caminhos equivalentes de `src/lib/flows/engine.ts` — mesma classe de escrita com
service role. `close` não mexe em `assigned_agent_id`, então não tem este defeito, mas a
varredura tem de constar do PR.

---

## 2. 🟠 F-41-B — Reaplicar a 017 apaga a 039 em silêncio

**Onde:** o bloco de limpeza da 017,
[017:361-382](../supabase/migrations/017_account_sharing.sql#L361-L382):

```sql
FOR pol IN
  SELECT policyname, tablename FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = ANY (ARRAY[ …, 'conversations', 'messages',
       'message_reactions', 'contact_notes', 'flow_runs', 'flow_run_events', … ])
LOOP
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
END LOOP;
```

O comentário logo acima declara a premissa que deixou de ser verdadeira:

> `017 owns every policy on these tables (no later migration adds others), so drop them
> all first`

A 039 quebrou essa premissa. O cabeçalho dela registra o perigo como *armadilha 2*
([039:44-52](../supabase/migrations/039_conversation_assignment.sql#L44-L52)) — mas
registrar não é impedir. Hoje, reexecutar a 017 (num ambiente novo, num rebuild, num
`supabase db reset`, ou porque alguém aplicou migrações fora de ordem) **remove todas as
políticas da 039 e recria as antigas, planas por conta**. A conta volta ao modelo em que
qualquer `viewer` lê tudo, **sem uma única mensagem de erro**. As duas migrações são
idempotentes isoladamente e destrutivas em conjunto.

### Mitigação

Três camadas, todas baratas:

1. **Guarda na própria 017.** Excluir do array as seis tabelas que a 039 passou a
   possuir, ou restringir o `DROP` aos nomes de política que a 017 cria. Requer editar
   uma migração já aplicada — aceitável porque a mudança é **estritamente menos
   destrutiva** e o bloco já é idempotente.
2. **Migração de asserção `041_assert_039_intact.sql`.** Falha alto se o predicado
   central existir sem estar em uso:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE proname = 'can_access_conversation'
                AND pronamespace = 'public'::regnamespace)
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'conversations'
          AND policyname = 'conversations_select'
          AND qual ILIKE '%can_access_conversation%')
  THEN
    RAISE EXCEPTION
      '039 foi sobrescrita: can_access_conversation existe mas conversations_select não a usa. Reaplique 039_conversation_assignment.sql.';
  END IF;
END $$;
```

3. **Item novo na PARTE A do [scripts/verify-039-rls.sql](../scripts/verify-039-rls.sql)**,
   no mesmo formato `verificacao / passou / por_que_importa` das asserções 1-6 que já
   existem lá, mais uma linha no runbook de migrações: *"se a 017 for reaplicada, a 039
   TEM de ser reaplicada em seguida"* — que hoje só existe dentro do comentário da 039.

---

## 3. 🟠 F-41-C — `/api/v1` é cega à atribuição, e isso não está escrito em lugar nenhum

**Onde:** [api-context.ts:42](../src/lib/auth/api-context.ts#L42) — *"Service-role
Supabase client. RLS-bypassing; scope by accountId"* — consumido por
[/api/v1/conversations](../src/app/api/v1/conversations/route.ts#L32),
[/api/v1/conversations/[id]](../src/app/api/v1/conversations/[id]/route.ts#L24) e
[/api/v1/conversations/[id]/messages](../src/app/api/v1/conversations/[id]/messages/route.ts#L30).

A API pública autentica por **API key**, não por JWT de usuário. Não existe `auth.uid()`,
logo `can_access_conversation` não teria como decidir nada — e o cliente é service role,
então a RLS nem é consultada. **Toda conversa e toda mensagem da conta saem pela API,
independentemente de atribuição.**

Isto **não é um bug** — é a consequência necessária de uma credencial de conta. O
problema é outro: **não está documentado**, e a 039 criou uma expectativa contrária. Um
administrador que leu "agentes só veem suas conversas" pode entregar uma API key a um
integrador terceiro achando que o mesmo limite se aplica. Não se aplica. O cabeçalho da
039 registra o fato ([039:78-79](../supabase/migrations/039_conversation_assignment.sql#L78-L79));
[docs/public-api.md](public-api.md) não diz nada.

### Mitigação

**Decisão a registrar:** a API pública é uma credencial **de conta**, equivalente a um
`owner`. Não vamos escopá-la por agente nesta entrega.

Implementação: seção nova e explícita em [docs/public-api.md](public-api.md) —
*"Escopo e atribuição: uma API key enxerga todas as conversas da conta, inclusive as
atribuídas a outros agentes. Ela não é equivalente a um usuário agente. Trate-a como
credencial de administrador."* — mais um aviso na tela de criação de API key
(`/settings`, fluxo de [api-keys](../src/lib/api-keys/store.ts)).

Fica registrado como evolução futura, **fora desta SPEC**: coluna de escopo na
`api_keys` ([026](../supabase/migrations/026_api_keys.sql)) que permita emitir chave
restrita a um agente. Só vale a pena quando houver demanda concreta.

---

## 4. 🟠 F-41-D — Contador de não lidas trava após reatribuição

**Onde:** [use-total-unread.ts:23-70](../src/hooks/use-total-unread.ts#L23-L70).

O hook alimenta o ponto verde do Inbox na sidebar. Ele carrega um `SELECT id,
unread_count` **uma única vez, na montagem**, e daí em diante mantém um espelho
incremental (`countsRef`) alimentado por eventos `postgres_changes`.

Esse desenho pressupõe que **toda mudança relevante chega como evento**. A 039 quebrou a
premissa, e a própria SPEC original nomeou o problema em F-04, numa frase que vale
repetir: **"revogação é silêncio, não evento"**. Quando a conversa é reatribuída para
outro agente, o `UPDATE` deixa de passar na `conversations_select` do agente antigo — o
Supabase aplica a policy por assinante — e ele **não recebe nada**. O `countsRef` guarda
para sempre a última contagem conhecida.

**Cenário.** Agente A tem 4 não lidas. Um admin move duas conversas para B. A sidebar de
A continua marcando 4 — inclusive conversas que A não consegue mais abrir. Clicar leva a
uma lista que não as contém. O número só corrige com F5.

O Inbox **já resolveu isso** para si: a reconciliação por ausência em
[inbox/page.tsx:605-630](../src/app/(dashboard)/inbox/page.tsx#L605-L630) refaz o fetch e
trata o sumiço como revogação. O hook da sidebar ficou de fora.

### Mitigação

1. Refazer o `SELECT` inteiro quando houver motivo para desconfiar do espelho:
   reconexão do WebSocket e `visibilitychange` — os mesmos gatilhos que o Inbox usa para
   bumpar `resyncToken` ([page.tsx:581](../src/app/(dashboard)/inbox/page.tsx#L581)). É
   uma query barata (duas colunas, escopada por RLS).
2. Tratar `DELETE` como já trata, e **parar de assumir** que a ausência de evento
   significa "nada mudou".

### Decisão de produto embutida (F-12 da SPEC original, nunca fechada)

Sob a 039, o `SELECT` sem filtro do hook passou a devolver **minhas + a fila inteira**.
O ponto verde da sidebar acende, portanto, para conversa de ninguém.

**Recomendação: manter "minhas + fila".** A fila é trabalho a fazer e o produto quer que
alguém a pegue — um sino que só toca para o que já é meu esconde exatamente o que
precisa de dono. Mas isso **tem de ser uma escolha registrada**, não um efeito colateral
de RLS: se a decisão for a outra, o hook precisa de `.eq('assigned_agent_id', user.id)`.
Se for a recomendada, vale distinguir visualmente as duas origens no futuro.

---

## 5. 🟡 F-41-E — `deal-form` cria negócio sem vínculo, sem avisar

**Onde:** [deal-form.tsx:136-152](../src/components/pipelines/deal-form.tsx#L136-L152):

```ts
const { data } = await supabase
  .from('conversations')
  .select('*')
  .eq('contact_id', contactId)
  .order('last_message_at', { ascending: false })
  .limit(1)
  .maybeSingle();
if (cancelled) return;
setLinkedConversation((data as Conversation | null) ?? null);
```

Query do browser, RLS ligada, **`error` descartado** e `null` tratado como "este contato
não tem conversa".

Sob a 039 essas duas coisas deixaram de ser a mesma. Para um agente que não é dono da
conversa do contato, a query devolve 0 linhas — e o formulário conclui, em silêncio, que
não há conversa. O negócio é criado **sem vínculo**, o que degrada o histórico do funil
sem nenhum sinal para o usuário nem para quem for depurar depois.

Este caso estava previsto: o risco §7 da SPEC original citava pipelines explicitamente.
Só o dashboard foi migrado.

### Mitigação

Distinguir os três estados — *sem conversa*, *conversa fora do meu alcance*, *erro* — e
dizer isso na tela. Um texto discreto ("Este contato tem uma conversa atribuída a outro
agente; o negócio será criado sem vínculo") resolve, e o dado para produzi-lo pode vir
de uma contagem sem RLS via RPC escopado por conta, no mesmo espírito das RPCs
`SECURITY DEFINER` que [lib/dashboard/queries.ts](../src/lib/dashboard/queries.ts) já
introduziu — ou, mais simples, aceitar a ambiguidade e usar um texto neutro
("Nenhuma conversa disponível para vincular").

**Varredura obrigatória no PR.** Todo `from('conversations')` chamado de componente
cliente, para o mesmo padrão "0 linhas tratado como inexistência":

| Arquivo | Situação |
| --- | --- |
| [deal-form.tsx:140](../src/components/pipelines/deal-form.tsx#L140) | **corrigir** (esta seção) |
| [use-total-unread.ts:30](../src/hooks/use-total-unread.ts#L30) | **corrigir** (§4) |
| [contacts-directory.tsx:80](../src/components/inbox/contacts-directory.tsx#L80) | correto — a restrição é intencional ([SPEC 042](spec-042-supervisao-e-escopo-de-contatos.md)) |
| [message-thread.tsx:452](../src/components/inbox/message-thread.tsx#L452), [:668](../src/components/inbox/message-thread.tsx#L668) | já corrigidos na 039 (`.select()` + checagem de 0 linhas) |
| [use-conversation-feed.ts:80](../src/hooks/use-conversation-feed.ts#L80), [inbox/page.tsx:279](../src/app/(dashboard)/inbox/page.tsx#L279) | corretos por construção |

---

## 6. Plano de deploy

Cada item é independente; a ordem abaixo é por severidade, não por dependência.

| Fase | # | Alvo | Ação |
| --- | --- | --- | --- |
| **1** | 1.1 | [engine.ts:474-497](../src/lib/automations/engine.ts#L474-L497) | validar destino (conta + papel) em `assign_conversation`; filtrar papel no `round_robin` (F-41-A) |
| | 1.2 | `src/lib/automations/engine.test.ts` | teste: `agent_id` de outra conta e `agent_id` de `viewer` → passo recusa e loga, conversa intocada |
| | 1.3 | `src/lib/flows/engine.ts` | varredura pelo mesmo padrão de escrita com service role |
| **2** | 2.1 | [017:361-382](../supabase/migrations/017_account_sharing.sql#L361-L382) | restringir o `DROP` às políticas da própria 017 (F-41-B) |
| | 2.2 | `supabase/migrations/041_assert_039_intact.sql` | **novo** — asserção que falha alto |
| | 2.3 | [scripts/verify-039-rls.sql](../scripts/verify-039-rls.sql) | asserção nova na PARTE A |
| **3** | 3.1 | [use-total-unread.ts](../src/hooks/use-total-unread.ts) | refetch em reconexão + `visibilitychange` (F-41-D) |
| | 3.2 | — | decidir e registrar a semântica "minhas + fila" |
| **4** | 4.1 | [docs/public-api.md](public-api.md) | seção de escopo da API key (F-41-C) |
| | 4.2 | UI de criação de API key | aviso equivalente |
| **5** | 5.1 | [deal-form.tsx](../src/components/pipelines/deal-form.tsx) | estados distintos + mensagem (F-41-E) |
| | 5.2 | — | varredura da tabela da §5 |

---

## 7. Riscos e critérios de aceite

**Riscos**
- **Editar a 017** (2.1) toca uma migração já aplicada em produção. É seguro porque a
  mudança só **remove** destrutividade e o bloco é idempotente — mas exige teste num
  banco recriado do zero (`supabase db reset` com a cadeia completa 001→041).
- **A asserção 2.2 falha alto de propósito.** Num ambiente onde a 039 ainda não foi
  aplicada ela não dispara (o `IF EXISTS` protege), mas num ambiente meio-migrado ela
  **interrompe o deploy** — que é o comportamento desejado, e precisa estar no runbook
  para não ser confundido com defeito.
- **Recusar a atribuição em automação** (1.1) muda comportamento em produção: automações
  hoje "funcionando" com `agent_id` inválido passarão a registrar recusa no log. Isso é
  a correção, não um efeito colateral — mas vale um aviso ao mantenedor, porque pode
  revelar automações quebradas há meses.

**Critérios de aceite**
1. Automação com `agent_id` de **outra conta** → conversa permanece inalterada e o log
   da execução registra o motivo.
2. Automação com `agent_id` de um **`viewer`** → idem.
3. `round_robin` nunca resolve para um `viewer`.
4. Reaplicar a 017 num banco de teste → a migração de asserção **falha** com mensagem
   explícita, ou a 017 já não derruba as políticas da 039.
5. Reatribuir a conversa de um agente com a sidebar aberta → o contador converge após
   reconexão/troca de aba do navegador, **sem F5**.
6. `docs/public-api.md` declara o escopo de conta da API key.
7. Criar negócio para contato cuja conversa é de outro agente → mensagem clara, sem
   vínculo fantasma.

---

## 8. Nota de auditoria

Confirmado na varredura e registrado para não reinvestigar:

- **As políticas legadas `FOR ALL` da 001** (`"Users can manage own conversations"`,
  [001:158](../supabase/migrations/001_initial_schema.sql#L158), e equivalentes em
  `messages` e `contact_notes`) **já foram removidas** pelo bloco de limpeza da 017 —
  não são um segundo caminho de acesso. Ironicamente, é o mesmo bloco que causa o
  F-41-B.
- **`/api/whatsapp/webhook`** cria conversas com `assigned_agent_id` nulo via service
  role. Correto e intencional (F-09 da SPEC original): a conversa nasce na fila.
- **`/api/ai/autoreply`** já recebeu o gate de reatribuição na entrega da 039
  ([autoreply/route.ts](../src/app/api/ai/autoreply/[conversationId]/route.ts)).
- **`/api/whatsapp/react`** usa cliente de sessão e filtra por `account_id`
  ([react/route.ts:89-95](../src/app/api/whatsapp/react/route.ts#L89-L95)) — a RLS da 039
  decide, está correto.
