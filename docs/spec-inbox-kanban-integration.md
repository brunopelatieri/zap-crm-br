# SPEC — Criação de Negócio (Kanban) a partir do Inbox

**Status:** 📋 Especificado — aguardando implementação
**Módulo:** `src/components/inbox`
**Data:** 2026-08-04
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Referência de padrão:** [spec-inbox-tag-management.md](spec-inbox-tag-management.md)

> **Quem pode fazer o quê (resumo):**
>
> | Ação                               | Role mínima     | Onde                          |
> | ---------------------------------- | --------------- | ----------------------------- |
> | **Criar** negócio a partir do lead | `agent`         | Botão "＋" da seção Negócios  |
> | Escolher funil / etapa             | `agent`         | Selects do modal              |
> | Ver os negócios do lead            | qualquer membro | Cards da sidebar              |
> | Criar / editar **funis e etapas**  | `admin`         | Fora de escopo — `/pipelines` |
>
> Diferente das etiquetas (onde criar era `admin+`), aqui a criação é
> `agent+`: `deals` é **dado operacional**, não configuração de conta.
> Ver §2.1.

---

## 1. Contexto e escopo

### 1.1 O que já existe

Esta feature **não cria modelo de dados**. Todo o esquema de funil já está no banco desde a migração 001; o que falta é uma superfície de UI no Inbox.

