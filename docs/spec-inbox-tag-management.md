# SPEC — Gestão de Etiquetas de Leads no Inbox

**Status:** ✅ Implementado — decisão da §2.1: **Opção A**
**Módulo:** `src/components/inbox`
**Data:** 2026-07-27 (especificado e implementado)
**Autor:** Especificação técnica gerada para o ZAP CRM BR

> **Quem pode fazer o quê (resumo da decisão):**
>
> | Ação                            | Role mínima     | Onde                               |
> | ------------------------------- | --------------- | ---------------------------------- |
> | **Criar** etiqueta no modal     | `admin`         | Linha "Criar …" + seletor de cores |
> | **Atribuir / remover** no modal | `agent`         | Checkboxes da lista                |
> | Ver as etiquetas                | qualquer membro | Chips da sidebar / lista           |
>
> `owner` herda tudo de `admin`. Um `agent` usa o modal normalmente para
> atribuir e remover, mas não vê o formulário de criação — recebe no
> lugar a nota `onlyAdminsCanCreate`. Ver §2.1 para o porquê.

---

## 1. Contexto e escopo

### 1.1 O que já existe

O projeto **já possui** toda a infraestrutura de dados de etiquetas. Esta feature **não cria** o modelo de dados — ela expõe uma nova superfície de UI sobre o que já está no banco.