| Peça existente           | Localização                                                                                                                                                                                                                                          | Papel                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Tabela `pipelines`       | [001_initial_schema.sql:234](../supabase/migrations/001_initial_schema.sql#L234) + `account_id` na [017](../supabase/migrations/017_account_sharing.sql)                                                                                             | Funil de negócios (escopo de conta)                            |
| Tabela `pipeline_stages` | [001_initial_schema.sql:248](../supabase/migrations/001_initial_schema.sql#L248)                                                                                                                                                                     | Coluna/etapa, ordenada por `position`. **Sem `account_id`**    |
| Tabela `deals`           | [001:267](../supabase/migrations/001_initial_schema.sql#L267) + [002](../supabase/migrations/002_pipelines_enhancements.sql) + [004](../supabase/migrations/004_contact_delete_set_null.sql) + [017](../supabase/migrations/017_account_sharing.sql) | Card/negócio, com `contact_id` nullable                        |
| Board Kanban             | [pipelines/page.tsx](<../src/app/(dashboard)/pipelines/page.tsx>) + [pipeline-board.tsx](../src/components/pipelines/pipeline-board.tsx)                                                                                                             | Drag-drop entre etapas, seed do funil padrão                   |
| Formulário completo      | [deal-form.tsx](../src/components/pipelines/deal-form.tsx)                                                                                                                                                                                           | Sheet de criar/editar/status/excluir, a partir de `/pipelines` |
| Seed do funil padrão     | [default-stages.ts](../src/lib/pipelines/default-stages.ts)                                                                                                                                                                                          | `DEFAULT_STAGE_DEFS`, `isStockDefaultPipeline()`               |
| Criação automática       | [engine.ts:598](../src/lib/automations/engine.ts#L598) (step `create_deal`)                                                                                                                                                                          | Já cria deal a partir de `contactId` — **via service role**    |
| Exibição no Inbox        | [contact-sidebar.tsx:226](../src/components/inbox/contact-sidebar.tsx#L226)                                                                                                                                                                          | **Somente leitura** hoje                                       |

### 1.2 O que esta feature entrega

Um **modal único** acionado pela seção "Negócios" da `ContactSidebar` que permite, sem sair da conversa:

1. **Escolher o funil** entre os funis da conta;
2. **Escolher a etapa** dentro do funil escolhido (lista recarrega ao trocar de funil);
3. **Definir o título** do card e criá-lo, já vinculado ao contato ativo.

Opcionalmente, no mesmo modal: **valor + moeda** e **responsável**.

### 1.3 Fora de escopo

- **Editar / mover / fechar** negócios a partir do Inbox → continua em `/pipelines` ([deal-form.tsx](../src/components/pipelines/deal-form.tsx)). A sidebar segue somente-leitura para deals existentes.
- **Criar funil ou etapa** on the fly. A RLS de `pipelines` e `pipeline_stages` é `admin+`, e criar configuração de conta a partir do Inbox contradiz a mesma decisão tomada na §2.1 da SPEC de etiquetas. Conta sem funil → estado vazio com link (§3.6).
- Campos `expected_close_date`, `notes`, `conversation_id`. Os dois primeiros ficam para `/pipelines`; `conversation_id` existe na tabela mas **nunca é gravado por nenhum caminho do app** hoje — passar a gravá-lo só aqui criaria uma inconsistência de dado que ninguém lê. Registrado como pendência (§10).
- Aviso de negócio duplicado ("este lead já tem um negócio aberto neste funil"). Exigiria que o modal conhecesse a lista de deals da sidebar; barato de adicionar depois, sem valor comprovado agora.
- Reordenação dentro da etapa — `deals` **não tem coluna de posição** (§2.3).

---

## 2. Restrições descobertas na análise

### 2.1 A RLS aqui é o inverso da das etiquetas

```sql
-- supabase/migrations/017_account_sharing.sql:467-470
CREATE POLICY pipelines_select ON pipelines FOR SELECT USING (is_account_member(account_id));
CREATE POLICY pipelines_insert ON pipelines FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY pipelines_update ON pipelines FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY pipelines_delete ON pipelines FOR DELETE USING (is_account_member(account_id, 'admin'));

-- supabase/migrations/017_account_sharing.sql:474-477
CREATE POLICY deals_select ON deals FOR SELECT USING (is_account_member(account_id));
CREATE POLICY deals_insert ON deals FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));  -- ⚠️ agent+
CREATE POLICY deals_update ON deals FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY deals_delete ON deals FOR DELETE USING (is_account_member(account_id, 'agent'));

-- supabase/migrations/017_account_sharing.sql:555-563 — tenancy via join em `pipelines`
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id
          AND is_account_member(p.account_id))
);
CREATE POLICY pipeline_stages_modify ON pipeline_stages FOR ALL USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id
          AND is_account_member(p.account_id, 'admin'))
) WITH CHECK ( /* idem */ );
```

Consequência: **o operador típico do Inbox (`agent`) pode criar negócios sem nenhuma concessão nova.** Não há aqui o dilema da §2.1 da SPEC de etiquetas — nenhuma opção A/B/C a decidir, nenhuma migração de RLS a considerar.

O que ele **não** pode é criar funis ou etapas, o que é coerente com [`roles.ts:79`](../src/lib/auth/roles.ts#L79): `canEditSettings` (admin+) cobre explicitamente _"pipelines, tags, custom fields"_ — o **catálogo** de funis é configuração; os **cards** são operação.

Gates a usar, sempre pelos predicados de [`roles.ts`](../src/lib/auth/roles.ts), nunca comparando strings de role inline:

```ts
import { canSendMessages } from '@/lib/auth/roles';

const canCreateDeal = accountRole ? canSendMessages(accountRole) : false; // agent+
```

- `canCreateDeal === false` (viewer) → o botão "＋" da seção vira [`GatedButton`](../src/components/ui/gated-button.tsx) com `gateReason`; o modal não abre.

### 2.2 Tipos `Pipeline` e `Deal` desatualizados

[`src/types/index.ts:396`](../src/types/index.ts#L396) e [`:414`](../src/types/index.ts#L414) declaram:

```ts
export interface Pipeline {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}
```

Falta `account_id` em **ambos** — coluna `NOT NULL` desde a 017 e obrigatória em todo insert de `deals`. É exatamente o defeito que a §2.3 da SPEC de etiquetas corrigiu para `Tag`; a correção não foi propagada para estas duas interfaces. Corrigir como parte desta entrega:

```ts
export interface Pipeline {
  id: string;
  user_id: string;
  /** Chave de tenancy — NOT NULL desde a migração 017. */
  account_id: string;
  name: string;
  created_at: string;
}

export interface Deal {
  id: string;
  user_id: string;
  /** Chave de tenancy — NOT NULL desde a migração 017. */
  account_id: string;
  pipeline_id: string;
  // … resto inalterado
}
```

`PipelineStage` **não** ganha `account_id`: a tabela genuinamente não tem a coluna (herda tenancy via `pipeline_id`, igual a `contact_tags`). Não adicionar ao tipo — enviá-la num insert futuro faria a escrita falhar.

### 2.3 Nenhuma migração é necessária

Diferente da SPEC de etiquetas (que precisou da [038](../supabase/migrations/038_tags_unique_name.sql) para tornar o get-or-create atômico), aqui **não há nada a mudar no banco**:

- `deals.contact_id` já é FK para `contacts` (nullable desde a 004);
- `deals.account_id`, `user_id`, `pipeline_id`, `stage_id` já existem e são obrigatórios;
- `status` já tem `CHECK (status IN ('open','won','lost'))` com default `'open'`;
- não há requisito de unicidade — dois negócios com o mesmo título para o mesmo contato são legítimos.

**Limitação herdada, registrada e não resolvida aqui:** `deals` não tem coluna de ordenação dentro da etapa. O card criado aparece no board na posição ditada por `ORDER BY created_at DESC` ([pipelines/page.tsx:107](<../src/app/(dashboard)/pipelines/page.tsx#L107>)) — ou seja, no topo da coluna. Isso é o comportamento existente do módulo, não uma regressão desta feature.

---

## 3. Arquitetura de componentes

### 3.1 Por que um Provider com um único trigger

A SPEC de etiquetas justificou o provider por ter **dois** triggers em subárvores irmãs. Aqui há só um — o que enfraquece metade daquele argumento. A outra metade, porém, continua valendo e sozinha já decide:

```
InboxPage
├── ConversationList
├── MessageThread
└── {contactPanelOpen && (        ← DESMONTA ao colapsar o painel
      <div className="hidden lg:block">
        <ContactSidebar />        ← único trigger
      </div>
    )}
```

`ContactSidebar` é **removido da árvore** quando `contactPanelOpen === false` ([page.tsx:1156](<../src/app/(dashboard)/inbox/page.tsx#L1156>)). Um `<Dialog>` montado dentro dela desapareceria no meio do preenchimento, levando junto o título já digitado. Diferente do picker de etiquetas — cujas mutações são instantâneas — este modal tem **um formulário com rascunho**, então perder o estado é uma falha visível, não um detalhe.

Segundo motivo, menor mas real: um segundo gatilho (header do `MessageThread`, ou o `ConversationItem`) passa a custar uma linha. É a mesma economia que a §3.7 da SPEC de etiquetas antecipou e que a §9.2 confirmou ser necessária no mobile — e vale lembrar que `ContactSidebar` é `hidden lg:block`, ou seja, **nesta entrega a feature não existe abaixo de `lg`** (§3.7).

### 3.2 Árvore alvo

```
InboxPage
└── <TagPickerProvider onTagsChanged={handleContactTagsChanged}>
    └── <DealPickerProvider>              ← novo, aninhado dentro
        ├── ConversationList
        ├── MessageThread
        ├── ContactSidebar                → useDealPicker().open(contact, { onCreated })
        └── <DealPickerDialog />          ← instância única, montada aqui
```

Aninhar dentro do `TagPickerProvider` (e não ao lado) é arbitrário quanto ao comportamento — nenhum dos dois consome o outro. Escolhido por manter um único ponto de indentação no JSX da página.

### 3.3 Arquivos novos

| Arquivo                                                    | Responsabilidade                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/inbox/deal-picker/deal-picker-context.tsx` | Context + `DealPickerProvider` + hook `useDealPicker()`. Guarda `contact` e o `onCreated` do trigger. Renderiza `<DealPickerDialog />`. |
| `src/components/inbox/deal-picker/deal-picker-dialog.tsx`  | UI do modal: selects de funil/etapa, campos de título/valor/moeda/responsável, botões. **Sem lógica de rede.**                          |
| `src/components/inbox/deal-picker/use-deal-draft.ts`       | Hook de dados: carrega funis, carrega etapas sob demanda (com cache), mantém o rascunho, expõe `submit()`.                              |
| `src/lib/pipelines/deals.ts`                               | Helpers puros de leitura/mutação Supabase (`fetchPipelines`, `fetchStages`, `createDeal`) — testáveis, reutilizáveis fora do Inbox.     |

A pasta `src/lib/pipelines/` já existe ([default-stages.ts](../src/lib/pipelines/default-stages.ts)) — o helper entra ao lado, não em `src/lib/deals.ts` solto.

### 3.4 Arquivos alterados

| Arquivo                                                              | Alteração                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`inbox/page.tsx`](<../src/app/(dashboard)/inbox/page.tsx>)          | Envolve o conteúdo com `<DealPickerProvider>` (linhas 1044/1162, dentro do `TagPickerProvider`). **Nenhum estado novo.**                                                                    |
| [`contact-sidebar.tsx`](../src/components/inbox/contact-sidebar.tsx) | Seção "Negócios" ganha botão "＋" gatado; `handleDealCreated` faz prepend em `deals`.                                                                                                       |
| [`src/types/index.ts`](../src/types/index.ts)                        | `Pipeline.account_id` e `Deal.account_id` (§2.2).                                                                                                                                           |
| [`deal-form.tsx`](../src/components/pipelines/deal-form.tsx)         | Migrar o insert de `handleSave` para `createDeal()` de `src/lib/pipelines/deals.ts` — mesma consolidação que a etapa 12 da SPEC de etiquetas fez com `tag-manager` e `contact-detail-view`. |
| `messages/pt-BR.json`, `messages/en.json`                            | Novas chaves em `Inbox.dealPicker` e `Inbox.sidebar.newDeal` (§7).                                                                                                                          |

### 3.5 Contrato do modal

```ts
// deal-picker-context.tsx
interface DealPickerContextValue {
  /**
   * Abre o modal para o contato informado.
   *
   * `onCreated` é por-chamada, e não uma prop do provider (como o
   * `onTagsChanged` do TagPickerProvider): ver §4.2 para o porquê.
   */
  open: (
    contact: Contact,
    options?: { onCreated?: (deal: Deal) => void }
  ) => void;
  close: () => void;
  /** Contato atualmente no modal, ou null quando fechado. */
  contact: Contact | null;
  isOpen: boolean;
}

interface DealPickerProviderProps {
  children: ReactNode;
  // Sem `onCreated` aqui — nenhum estado da página depende de deals.
}
```

`isOpen` é **derivado** de `contact !== null`, não um segundo `useState` — mesma construção de [tag-picker-context.tsx:64](../src/components/inbox/tag-picker/tag-picker-context.tsx#L64), que elimina por construção o estado inconsistente "aberto sem contato".

`useDealPicker()` **lança** fora do provider, pelo mesmo motivo declarado em [tag-picker-context.tsx:91](../src/components/inbox/tag-picker/tag-picker-context.tsx#L91): um trigger que não abre nada é um bug silencioso.

### 3.6 Layout do modal

Usa os primitivos existentes: [`Dialog`](../src/components/ui/dialog.tsx) (base-ui), [`Input`](../src/components/ui/input.tsx), [`Label`](../src/components/ui/label.tsx), [`Button`](../src/components/ui/button.tsx), [`GatedButton`](../src/components/ui/gated-button.tsx).

> **Selects: `<select>` nativo, não [`ui/select.tsx`](../src/components/ui/select.tsx).** Todo o módulo de pipelines usa `<select>` cru com as mesmas classes ([deal-form.tsx:327,383,411,426](../src/components/pipelines/deal-form.tsx#L327)). Introduzir o componente estilizado só aqui criaria dois visuais para a mesma escolha dentro da mesma feature. Se o design system for unificar isso, que seja num diff próprio.
>
> Também **não** introduzir `cmdk` / combobox — a proibição da §3.6 da SPEC de etiquetas continua valendo, e o número de funis por conta é de unidades, não centenas.

```
┌────────────────────────────────────────────┐
│ Novo negócio — Maria Silva             [×] │
│ O negócio será vinculado a este contato.   │
├────────────────────────────────────────────┤
│ Funil *                                    │
│ [ Funil de Vendas                     ▾ ]  │
│                                            │
│ Etapa *                                    │
│ [ Qualificação                        ▾ ]  │
│                                            │
│ Título *                                   │
│ [ Maria Silva                           ]  │
├────────────────────────────────────────────┤
│ ▸ Mais opções                              │   ← recolhido por padrão
│   Valor            Moeda                   │
│   [ 0          ]   [ BRL              ▾ ]  │
│   Responsável                              │
│   [ Não atribuído                     ▾ ]  │
├────────────────────────────────────────────┤
│                    [ Cancelar ] [ Criar ]  │
└────────────────────────────────────────────┘
```

**Comportamentos:**

- **Título pré-preenchido** com `contact.name || contact.phone`, editável e selecionado ao abrir. Torna o caso comum "criar e pronto" em dois cliques, sem digitação.
- **Valor, moeda e responsável ficam atrás de um disclosure "Mais opções", recolhido por padrão.** Foi assim que os três requisitos de campo foram conciliados: os 3 obrigatórios ficam sempre visíveis (o pedido "só os 3"), e os opcionais existem sem transformar o modal num segundo `deal-form.tsx`. Quem só quer registrar o lead no funil não vê os campos extras; quem já sabe o valor não precisa ir ao `/pipelines`.
- **Moeda** default = `useAuth().defaultCurrency` (a conta já tem `accounts.default_currency`, gerida em [deals-settings.tsx](../src/components/settings/deals-settings.tsx)). Lista de opções = `CURRENCIES` de [`src/lib/currency.ts`](../src/lib/currency.ts).
- **Responsável** default = "Não atribuído". Lista via [`useAccountMembers()`](../src/hooks/use-account-members.ts), que já existe e já é escopado por conta pela RLS de `profiles`. **Passar `enabled` = "modal aberto"** — o hook aceita a flag exatamente para não gastar a query quando o consumidor não precisa dela.
- **Botão Criar desabilitado** enquanto `!title.trim() || !pipelineId || !stageId`, espelhando [deal-form.tsx:513](../src/components/pipelines/deal-form.tsx#L513).
- **Sem submit por `Enter`** dentro do modal — em `deal-form.tsx` o formulário também não é um `<form>`. Manter a paridade evita que o mesmo gesto tenha efeitos diferentes nas duas telas.

**Estados especiais:**

| Situação                            | O que o modal mostra                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Carregando funis                    | `<Loader2 className="animate-spin">` no corpo (padrão do repo — **não há `ui/skeleton.tsx`**) |
| **Conta sem nenhum funil**          | Estado vazio: `noPipelines` + link para `/pipelines`. Botão Criar oculto. Ver nota abaixo.    |
| Funil selecionado sem nenhuma etapa | `noStages` + link para `/pipelines`. Botão Criar desabilitado (o `stage_id` é `NOT NULL`).    |
| Falha ao carregar funis / etapas    | `toast.error` + o modal permanece aberto com o corpo em estado vazio                          |

> **Por que não semear o funil padrão automaticamente.** `seedDefaultPipeline()` ([pipelines/page.tsx:121](<../src/app/(dashboard)/pipelines/page.tsx#L121>)) escreve em `pipelines` e `pipeline_stages`, ambas `admin+` na RLS (§2.1) — para o `agent`, que é justamente quem vive no Inbox, a semeadura falharia com 42501 e o beco sem saída continuaria, só que com um erro no lugar de uma explicação. O link é honesto para as duas roles.

### 3.7 Responsividade

O `DialogContent` do design system já é `w-full max-w-[calc(100%-2rem)] sm:max-w-sm` — o modal em si funciona em 375px.

**Mas a feature inteira é desktop-only nesta entrega:** o único trigger vive na `ContactSidebar`, que é `hidden lg:block` ([contact-sidebar.tsx:132](../src/components/inbox/contact-sidebar.tsx#L132) + o wrapper em [page.tsx:1157](<../src/app/(dashboard)/inbox/page.tsx#L1157>)). Abaixo de `lg` não há caminho até o modal.

É a mesma limitação que a §3.7 da SPEC de etiquetas apontou e que a §9.2 acabou tendo que resolver com um segundo trigger na lista. Aqui a diferença é que, para deals, o `ConversationItem` **não** é um bom lugar (criar um negócio exige contexto da conversa, não da lista). O caminho natural, quando o mobile virar requisito, é o header do `MessageThread` — e o desenho da §3.1 já o deixa barato. Registrado como pendência (§10), não como dívida oculta.

---

## 4. Gerenciamento de estado

### 4.1 Estado do provider

```ts
const [contact, setContact] = useState<Contact | null>(null);
const isOpen = contact !== null;

// O callback do trigger vive num ref, não no estado: trocá-lo não deve
// causar re-render, e ele precisa sobreviver ao unmount do trigger.
const onCreatedRef = useRef<((deal: Deal) => void) | undefined>(undefined);
```

### 4.2 Propagação da criação — mais simples que nas etiquetas, de propósito

A §4.2 da SPEC de etiquetas descreve o ponto mais delicado daquela feature: uma mutação de tag precisava atingir **três** destinos (`conversations[].contact.tags` nos dois feeds + `activeContact.tags`), porque o filtro por etiqueta da lista lê `conversation.contact.tags`.

**Aqui nada disso se aplica.** `deals` não aparece em `CONVERSATION_SELECT` ([src/lib/inbox/conversations.ts](../src/lib/inbox/conversations.ts)), não participa de nenhum filtro da lista, e a `ContactSidebar` é a **única** dona desse estado — ela o busca sozinha em `fetchContactData` ([contact-sidebar.tsx:49](../src/components/inbox/contact-sidebar.tsx#L49)).

Logo, o destino é um só, e ele é o próprio trigger:

```tsx
// contact-sidebar.tsx
const handleDealCreated = useCallback((deal: Deal) => {
  // A ordem espelha a query de `fetchContactData`
  // (`created_at desc`) — o mais novo entra no topo.
  setDeals((prev) => [deal, ...prev]);
}, []);

<button onClick={() => openDealPicker(contact, { onCreated: handleDealCreated })}>
```

**Divergência deliberada do padrão do tag-picker, e por quê:** `TagPickerProvider` recebe `onTagsChanged` como **prop do provider** porque quem precisava do callback era a _página_, não o trigger. Aqui quem precisa é o trigger. Passar por prop do provider obrigaria a página a carregar um callback sobre um estado que ela não tem — ou a levantar a lista de deals para o nível da página só para poder devolvê-la, o que é exatamente a "segunda fonte de verdade" que a §4.3 daquela SPEC existe para eliminar.

Consequência aceita: se o agente colapsar o painel de contato com o modal aberto, a `ContactSidebar` desmonta e o `onCreated` vira no-op. **Não é bug** — ao reabrir o painel, `fetchContactData` roda de novo (`useEffect` em [contact-sidebar.tsx:74](../src/components/inbox/contact-sidebar.tsx#L74)) e traz o negócio recém-criado. O modal, esse sim, sobrevive — que é a razão de existir do provider (§3.1).

### 4.3 Estado do rascunho (`use-deal-draft.ts`)

```ts
interface UseDealDraftResult {
  pipelines: Pipeline[];
  stages: PipelineStage[]; // do funil selecionado
  members: Profile[];
  loadingPipelines: boolean;
  loadingStages: boolean;
  submitting: boolean; // criação NÃO é otimista
  // rascunho controlado
  draft: DealDraft;
  setDraft: (patch: Partial<DealDraft>) => void;
  submit: () => Promise<void>;
}

interface DealDraft {
  pipelineId: string;
  stageId: string;
  title: string;
  value: string; // string, não number — é input controlado
  currency: string;
  assignedTo: string; // '' = não atribuído
}
```

Regras de sincronização:

- **Reset a cada abertura.** Ao `contact` mudar de `null` para um contato, o rascunho volta ao default (título = nome do contato, moeda = `defaultCurrency`, resto vazio). Mesmo padrão do `useEffect` de reset de [deal-form.tsx:98-122](../src/components/pipelines/deal-form.tsx#L98-L122), inclusive o `/* eslint-disable react-hooks/set-state-in-effect */` de bloco que aquele arquivo documenta como sync legítimo dirigido por prop.
- **Trocar de funil zera `stageId`** e dispara o carregamento das etapas do novo funil. Assim que elas chegam, seleciona a de menor `position`. Manter o `stageId` antigo seria pior que zerar: o insert falharia com FK violation (23503) contra um estágio de outro funil.
- **Cache de etapas por funil** num `Record<string, PipelineStage[]>` dentro do hook. O agente que alterna entre dois funis comparando etapas não paga round-trip a cada troca. O cache morre ao fechar o modal — funis e etapas são configuração, mudam raramente, e reabrir é a hora certa de repuxar.
- **Todo fetch usa a flag `cancelled` no cleanup**, convenção universal dos hooks do repo ([use-account-members.ts:39](../src/hooks/use-account-members.ts#L39), [use-contact-tags.ts:93](../src/components/inbox/tag-picker/use-contact-tags.ts#L93), [deal-form.tsx:128](../src/components/pipelines/deal-form.tsx#L128)).

### 4.4 Último funil usado

Uma conta com 3 funis faz o agente reescolher o mesmo funil a cada negócio. Persistir a última escolha em `localStorage` resolve, e é padrão estabelecido no repo — [page.tsx:130-149](<../src/app/(dashboard)/inbox/page.tsx#L130-L149>) (painel de contato) e [flow-editor-shell.tsx:72-90](../src/components/flows/flow-editor-shell.tsx#L72-L90) (modo de edição de flow) fazem exatamente isso.

Copiar as duas precauções que aqueles dois arquivos documentam:

1. **Ler só depois do mount**, nunca no inicializador do `useState` — senão o HTML do servidor e o do cliente divergem e a hidratação quebra.
2. **`try/catch` em volta de `getItem`/`setItem`** — `localStorage` lança em navegação privativa e em contexto sandboxed.

Chave sugerida: `zapcrm:inbox:last-pipeline-id`. Se o id salvo não existir mais na lista de funis (funil excluído), cai no primeiro funil sem erro.

### 4.5 Realtime

Não há canal realtime para `deals` — [`use-realtime.ts`](../src/hooks/use-realtime.ts) não cobre a tabela, e o próprio board de `/pipelines` só atualiza por refetch manual.

**Não adicionar um nesta entrega**, pela mesma razão da §4.5 da SPEC de etiquetas: o `useRealtime` do Inbox já está sob pressão (ver o comentário sobre `knownConvIdsRef` em [page.tsx:99](<../src/app/(dashboard)/inbox/page.tsx#L99>) e o histórico das issues #105/#106). O refetch da sidebar por troca de conversa já cobre o caso multi-agente com latência aceitável para este dado.

---

## 5. API e fluxo de dados

### 5.1 Estratégia: Supabase client direto

Mantém o padrão dominante — e, no caso de `deals`/`pipelines`, o **único**: não existe nenhuma server action, API route ou hook de dados para essas tabelas em todo o repo. `pipelines/page.tsx`, `deal-form.tsx`, `pipeline-settings.tsx` e a própria `contact-sidebar.tsx` falam `createClient()` do browser.

A justificativa é a mesma da §5.1 da SPEC de etiquetas: as RLS da §2.1 são a fronteira de autorização real, e uma rota intermediária adicionaria latência sem adicionar segurança.

> As rotas em `src/app/api/v1/*` são a **API pública** (autenticada por API key, ver [docs/public-api.md](public-api.md)), não a camada de acesso do app. Não é o lugar desta feature.
>
> **Nota sobre validação:** o repo não usa `zod` no app Next.js (só no `mcp-server/`). Não introduzir a dependência aqui — a validação segue imperativa e client-side, como em [deal-form.tsx:201](../src/components/pipelines/deal-form.tsx#L201), com a RLS e o `CHECK` de `status` como barreira real.

### 5.2 Operações

Todas em `src/lib/pipelines/deals.ts`, funções puras recebendo o client como primeiro argumento — mesma convenção de [`src/lib/tags.ts`](../src/lib/tags.ts), que a documenta: mantém o módulo testável sem mock de rede e deixa o chamador escolher entre o client de browser e o de servidor.

#### Listar funis

```ts
export async function fetchPipelines(
  supabase: SupabaseClient
): Promise<Pipeline[]> {
  const { data, error } = await supabase
    .from('pipelines')
    .select('*')
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as Pipeline[];
}
```

Sem `.eq('account_id', ...)` — a RLS `pipelines_select` faz o escopo, igual ao que `fetchTags` faz para o catálogo de etiquetas.

> **Diferença relevante do código existente:** `loadPipelines` em [pipelines/page.tsx:83](<../src/app/(dashboard)/pipelines/page.tsx#L83>) engole o erro (`console.error` + `return []`), o que faz "sem funis" e "falha de rede" ficarem indistinguíveis. O helper novo **lança**, e o hook decide o que mostrar (§3.6). Este é o mesmo tipo de correção que a §5.2 da SPEC de etiquetas aplicou ao trocar `insert` por `upsert`.

#### Listar etapas de um funil

```ts
export async function fetchStages(
  supabase: SupabaseClient,
  pipelineId: string
): Promise<PipelineStage[]> {
  const { data, error } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position');
  if (error) throw error;
  return (data ?? []) as PipelineStage[];
}
```

`ORDER BY position` (não `created_at`) — é a ordem que o board usa e a que o `pipeline-settings` reordena. `pipeline_stages` **não tem `account_id`**; a RLS resolve via join em `pipelines`.

#### Criar o negócio

```ts
export interface CreateDealInput {
  userId: string;
  accountId: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  value?: number;
  currency: string;
  assignedTo?: string | null;
}

export async function createDeal(
  supabase: SupabaseClient,
  input: CreateDealInput
): Promise<Deal> {
  const { data, error } = await supabase
    .from('deals')
    .insert({
      user_id: input.userId,
      account_id: input.accountId,
      pipeline_id: input.pipelineId,
      stage_id: input.stageId,
      contact_id: input.contactId,
      title: input.title.trim(),
      value: input.value ?? 0,
      currency: input.currency,
      assigned_to: input.assignedTo || null,
      status: 'open',
    })
    // O embed não é decorativo: a sidebar renderiza `deal.stage.color`
    // e `deal.stage.name` (contact-sidebar.tsx:248-257). Sem ele, o card
    // recém-criado apareceria sem a pílula da etapa até o próximo
    // refetch — e a única forma de evitar isso seria refazer a query
    // inteira de `fetchContactData` logo após o insert.
    .select('*, stage:pipeline_stages(*)')
    .single();

  if (error) throw error;
  return data as Deal;
}
```

`user_id` e `account_id` vêm de [`useAuth()`](../src/hooks/use-auth.tsx) — ambos obrigatórios; `account_id` é `NOT NULL` desde a 017 e **não tem default**.

`assigned_to: input.assignedTo || null` e não `?? null`: o select devolve `''` para "não atribuído", e `''` não é `null` para o `??`, o que faria o insert estourar contra a FK de `profiles`. É o mesmo cuidado de [deal-form.tsx:214](../src/components/pipelines/deal-form.tsx#L214).

**Migrar [deal-form.tsx:244](../src/components/pipelines/deal-form.tsx#L244) para este helper** como parte da entrega, e não depois: é a mesma consolidação que a etapa 12 da SPEC de etiquetas fez, e é o que impede as duas telas de divergirem na próxima correção.

### 5.3 Sem atualização otimista

A criação **não** é otimista, pelo mesmo motivo que a criação de etiqueta é a exceção na §5.3 da SPEC de etiquetas: o `id` do negócio só existe após o round-trip, e sem ele não há como renderizar o card nem como reverter. Somam-se dois motivos próprios:

- o `stage` embutido (`deal.stage.color/name`) só volta do servidor;
- diferente de um toggle de etiqueta, criar um negócio duas vezes por engano deixa lixo visível no board — a confirmação vale a espera.

Fluxo:

```
Criar → setSubmitting(true) → spinner no botão (padrão de deal-form.tsx:516)
      → await createDeal()
      ├─ ok   → onCreated(deal)          (§4.2, prepend na sidebar)
      │       → toast.success('Negócio criado')   [reusa Pipelines.form.toastCreated]
      │       → close()                  (o rascunho morre junto)
      └─ erro → toast.error, modal PERMANECE ABERTO com o rascunho intacto
              → setSubmitting(false)
```

Não fechar o modal no erro é deliberado: fechar descartaria o título digitado e obrigaria o agente a refazer tudo.

### 5.4 Matriz de erros

| Cenário                                                   | Código            | Tratamento                                                                                         |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `viewer` tenta criar                                      | `42501`           | `toast.error` de permissão. **Não deve acontecer** — a UI já é gatada por `canSendMessages` (§2.1) |
| Etapa/funil excluído por um admin entre o load e o submit | `23503` (FK)      | `toast.error` + recarrega os funis e limpa `stageId`. Modal segue aberto                           |
| Perfil sem conta vinculada (`accountId` null)             | —                 | Botão Criar desabilitado; toast reusando `Pipelines.form.toastNotLinked`                           |
| Sessão expirada                                           | —                 | Toast reusando `Pipelines.form.toastNotSignedIn`                                                   |
| Rede offline                                              | `PGRST` / network | Toast genérico `toastFailedCreate`; rascunho preservado                                            |
| Duplo-clique no botão Criar                               | —                 | Absorvido por `disabled={submitting}` — **não** há constraint de unicidade a proteger disso (§2.3) |

O `23503` merece tratamento próprio (e não o toast genérico) porque é o único caso em que o estado carregado pelo modal está comprovadamente velho: repuxar é a ação correta, e o agente não tem como adivinhar isso sozinho.

### 5.5 Gating por role

```ts
import { canSendMessages } from '@/lib/auth/roles';

const canCreateDeal = accountRole ? canSendMessages(accountRole) : false; // agent+
```

Sempre pelos predicados de [`roles.ts`](../src/lib/auth/roles.ts) — nunca comparando strings de role inline, conforme a diretriz no cabeçalho daquele arquivo. E **não** usar `useAuth().isAdmin`: aquele flag é estritamente `role === 'admin'` e exclui o `owner` (nota explícita em [roles.ts:110](../src/lib/auth/roles.ts#L110)).

- `canCreateDeal === false` → o "＋" da seção Negócios vira `GatedButton` com `gateReason`; `open()` nunca é chamado.

---

## 6. Acessibilidade

- O trigger é um `<button>` no cabeçalho da seção, **fora** de qualquer outro botão — não há o risco de aninhamento que a §6 da SPEC de etiquetas teve que resolver no `ConversationItem`. Segue o mesmo formato do "＋" de etiquetas já ali ([contact-sidebar.tsx:189-197](../src/components/inbox/contact-sidebar.tsx#L189-L197)), com `aria-label` e `title`.
- `DialogTitle` e `DialogDescription` **sempre presentes** — base-ui exige para `aria-labelledby`/`aria-describedby`.
- Todo `<select>` tem `<Label htmlFor>` associado; os três campos obrigatórios são marcados com `aria-required`.
- O disclosure "Mais opções" é um `<button aria-expanded>` controlando um bloco com `id` referenciado por `aria-controls`.
- Ao abrir, o foco vai para o campo de **título** (com o texto pré-preenchido selecionado), não para o primeiro select — é o campo que o usuário mais provavelmente quer alterar.
- Foco: base-ui já faz trap e restauração ao fechar.
- Erros de submit vão para `toast` (sonner), que já é anunciado por leitor de tela; o texto nunca depende de cor.

---

## 7. Internacionalização

Nenhuma string hard-coded — tudo via `useTranslations`, nos dois idiomas.

### 7.1 Reutilizar de `Pipelines.form.*`

O namespace já tem 42 chaves traduzidas nos dois idiomas. **Reusar**, não duplicar — mesmo princípio que a §7 da SPEC de etiquetas aplicou às cores de `Settings.tagsAndFields.colors.*`:

| Uso no modal             | Chave existente                    |
| ------------------------ | ---------------------------------- |
| Label "Título"           | `Pipelines.form.title`             |
| Placeholder do título    | `Pipelines.form.titlePlaceholder`  |
| Label "Etapa"            | `Pipelines.form.stage`             |
| Label "Valor"            | `Pipelines.form.value`             |
| Label "Moeda"            | `Pipelines.form.currency`          |
| Label "Atribuído a"      | `Pipelines.form.assignedTo`        |
| Opção "Não atribuído"    | `Pipelines.form.unassigned`        |
| Botão "Cancelar"         | `Pipelines.form.cancel`            |
| Botão "Criar negócio"    | `Pipelines.form.createDeal`        |
| Estado "Salvando..."     | `Pipelines.form.saving`            |
| Toast de sucesso         | `Pipelines.form.toastCreated`      |
| Toast de falha           | `Pipelines.form.toastFailedCreate` |
| Toast "não conectado"    | `Pipelines.form.toastNotSignedIn`  |
| Toast "perfil sem conta" | `Pipelines.form.toastNotLinked`    |

### 7.2 Chaves novas

Novo namespace `Inbox.dealPicker`:

| Chave                 | pt-BR                                                 | en                                                   |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `title`               | `Novo negócio — {name}`                               | `New deal — {name}`                                  |
| `description`         | `O negócio será vinculado a este contato.`            | `The deal will be linked to this contact.`           |
| `pipeline`            | `Funil`                                               | `Pipeline`                                           |
| `selectPipeline`      | `Selecione um funil`                                  | `Select a pipeline`                                  |
| `selectStage`         | `Selecione uma etapa`                                 | `Select a stage`                                     |
| `moreOptions`         | `Mais opções`                                         | `More options`                                       |
| `noPipelines`         | `Nenhum funil configurado nesta conta.`               | `No pipelines set up in this account.`               |
| `noStages`            | `Este funil ainda não tem etapas.`                    | `This pipeline has no stages yet.`                   |
| `goToPipelines`       | `Configurar funis`                                    | `Set up pipelines`                                   |
| `failedToLoad`        | `Falha ao carregar os funis`                          | `Failed to load pipelines`                           |
| `stageGone`           | `A etapa escolhida não existe mais. Selecione outra.` | `The selected stage no longer exists. Pick another.` |
| `onlyAgentsCanCreate` | `Você não tem permissão para criar negócios.`         | `You don't have permission to create deals.`         |

Uma chave nova em `Inbox.sidebar`, junto de `manageTags`:

| Chave     | pt-BR          | en         |
| --------- | -------------- | ---------- |
| `newDeal` | `Novo negócio` | `New deal` |

> Nomes de funil, etapa e membro **nunca** são traduzidos — são dados da conta.

---

## 8. Plano de implementação

| #   | Etapa                                                                                                        | Depende de |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | `Pipeline.account_id` e `Deal.account_id` em [`types/index.ts`](../src/types/index.ts) (§2.2)                | —          |
| 2   | `src/lib/pipelines/deals.ts` — `fetchPipelines`, `fetchStages`, `createDeal` (§5.2)                          | 1          |
| 3   | Chaves i18n nos 2 idiomas (§7)                                                                               | —          |
| 4   | `use-deal-draft.ts` — dados, cache de etapas, rascunho, `submit` (§4.3)                                      | 2          |
| 5   | `deal-picker-dialog.tsx` — UI pura, sem rede (§3.6)                                                          | 3, 4       |
| 6   | `deal-picker-context.tsx` — provider + hook (§3.5)                                                           | 5          |
| 7   | Fiação em [`inbox/page.tsx`](<../src/app/(dashboard)/inbox/page.tsx>) — envolver com o provider              | 6          |
| 8   | Trigger + `handleDealCreated` em [`contact-sidebar.tsx`](../src/components/inbox/contact-sidebar.tsx) (§4.2) | 7          |
| 9   | Migrar o insert de [`deal-form.tsx`](../src/components/pipelines/deal-form.tsx) para `createDeal` (§5.2)     | 2          |
| 10  | Último funil usado via `localStorage` (§4.4)                                                                 | 4          |

**Validação obrigatória antes de fechar:** `tsc --noEmit` limpo · `eslint` com 0 erros · suíte de testes passando · `next build` OK · `i18n:check` em paridade entre `pt-BR` e `en`.

---

## 9. Consistência com a SPEC de etiquetas

Onde esta especificação **espelha** o padrão aprovado, e onde diverge **de propósito**:

### 9.1 O que é idêntico

| Padrão                                                    | Etiquetas                                | Aqui                                    |
| --------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Provider no nível da página, `<Dialog>` montado uma vez   | `TagPickerProvider`                      | `DealPickerProvider`                    |
| `isOpen` derivado de `contact !== null`, nunca duplicado  | tag-picker-context.tsx:64                | §3.5                                    |
| Hook lança se usado fora do provider                      | tag-picker-context.tsx:91                | §3.5                                    |
| UI pura sem rede + hook de dados separado                 | `tag-picker-dialog` / `use-contact-tags` | `deal-picker-dialog` / `use-deal-draft` |
| Helpers puros em `src/lib`, client como 1º argumento      | `src/lib/tags.ts`                        | `src/lib/pipelines/deals.ts`            |
| Supabase client direto; RLS como fronteira de autorização | §5.1                                     | §5.1                                    |
| Gates por predicados de `roles.ts`, nunca string inline   | §5.5                                     | §5.5                                    |
| Criação não-otimista, com spinner no botão                | §5.3                                     | §5.3                                    |
| `toast` do sonner apenas na camada de dados               | use-contact-tags.ts                      | use-deal-draft.ts                       |
| Flag `cancelled` no cleanup de todo fetch                 | use-contact-tags.ts:93                   | §4.3                                    |
| Reusar chaves i18n existentes em vez de duplicar          | §7 (cores)                               | §7.1 (`Pipelines.form.*`)               |
| Consolidar o call site antigo no helper novo              | etapa 12                                 | etapa 9                                 |
| Corrigir o tipo desatualizado como parte da entrega       | §2.3 (`Tag.account_id`)                  | §2.2 (`Pipeline`/`Deal`)                |
| Sem realtime nesta entrega, com justificativa             | §4.5                                     | §4.5                                    |
| Sem dependência nova (`cmdk`, `zod`, combobox)            | §3.6                                     | §3.6, §5.1                              |

### 9.2 O que diverge, e por quê

| Ponto                          | Etiquetas                                    | Aqui                                          | Motivo                                                                                                                     |
| ------------------------------ | -------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Callback de mutação**        | Prop do provider (`onTagsChanged`)           | Por-chamada em `open(contact, { onCreated })` | Quem precisa do resultado é o trigger, não a página. `deals` não vive no estado da página (§4.2)                           |
| **Propagação**                 | 3 destinos, o ponto mais delicado da feature | 1 destino, o próprio trigger                  | `deals` não está em `CONVERSATION_SELECT` nem em nenhum filtro da lista                                                    |
| **Role para criar**            | `admin+` (etiqueta é configuração)           | `agent+` (negócio é dado operacional)         | A RLS já é assim; nenhuma decisão A/B/C a tomar (§2.1)                                                                     |
| **Migração**                   | 038 obrigatória (unicidade)                  | **Nenhuma**                                   | Esquema já suporta o caso; não há requisito de unicidade (§2.3)                                                            |
| **Mutação otimista**           | Toggle é otimista; só criar não é            | Nada é otimista                               | A única mutação da feature é a criação                                                                                     |
| **Persistência da escolha**    | Não se aplica                                | `localStorage` para o último funil (§4.4)     | Padrão já usado em `inbox/page.tsx` e `flow-editor-shell.tsx`                                                              |
| **Fonte de verdade do estado** | Sidebar deixou de ter fetch próprio (§4.3)   | Sidebar **mantém** seu fetch de deals         | Não há duplicação: a página não hidrata deals, então a sidebar é a única fonte — o problema que a §4.3 resolveu não existe |

---

## 10. Pendências e trabalho futuro

- [ ] **Mobile.** Nesta entrega a feature é desktop-only (`ContactSidebar` é `hidden lg:block`, §3.7). O caminho previsto é um segundo trigger no header do `MessageThread` — o desenho do provider (§3.1) já o deixa em ~1 linha.
- [ ] **`deals.conversation_id`.** A coluna existe e nenhum caminho do app a grava. Passar a gravá-la a partir do Inbox (onde a conversa é conhecida) é a oportunidade óbvia, mas exige decidir o comportamento nas outras telas — fica para um diff próprio (§1.3).
- [ ] **`loadPipelines` de `/pipelines`** continua engolindo o erro ([pipelines/page.tsx:83](<../src/app/(dashboard)/pipelines/page.tsx#L83>)). O helper novo lança; migrar aquele call site também seria coerente, mas está fora do escopo desta entrega.
- [ ] **Aviso de negócio duplicado** no mesmo funil (§1.3).

---

## 11. Critérios de aceite

Verificados por build / teste automatizado:

- [ ] Nenhuma string hard-coded — tudo via `useTranslations`, nos dois idiomas, com `i18n:check` em paridade.
- [ ] `tsc --noEmit`, `eslint`, `next build` e a suíte de testes passam.
- [ ] `deal-form.tsx` e o modal do Inbox usam o **mesmo** `createDeal` (etapa 9).
- [ ] Nenhuma dependência nova no `package.json`.

Verificados manualmente no app:

- [ ] O "＋" da seção Negócios abre o modal com o painel de contato aberto.
- [ ] O título vem pré-preenchido com o nome do contato e o foco cai nele, selecionado.
- [ ] Trocar de funil recarrega a lista de etapas e pré-seleciona a de menor `position`.
- [ ] Voltar ao funil anterior **não** dispara novo round-trip (cache da §4.3).
- [ ] Criar o negócio o faz aparecer **no topo** da lista de negócios da sidebar, com a pílula da etapa colorida, sem reload.
- [ ] O mesmo negócio aparece na coluna correta ao abrir `/pipelines`.
- [ ] Valor, moeda e responsável, quando preenchidos, chegam corretamente ao card.
- [ ] "Mais opções" começa recolhido e o negócio é criável sem abri-lo.
- [ ] Conta sem funis → estado vazio com link para `/pipelines`, sem botão Criar.
- [ ] Funil sem etapas → mensagem própria, botão Criar desabilitado.
- [ ] `viewer` não vê o "＋" habilitado e recebe o `gateReason` no hover.
- [ ] `agent` cria normalmente (sem 42501).
- [ ] Falha de rede mantém o modal aberto com o rascunho intacto e mostra toast.
- [ ] Duplo-clique rápido em "Criar" não gera dois negócios.
- [ ] Colapsar o painel de contato com o modal aberto **não** fecha o modal; ao reabrir o painel, o negócio criado está lá.
- [ ] Reabrir o modal pré-seleciona o último funil usado, mesmo após recarregar a página.
- [ ] O modal é utilizável em viewport de 375px (ainda que só alcançável em ≥ `lg` nesta entrega).