| Peça existente                 | Localização                                                                                                                                                 | Papel                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tabela `tags`                  | [001_initial_schema.sql:58](../supabase/migrations/001_initial_schema.sql#L58) + `account_id` em [017](../supabase/migrations/017_account_sharing.sql#L177) | Definição da etiqueta (nome + cor), escopo de conta                          |
| Tabela `contact_tags`          | [001_initial_schema.sql:73](../supabase/migrations/001_initial_schema.sql#L73)                                                                              | Join N:N `contact` ↔ `tag`, com `UNIQUE(contact_id, tag_id)`                 |
| CRUD de etiquetas              | [tag-manager.tsx](../src/components/settings/tag-manager.tsx)                                                                                               | Criar/excluir etiquetas em Configurações                                     |
| Atribuição em Contatos         | [contact-detail-view.tsx:247](../src/components/contacts/contact-detail-view.tsx#L247) (`toggleTag`)                                                        | Toggle atribuir/remover, já implementado                                     |
| Atribuição em formulário       | [contact-form.tsx:179](../src/components/contacts/contact-form.tsx#L179)                                                                                    | Sincroniza tags no save (delete-all + insert)                                |
| Exibição no Inbox              | [contact-sidebar.tsx:186](../src/components/inbox/contact-sidebar.tsx#L186)                                                                                 | **Somente leitura** hoje                                                     |
| Filtro por etiqueta no Inbox   | [conversation-list.tsx:268](../src/components/inbox/conversation-list.tsx#L268)                                                                             | Dropdown de filtro (lógica OR)                                               |
| Hidratação de tags na conversa | [`CONVERSATION_SELECT`](../src/lib/inbox/conversations.ts)                                                                                                  | `*, contact:contacts(*, contact_tags(tags(*)))` → achatado em `contact.tags` |

### 1.2 O que esta feature entrega

Um **modal único e reutilizável** que permite, a partir do Inbox:

1. **Criar** uma etiqueta nova on the fly (se ainda não existir);
2. **Atribuir** uma ou várias etiquetas ao lead;
3. **Remover** etiquetas do lead.

Acionável a partir de dois pontos:

- `conversation-list.tsx` (item da lista de conversas);
- `contact-sidebar.tsx` (seção "Etiquetas").

### 1.3 Fora de escopo

- Renomear / recolorir / excluir etiquetas globalmente → continua em Configurações ([tag-manager.tsx](../src/components/settings/tag-manager.tsx)).
- Atribuição em massa (multi-seleção de conversas).
- Etiquetas em conversas (a etiqueta pertence ao **contato**, não à conversa) — decisão mantida por consistência com o modelo atual.

---

## 2. Restrições críticas descobertas na análise

Estes três pontos foram levantados **antes** da implementação; ignorá-los produziria uma feature que falha silenciosamente em produção. Todos foram resolvidos — o que foi decidido está marcado em cada seção.

### 2.1 ✅ RESOLVIDO (Opção A): RLS restringe a criação de etiquetas a `admin`

As políticas de RLS pós-migração 017 divergem entre as duas tabelas:

```sql
-- supabase/migrations/017_account_sharing.sql:394
CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));   -- ⚠️ admin+

-- supabase/migrations/017_account_sharing.sql:491
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL
  USING  (... is_account_member(c.account_id, 'agent'))   -- agent+
  WITH CHECK (... is_account_member(c.account_id, 'agent'));
```

Consequência direta: **um usuário com role `agent` — o operador típico do Inbox — pode atribuir e remover etiquetas, mas NÃO pode criar uma etiqueta nova.** O requisito "criar on the fly" fica acessível apenas a `admin` e `owner`.

Isso é coerente com a intenção de projeto documentada em [`roles.ts:79`](../src/lib/auth/roles.ts#L79): `canEditSettings` (admin+) cobre explicitamente _"pipelines, **tags**, custom fields"_ — ou seja, o catálogo de etiquetas é tratado como **configuração de conta**, não como dado operacional.

**Opções:**

| Opção                | Descrição                                                                                                                                                                                                                                                                                   | Trade-off                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — ✅ ESCOLHIDA** | Manter a RLS. A UI de criação aparece apenas para `admin`/`owner`, via `canEditSettings(accountRole)`. Para `agent`, o campo de criação vira estado vazio explicativo ("Peça a um administrador para criar novas etiquetas") usando [`GatedButton`](../src/components/ui/gated-button.tsx). | Requisito "criar on the fly" fica parcial (só admin+). Zero mudança de banco, zero risco de segurança.                                                                                                                 |
| **B**                | Nova migração relaxando `tags_insert` para `agent`. Manter UPDATE/DELETE em admin+.                                                                                                                                                                                                         | Cumpre o requisito integralmente. Custo: proliferação descontrolada do catálogo de etiquetas (todo agente cria variações — "urgente", "Urgente", "URGENTE"). Exige a unicidade da §2.2 como pré-requisito obrigatório. |
| **C**                | RPC `SECURITY DEFINER` `create_tag_for_account(name, color)` que valida `agent` + faz dedupe case-insensitive server-side.                                                                                                                                                                  | Cumpre o requisito com controle. Custo: mais uma superfície `SECURITY DEFINER` para auditar (o repo já tem esse padrão nas migrações 018/019).                                                                         |

> **Decisão tomada: Opção A.** A RLS permanece intocada. `admin` e
> `owner` criam etiquetas direto do modal do Inbox; `agent` atribui e
> remove, mas vê a nota `onlyAdminsCanCreate` no lugar do formulário de
> criação.
>
> Implementado em [tag-picker-dialog.tsx](../src/components/inbox/tag-picker/tag-picker-dialog.tsx):
>
> ```ts
> const canAssign = accountRole ? canSendMessages(accountRole) : false; // agent+
> const canCreate = accountRole ? canEditSettings(accountRole) : false; // admin+
> ```
>
> Se no futuro for preciso liberar a criação para `agent` (Opção B), o
> caminho é: nova migração relaxando `tags_insert` para
> `is_account_member(account_id, 'agent')` **mantendo** UPDATE/DELETE em
> admin+, e trocar `canEditSettings` por `canSendMessages` na linha
> acima. O índice único da §2.2 já está no lugar, então o pré-requisito
> contra proliferação de variações de caixa está atendido.

### 2.2 ✅ RESOLVIDO: Não havia unicidade de nome em `tags`

Não existe constraint `UNIQUE(account_id, name)`. Hoje o [tag-manager.tsx](../src/components/settings/tag-manager.tsx) insere sem qualquer verificação — é possível criar duas etiquetas "Cliente VIP" idênticas.

O requisito diz _"criar uma nova etiqueta (se ela ainda não existir)"_, o que exige uma noção de "já existe". Sem constraint, dois agentes criando simultaneamente produzem duplicata (race condition que a checagem client-side não cobre).

**Entregue:** [`038_tags_unique_name.sql`](../supabase/migrations/038_tags_unique_name.sql) — dedupe defensivo seguido de

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON tags (account_id, lower(name));
```

Isso torna o "get-or-create" atômico e permite tratar o erro Postgres `23505` como "já existe → apenas atribui".

> **Nota de implementação — o dedupe usa `UPDATE`, não
> `INSERT ... ON CONFLICT`.** Dois motivos: preserva o `created_at`
> original de cada vínculo, e evita um falso positivo do linter do
> editor SQL do Supabase, que lê o padrão
> `INSERT INTO contact_tags (col, col)` como criação de tabela e alerta
> "tabela sem RLS" (contact_tags tem RLS desde a 001).
>
> A troca exigiu um `DISTINCT ON (contact_id, keeper_id)` que o
> `ON CONFLICT` dispensava: se um contato carrega duas duplicatas da
> mesma etiqueta, reapontar ambas colidiria com
> `UNIQUE(contact_id, tag_id)` dentro do próprio `UPDATE`.

### 2.3 ✅ RESOLVIDO: Tipo `Tag` desatualizado

[`src/types/index.ts:118`](../src/types/index.ts#L118) declara:

```ts
export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}
```

Falta `account_id`, que é `NOT NULL` desde a migração 017 e é **obrigatório** em todo insert (o [tag-manager.tsx:103](../src/components/settings/tag-manager.tsx#L103) já o envia, mas sem cobertura de tipo). Corrigir como parte desta entrega:

```ts
export interface Tag {
  id: string;
  user_id: string;
  /** Chave de tenancy — NOT NULL desde a migração 017. */
  account_id: string;
  name: string;
  color: string;
  created_at: string;
}
```

---

## 3. Arquitetura de componentes

### 3.1 Por que um Provider, e não um modal por trigger

Os dois pontos de acionamento vivem em **subárvores irmãs** que montam e desmontam independentemente:

```
InboxPage
├── <div hidden lg:flex>          ← desmonta visualmente no mobile ao abrir a conversa
│   └── ConversationList
│       └── ConversationItem      ← trigger 1 (aninhado 2 níveis)
├── <div>
│   └── MessageThread
└── {contactPanelOpen && (        ← DESMONTA de fato ao colapsar o painel (#258)
      <div className="hidden lg:block">
        <ContactSidebar />        ← trigger 2
      </div>
    )}
```

Montar o `<Dialog>` dentro de qualquer um dos dois amarra o ciclo de vida do modal ao do trigger. O caso mais grave: `ContactSidebar` é **removido da árvore** quando `contactPanelOpen === false` ([page.tsx:620](<../src/app/(dashboard)/inbox/page.tsx#L620>)) — um modal montado ali desapareceria junto. Duplicar o `<Dialog>` nos dois lugares resolveria isso, mas duplica estado, fetch e lógica de mutação.

**Decisão:** um provider no nível da página, com o `<Dialog>` montado **uma única vez** como filho dele, e um hook `useTagPicker()` que os triggers consomem.

### 3.2 Árvore alvo

```
InboxPage
└── <TagPickerProvider onTagsChanged={handleContactTagsChanged}>
    ├── ConversationList        → useTagPicker().open(contact)
    ├── MessageThread
    ├── ContactSidebar          → useTagPicker().open(contact)
    └── <TagPickerDialog />     ← instância única, montada aqui
```

### 3.3 Arquivos novos

| Arquivo                                                  | Responsabilidade                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/components/inbox/tag-picker/tag-picker-context.tsx` | Context + `TagPickerProvider` + hook `useTagPicker()`. Guarda `open` e `contact`. Renderiza `<TagPickerDialog />`.           |
| `src/components/inbox/tag-picker/tag-picker-dialog.tsx`  | UI do modal: busca, lista de etiquetas com checkbox, linha de criação, seletor de cor. Sem lógica de rede.                   |
| `src/components/inbox/tag-picker/use-contact-tags.ts`    | Hook de dados: carrega catálogo + tags do contato, expõe `assign` / `unassign` / `createAndAssign` com atualização otimista. |
| `src/lib/tags.ts`                                        | Helpers puros de mutação Supabase (`assignTag`, `unassignTag`, `createTag`) — testáveis, reutilizáveis fora do Inbox.        |
| `supabase/migrations/038_tags_unique_name.sql`           | Índice único case-insensitive (§2.2).                                                                                        |

### 3.4 Arquivos alterados

| Arquivo                                                                  | Alteração                                                                                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`inbox/page.tsx`](<../src/app/(dashboard)/inbox/page.tsx>)              | Envolve o conteúdo com `<TagPickerProvider>`; adiciona `handleContactTagsChanged` para propagar mutações ao estado de `conversations` e `activeContact`.  |
| [`conversation-list.tsx`](../src/components/inbox/conversation-list.tsx) | `ConversationItem` ganha ação de abrir o modal. Recebe `onOpenTags` como prop (o item é um subcomponente fora do provider-consumer natural).              |
| [`contact-sidebar.tsx`](../src/components/inbox/contact-sidebar.tsx)     | Seção "Etiquetas" ganha botão "＋" que abre o picker (sem `×` nos chips — ver §9.1). Passa a ler `contact.tags` em vez de fazer fetch próprio (ver §4.3). |
| [`src/types/index.ts`](../src/types/index.ts)                            | `Tag.account_id` (§2.3).                                                                                                                                  |
| `messages/pt-BR.json`, `messages/en.json`                                | Novas chaves em `Inbox.tagPicker` (§7).                                                                                                                   |

### 3.5 Contrato do modal

```ts
// tag-picker-context.tsx
interface TagPickerContextValue {
  /** Abre o modal para o contato informado. No-op se contact for null. */
  open: (contact: Contact) => void;
  close: () => void;
  /** Contato atualmente no modal, ou null. */
  contact: Contact | null;
  isOpen: boolean;
}

interface TagPickerProviderProps {
  children: ReactNode;
  /**
   * Chamado após TODA mutação bem-sucedida, com a lista completa e já
   * reconciliada de tags do contato. A página usa isso para manter
   * `conversations[].contact.tags` e `activeContact` em sincronia —
   * ver §4.2 (o filtro por etiqueta da lista depende disso).
   */
  onTagsChanged: (contactId: string, tags: Tag[]) => void;
}
```

O `TagPickerDialog` **não recebe props** — lê tudo do context. Isso garante que adicionar um terceiro trigger (ex.: o header do `MessageThread`) custe uma linha.

### 3.6 Layout do modal

Usa os primitivos existentes: [`Dialog`](../src/components/ui/dialog.tsx) (base-ui), [`Input`](../src/components/ui/input.tsx), [`Button`](../src/components/ui/button.tsx), [`ScrollArea`](../src/components/ui/scroll-area.tsx), [`GatedButton`](../src/components/ui/gated-button.tsx).

> Não existe `command.tsx`/combobox no design system. A busca é um `<Input>` controlado filtrando a lista em `useMemo` — mesmo padrão do filtro de [conversation-list.tsx:181](../src/components/inbox/conversation-list.tsx#L181). **Não** introduzir dependência nova (`cmdk`) para isso.

```
┌────────────────────────────────────────────┐
│ Etiquetas de {nome do contato}         [×] │
│ Atribua ou remova etiquetas deste lead.    │
├────────────────────────────────────────────┤
│ 🔍 [ Buscar ou criar etiqueta...        ]  │
├────────────────────────────────────────────┤
│ ┌ ScrollArea (max-h-64) ─────────────────┐ │
│ │ ☑ ● Cliente VIP                        │ │
│ │ ☐ ● Aguardando pagamento               │ │
│ │ ☑ ● Lead frio                          │ │
│ └────────────────────────────────────────┘ │
├────────────────────────────────────────────┤
│ ── só admin/owner (§2.1) ────────────────  │
│ ＋ Criar "orçamento enviado"               │
│    [●][●][●][●][●][●][●][●]  ← 8 cores    │
├────────────────────────────────────────────┤
│                                  [ Fechar ] │
└────────────────────────────────────────────┘
```

**Comportamentos:**

- A linha "Criar …" só aparece quando a busca tem texto **e** nenhuma etiqueta bate exatamente (case-insensitive) com ele.
- O seletor de cor reusa a constante `PRESET_COLORS` — **extrair** de [tag-manager.tsx:29](../src/components/settings/tag-manager.tsx#L29) para `src/lib/tags.ts` e importar nos dois lugares, em vez de duplicar.
- Sem botão "Salvar": cada toggle persiste na hora (mesmo padrão de [contact-detail-view.tsx:247](../src/components/contacts/contact-detail-view.tsx#L247)). O rodapé só tem "Fechar".
- `Enter` no campo de busca com texto sem correspondência exata → dispara criar-e-atribuir (se permitido pela role).

### 3.7 Responsividade

O `DialogContent` já é `w-full max-w-[calc(100%-2rem)] sm:max-w-sm` — funciona em mobile sem ajuste. O `ScrollArea` interno recebe `max-h-64` para não estourar a viewport em telas baixas.

**Ponto de atenção mobile:** o `ContactSidebar` é `hidden lg:block` — no mobile, o **único** caminho para o modal é o `ConversationList`. Como no mobile a lista é ocultada assim que uma conversa é aberta ([page.tsx:571](<../src/app/(dashboard)/inbox/page.tsx#L571>)), o usuário precisa voltar à lista para etiquetar. Isso é uma limitação de UX aceitável nesta entrega, mas é o argumento mais forte para adicionar um terceiro trigger no header do `MessageThread` numa iteração seguinte — barato, dado o desenho do provider.

---

## 4. Gerenciamento de estado

### 4.1 Estado local do modal

Vive no `TagPickerProvider`:

```ts
const [contact, setContact] = useState<Contact | null>(null);
const isOpen = contact !== null; // estado derivado, não duplicado
```

Derivar `isOpen` de `contact` (em vez de dois `useState`) elimina o estado inconsistente "aberto sem contato".

### 4.2 Propagação da mutação — o ponto mais delicado

Uma alteração de etiqueta precisa refletir em **três** lugares no estado da página. Esquecer qualquer um deles produz bug visível:

| Destino                        | Onde vive                              | O que quebra se não sincronizar                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chips da sidebar               | `ContactSidebar` (estado local `tags`) | Usuário atribui a etiqueta e a sidebar não muda                                                                                                                                                                 |
| `conversations[].contact.tags` | `InboxPage`                            | **O filtro por etiqueta da lista fica errado.** [`matchesContactFilters`](../src/lib/inbox/conversations.ts) lê `conversation.contact.tags`; com filtro ativo, a conversa não entra/sai da lista até um refetch |
| `activeContact.tags`           | `InboxPage`                            | A conversa fica dessincronizada ao alternar entre threads                                                                                                                                                       |

Handler na página:

```tsx
const handleContactTagsChanged = useCallback(
  (contactId: string, tags: Tag[]) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.contact?.id === contactId
          ? { ...c, contact: { ...c.contact, tags } }
          : c
      )
    );
    setActiveContact((prev) =>
      prev?.id === contactId ? { ...prev, tags } : prev
    );
  },
  []
);
```

> Um mesmo contato pode ter **mais de uma conversa** (a migração 036 trata dedupe de conversa por contato, mas conversas encerradas persistem). Por isso o `map` acima casa por `contact.id` e atualiza **todas** as conversas correspondentes — não usar `find`/índice único.

### 4.3 `ContactSidebar` deixa de ter fetch próprio de tags

Hoje o `ContactSidebar` busca tags em `fetchContactData` ([contact-sidebar.tsx:52](../src/components/inbox/contact-sidebar.tsx#L52)) e guarda em estado local, com o tipo `(Tag & { contact_tag_id: string })[]`.

Manter essa cópia local **além** do `contact.tags` que a página já hidrata via `CONVERSATION_SELECT` cria duas fontes de verdade para o mesmo dado. Após a mutação, uma delas fica velha.

**Decisão:** a sidebar passa a renderizar `contact.tags` (vindo da prop `contact`, já hidratada pela página). O fetch de tags sai de `fetchContactData` — deals e notes continuam como estão.

Efeito colateral positivo: elimina uma query por troca de conversa.

> O `contact_tag_id` usado hoje como `key` some. Trocar por `tag.id`, que é igualmente único por contato (garantido pelo `UNIQUE(contact_id, tag_id)`).

### 4.4 Por que Context e não prop drilling

O repositório é majoritariamente prop-driven — `InboxPage` já passa ~10 callbacks para `MessageThread`. Prop drilling funcionaria, mas aqui custa mais:

- `ConversationList` → `ConversationItem` exigiria repassar por 2 níveis, e `ConversationItem` é memoizável por identidade de props (passar callback novo a cada render prejudica isso — mitigável com `useCallback`, mas é ruído);
- `ContactSidebar` ganharia 2 props novas;
- um terceiro trigger custaria mais 2 props em outro componente.

Além disso o padrão de Context já é estabelecido no projeto ([`use-auth`](../src/hooks/use-auth.tsx), [`use-theme`](../src/hooks/use-theme.tsx)) — não é um conceito novo para quem mantém o código.

**Exceção deliberada:** `ConversationItem` recebe `onOpenTags` como **prop**, e não via `useContext`, porque ele já recebe `onSelect`/`t` por prop e é o subcomponente de renderização de lista — manter o padrão local é mais legível que introduzir um consumo de context dentro do loop.

### 4.5 Realtime

Não há canal realtime para `contact_tags` hoje, e **não se deve adicionar um** nesta entrega — o [`useRealtime`](../src/hooks/use-realtime.tsx) do Inbox já está sob pressão (ver o comentário extenso sobre `knownConvIdsRef` em [page.tsx:99](<../src/app/(dashboard)/inbox/page.tsx#L99>) e o histórico das issues #105/#106).

O `resyncToken` existente já cobre o caso multi-agente: em reconexão de WS ou quando a aba volta ao foco, o `ConversationList` refaz o fetch com `CONVERSATION_SELECT`, que traz `contact_tags(tags(*))` atualizado. Latência aceitável para etiquetagem.

---

## 5. API e fluxo de dados

### 5.1 Estratégia: Supabase client direto

Mantém o padrão dominante do módulo — [contact-detail-view.tsx](../src/components/contacts/contact-detail-view.tsx), [tag-manager.tsx](../src/components/settings/tag-manager.tsx) e o próprio [contact-sidebar.tsx](../src/components/inbox/contact-sidebar.tsx) usam `createClient()` do browser. As RLS das §2.1 são a fronteira de autorização real — uma rota de API intermediária não adicionaria segurança, só latência.

> As rotas em `src/app/api/v1/*` são a **API pública** (autenticada por API key, ver [docs/public-api.md](public-api.md)), não a camada de acesso do app. Não é o lugar desta feature.

### 5.2 Operações

Todas em `src/lib/tags.ts`, funções puras recebendo o client:

#### Carregar catálogo (ao abrir o modal)

```ts
await supabase.from('tags').select('*').order('name');
```

RLS `tags_select` filtra por `is_account_member(account_id)`. Sem `.eq('account_id', ...)` explícito — o padrão do repo confia na RLS aqui.

#### Atribuir

```ts
await supabase
  .from('contact_tags')
  .upsert(
    { contact_id: contactId, tag_id: tagId },
    { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
  );
```

> `upsert` em vez de `insert`: `UNIQUE(contact_id, tag_id)` faz o insert falhar com `23505` num duplo-clique ou numa corrida com outro agente. Com `ignoreDuplicates`, a operação é idempotente. O código atual em [contact-detail-view.tsx:265](../src/components/contacts/contact-detail-view.tsx#L265) usa `insert` puro e tem exatamente esse bug latente.

`contact_tags` **não tem** coluna `account_id` — a RLS resolve via join em `contacts`. Não enviar `account_id` (o insert falharia).

#### Remover

```ts
await supabase
  .from('contact_tags')
  .delete()
  .eq('contact_id', contactId)
  .eq('tag_id', tagId);
```

#### Criar e atribuir (get-or-create)

```ts
// 1. INSERT com retorno
const { data, error } = await supabase
  .from('tags')
  .insert({ user_id: userId, account_id: accountId, name: name.trim(), color })
  .select()
  .single();

// 2. Colisão de nome → busca a existente e segue para atribuição
if (error?.code === '23505') {
  const { data: existing } = await supabase
    .from('tags')
    .select('*')
    .ilike('name', name.trim())
    .maybeSingle();
  // → assignTag(existing.id)
}

// 3. Violação de RLS (agent tentando criar) → PostgREST 42501
if (error?.code === '42501') {
  /* toast: sem permissão */
}

// 4. Sucesso → assignTag(data.id)
```

Depende do índice único da §2.2 para que o passo 2 seja confiável. Sem ele, a criação concorrente gera duplicata em vez de `23505`.

`user_id` e `account_id` vêm de [`useAuth()`](../src/hooks/use-auth.tsx) — ambos obrigatórios (`account_id` é `NOT NULL` desde a 017, sem default).

### 5.3 Atualização otimista e rollback

Todas as mutações aplicam o efeito na UI **antes** da resposta — a lista é pequena e a percepção de latência domina a UX de etiquetagem.

```
toggle → aplica no estado local
       → dispara onTagsChanged (propaga p/ página, §4.2)
       → await mutação
       ├─ ok    → nada a fazer
       └─ erro  → reverte estado local + reverte onTagsChanged
                → toast.error (sonner, já usado no módulo)
```

A criação é a **exceção**: não é otimista, porque o `id` da nova etiqueta só existe após o round-trip. Mostra spinner no botão de criar (padrão de [tag-manager.tsx:244](../src/components/settings/tag-manager.tsx#L244)).

### 5.4 Matriz de erros

| Cenário                      | Código          | Tratamento                                                                                  |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Nome duplicado na criação    | `23505`         | Silencioso — busca a existente e atribui (é o comportamento desejado)                       |
| `agent` tenta criar etiqueta | `42501`         | `toast.error` com a mensagem de permissão. **Não deve acontecer** — a UI já é gatada (§2.1) |
| `viewer` tenta atribuir      | `42501`         | Idem. UI gatada por `canSendMessages`                                                       |
| Atribuição duplicada         | —               | Absorvido pelo `upsert`                                                                     |
| Rede offline                 | `PGRST`/network | Rollback + toast                                                                            |

### 5.5 Gating por role

```ts
import { canEditSettings, canSendMessages } from '@/lib/auth/roles';

const canAssign = accountRole ? canSendMessages(accountRole) : false; // agent+
const canCreate = accountRole ? canEditSettings(accountRole) : false; // admin+
```

Sempre pelos predicados de [`roles.ts`](../src/lib/auth/roles.ts) — nunca comparando strings de role inline, conforme a diretriz no cabeçalho do arquivo.

- `canAssign === false` → checkboxes desabilitados, `GatedButton` com `gateReason` explicativo.
- `canCreate === false` → seção de criação oculta, com nota curta ("Só administradores podem criar novas etiquetas").

---

## 6. Acessibilidade

- Trigger no `ConversationItem`: **não pode ser um `<button>` aninhado** — o item inteiro já é um `<button>` ([conversation-list.tsx:464](../src/components/inbox/conversation-list.tsx#L464)) e HTML proíbe botão dentro de botão (React avisa e o comportamento de clique quebra). **Refatorar o item para `<div role="button" tabIndex={0}>`** com handlers de teclado, ou posicionar o gatilho como irmão absoluto fora do `<button>`. Decisão de implementação, mas obrigatória.
- Todo clique no trigger precisa de `e.stopPropagation()` para não selecionar a conversa junto.
- `DialogTitle` e `DialogDescription` sempre presentes (base-ui exige para `aria-labelledby`/`describedby`).
- Chips coloridos: o nome da etiqueta é sempre texto legível — a cor é redundante, nunca a única portadora de informação.
- Foco: base-ui já faz trap e restauração ao fechar.

---

## 7. Internacionalização

Novo namespace `Inbox.tagPicker` em `messages/pt-BR.json` e `messages/en.json`:

| Chave                 | pt-BR                                             |
| --------------------- | ------------------------------------------------- |
| `title`               | `Etiquetas de {name}`                             |
| `description`         | `Atribua ou remova etiquetas deste lead.`         |
| `searchPlaceholder`   | `Buscar ou criar etiqueta...`                     |
| `createTag`           | `Criar "{name}"`                                  |
| `noTags`              | `Nenhuma etiqueta ainda`                          |
| `noResults`           | `Nenhuma etiqueta encontrada`                     |
| `creating`            | `Criando...`                                      |
| `close`               | `Fechar`                                          |
| `manageTags`          | `Gerenciar etiquetas`                             |
| `removeTag`           | `Remover etiqueta {name}`                         |
| `onlyAdminsCanCreate` | `Só administradores podem criar novas etiquetas.` |
| `failedToAssign`      | `Falha ao atribuir etiqueta`                      |
| `failedToRemove`      | `Falha ao remover etiqueta`                       |
| `failedToCreate`      | `Falha ao criar etiqueta`                         |

As cores do `PRESET_COLORS` já têm traduções em `Settings.tagsAndFields.colors.*` — **reutilizar** essas chaves nos `aria-label` do seletor de cor, não duplicar.

---

## 8. Plano de implementação

Todas as etapas foram entregues.

| #   | Etapa                                                                                                                                                                           | Status                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Decidir §2.1 (opção A/B/C)                                                                                                                                                      | ✅ Opção A                 |
| 2   | Migração [`038_tags_unique_name.sql`](../supabase/migrations/038_tags_unique_name.sql) + dedupe                                                                                 | ✅ criada (ver §10)        |
| 3   | `Tag.account_id` em [`types/index.ts`](../src/types/index.ts)                                                                                                                   | ✅                         |
| 4   | [`src/lib/tags.ts`](../src/lib/tags.ts) (helpers + `PRESET_COLORS` extraído)                                                                                                    | ✅                         |
| 5   | [`use-contact-tags.ts`](../src/components/inbox/tag-picker/use-contact-tags.ts) (hook de dados + otimista)                                                                      | ✅                         |
| 6   | [`tag-picker-dialog.tsx`](../src/components/inbox/tag-picker/tag-picker-dialog.tsx) (UI pura)                                                                                   | ✅                         |
| 7   | [`tag-picker-context.tsx`](../src/components/inbox/tag-picker/tag-picker-context.tsx) (provider + hook)                                                                         | ✅                         |
| 8   | Fiação em [`inbox/page.tsx`](<../src/app/(dashboard)/inbox/page.tsx>) (`handleContactTagsChanged`)                                                                              | ✅                         |
| 9   | Trigger em [`contact-sidebar.tsx`](../src/components/inbox/contact-sidebar.tsx) + remoção do fetch de tags (§4.3)                                                               | ✅                         |
| 10  | Trigger em [`conversation-list.tsx`](../src/components/inbox/conversation-list.tsx) + refactor de a11y (§6)                                                                     | ✅                         |
| 11  | Chaves i18n nos 2 idiomas                                                                                                                                                       | ✅ 1630 chaves em paridade |
| 12  | Migrar [`tag-manager.tsx`](../src/components/settings/tag-manager.tsx) e [`contact-detail-view.tsx`](../src/components/contacts/contact-detail-view.tsx) para `src/lib/tags.ts` | ✅                         |

**Validação:** `tsc --noEmit` limpo · 629 testes passando · `eslint` com 0 erros · `next build` OK · `i18n:check` em paridade.

## 9. Desvios do as-built

Três pontos em que a implementação divergiu do que este SPEC previa. Ficam registrados porque cada um foi uma decisão, não um esquecimento.

### 9.1 Sem `×` de remoção rápida nos chips da sidebar

A §3.4 previa que os chips da `ContactSidebar` ganhassem um `×`. **Não foi implementado.** Dois motivos: contradiz o requisito de centralizar criar/atribuir/remover num único modal, e obrigaria a sidebar a ter caminho de mutação próprio (duplicando a lógica otimista + a propagação da §4.2).

A sidebar ficou com um `+` no cabeçalho da seção que abre o picker. Toda escrita passa por lá.

### 9.2 O trigger da lista é sempre visível abaixo de `lg`

O gatilho no `ConversationItem` foi escrito primeiro como hover-only, o que o tornaria **inalcançável em toque** — e, como a §3.7 já apontava, no mobile a lista de conversas é o único caminho até o modal (`ContactSidebar` é `hidden lg:block`).

Resolvido com `lg:opacity-0 lg:group-hover:opacity-100`: sempre visível no mobile, revelado no hover/foco apenas no desktop.

### 9.3 `fetchContactTags` e `PG_INSUFFICIENT_PRIVILEGE` descartados

A §5.2 previa ambos em `src/lib/tags.ts`. Nenhum dos dois ganhou consumidor:

- `fetchContactTags` — o desenho semeia as etiquetas de `contact.tags`, já hidratado pela página. Buscá-las de novo recriaria a segunda fonte de verdade que a §4.3 existe para eliminar.
- `PG_INSUFFICIENT_PRIVILEGE` — o `42501` já cai no toast genérico de falha; a constante ficaria como documentação sem uso.

Em vez de exportar código morto, `src/lib/tags.ts` carrega um comentário explicando por que `fetchContactTags` não existe.

## 10. Pendências operacionais

- [ ] **Aplicar a migração 038.** O arquivo existe, mas não foi executado. É uma operação destrutiva (consolida etiquetas duplicadas). Recomendado: rodar antes o `SELECT` de pré-visualização — ver o cabeçalho da migração — e aplicar primeiro num branch do Supabase.
- [ ] **Commit.** As mudanças estão no working tree, não versionadas.

## 11. Critérios de aceite

Verificados por build/teste automatizado:

- [x] Nenhuma string hard-coded — tudo via `useTranslations`, nos dois idiomas.
- [x] Sem `<button>` aninhado (o `ConversationItem` virou `div[role=button]` com handlers de teclado).
- [x] `tsc`, `eslint`, `next build` e a suíte de testes passam.

Pendentes de verificação manual no app:

- [ ] Abrir o modal a partir de um item da lista de conversas não seleciona a conversa.
- [ ] Abrir o modal a partir da sidebar de contato funciona com o painel aberto.
- [ ] Atribuir uma etiqueta reflete imediatamente nos chips da sidebar **e** no filtro por etiqueta da lista, sem reload.
- [ ] Remover uma etiqueta idem.
- [ ] Com o filtro por etiqueta ativo, atribuir a etiqueta filtrada faz a conversa aparecer na lista; remover faz sumir.
- [ ] `admin` vê e usa o botão "Criar" no modal; a etiqueta nasce já atribuída ao lead.
- [ ] Criar etiqueta com nome já existente (case-insensitive) atribui a existente, sem duplicar — **requer a migração 038 aplicada**.
- [ ] `agent` não vê o formulário de criação e recebe a nota `onlyAdminsCanCreate`.
- [ ] `viewer` não consegue atribuir nem remover.
- [ ] Falha de rede reverte o estado otimista e mostra toast.
- [ ] Duplo-clique rápido em uma etiqueta não gera erro `23505` visível.
- [ ] O modal é utilizável em viewport de 375px.
