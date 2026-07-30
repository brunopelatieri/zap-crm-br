# SPEC — Edição de Etiquetas + Seletor de Cor Customizada (Configurações)

**Status:** ✅ Implementado — fases 1–5. Fase 6 (opcional) não executada. Ver §11 para os desvios do as-built.
**Módulo:** `src/components/settings` (rota `settings?tab=fields`)
**Data:** 2026-07-30
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Depende de:** [spec-inbox-tag-management.md](./spec-inbox-tag-management.md) (§2.1 gating por role, §2.2 índice único de nome)

> **Resumo em uma frase:** o card de Etiquetas passa a permitir **editar**
> nome e cor de uma etiqueta existente, e a seleção de cor deixa de ser
> limitada às 8 cores fixas — ganha grade estendida, `input[type=color]`
> nativo e entrada HEX manual, **sem nova dependência**.

| Ação                         | Role mínima     | Onde                            |
| ---------------------------- | --------------- | ------------------------------- |
| Ver etiquetas                | qualquer membro | Chips do card                   |
| **Criar** etiqueta           | `admin`         | Linha inline de criação         |
| **Editar** nome / cor (novo) | `admin`         | Clique no corpo do chip → modal |
| **Excluir** etiqueta         | `admin`         | Botão `×` do chip → confirmação |

---

## 1. Contexto e escopo

### 1.1 O que existe hoje

Estado levantado por leitura do código (o screenshot `image_ca1828.png`
não estava disponível no repositório; a UI descrita abaixo corresponde
exatamente ao que o componente renderiza hoje):

| Peça                         | Localização                                                                                | Papel                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Card de Etiquetas            | [tag-manager.tsx](../src/components/settings/tag-manager.tsx)                              | Lista chips, cria (linha inline), exclui (modal de confirmação)      |
| Painel que monta o card      | [fields-and-tags-panel.tsx](../src/components/settings/fields-and-tags-panel.tsx)          | `SettingsPanelHead` + `TagManager` + `CustomFieldsSettings`          |
| Paleta fixa                  | [tags.ts:33](../src/lib/tags.ts#L33) (`PRESET_COLORS`)                                     | 8 cores, `name` casando com `Settings.tagsAndFields.colors.*`        |
| Camada de mutação            | [tags.ts](../src/lib/tags.ts)                                                              | `createTag` (get-or-create), `assignTag`, `unassignTag`, `fetchTags` |
| Tipo                         | [types/index.ts:118](../src/types/index.ts#L118)                                           | `Tag { id, user_id, account_id, name, color, created_at }`           |
| RLS                          | [017_account_sharing.sql:393](../supabase/migrations/017_account_sharing.sql#L393)         | `tags_select` membro; `insert`/`update`/`delete` → `admin`           |
| Unicidade de nome            | [038_tags_unique_name.sql:112](../supabase/migrations/038_tags_unique_name.sql#L112)       | `UNIQUE (account_id, lower(name))`                                   |
| Swatches duplicados no Inbox | [tag-picker-dialog.tsx:202](../src/components/inbox/tag-picker/tag-picker-dialog.tsx#L202) | Mesma fileira de 8 botões, copiada                                   |

Limitações que esta feature ataca:

1. Uma etiqueta com nome errado ou cor ruim **só pode ser corrigida
   excluindo e recriando** — e excluir desvincula de todos os contatos
   (`ON DELETE CASCADE` em `contact_tags`), ou seja, perda de dado real
   para consertar um typo.
2. A cor está presa a 8 valores. Contas com muitas etiquetas acabam com
   cores repetidas, o que anula o propósito do código de cor.

### 1.2 O que esta feature entrega

1. **Modal de edição** de etiqueta existente (nome + cor), acionado pelo
   corpo do chip, com área de clique separada do `×` de exclusão.
2. **`TagColorPicker`** — componente único de seleção de cor, com:
   - as 8 cores de `PRESET_COLORS` (comportamento atual preservado);
   - um gatilho "cor personalizada" que abre `Popover` com grade
     estendida, `input[type=color]` e campo HEX;
   - prévia ao vivo do chip resultante.
3. Reuso desse picker na **linha de criação** (elimina a divergência
   visual entre criar e editar).
4. **`updateTag`** em `src/lib/tags.ts` — a mutação de UPDATE passa a
   morar na mesma camada única de `createTag`.
5. Helpers puros de cor (`src/lib/colors.ts`) com testes unitários.

### 1.3 Fora de escopo

- **Mesclar** etiquetas (renomear A para o nome de B ⇒ erro explícito, não merge).
- Alterar `PRESET_COLORS` (o conjunto e as chaves de tradução ficam como estão).
- Reordenar etiquetas / agrupar em categorias.
- Realtime: renomear em Configurações **não** reflete numa aba de Inbox já aberta (§5.4).
- Migrar o seletor do Inbox (`tag-picker-dialog.tsx`) para o novo picker — o
  componente é escrito para permitir isso, mas a troca é um follow-up (§8, Fase 5, opcional).
- Edição de campos personalizados (o outro card da mesma rota).

---

## 2. Restrições descobertas na análise

Cada item abaixo muda o desenho da feature — não são observações soltas.

### 2.1 `tags_update` exige `admin`, mas o card não tem gate nenhum hoje

`TagManager` renderiza a linha de criação e o `×` para **qualquer**
membro, incluindo `viewer`. Um `agent` que clicar recebe um `42501` da
RLS e o toast genérico `failedToCreateTag` — mensagem que não explica
nada. Ao adicionar edição, o problema triplicaria.

**Decisão:** gatar as três ações mutantes com `useCan('edit-settings')`
(o mesmo predicado que o painel já usa para o card de campos
personalizados) e mostrar uma nota de leitura apenas quando o usuário não
tem permissão. Isso alinha o card com o padrão do `TagPickerDialog`, que
já faz esse gate corretamente.

> Correção de dívida adjacente, deliberadamente incluída: sem ela, a
> feature nova nasce com o mesmo defeito.

### 2.2 `TagManager` lista por `user_id`, não por `account_id`

[tag-manager.tsx:65](../src/components/settings/tag-manager.tsx#L65) filtra
`.eq('user_id', userId)`, enquanto `fetchTags` de `lib/tags.ts` confia na
RLS (escopo de conta). Consequência atual: um admin **não vê** etiquetas
criadas por outro admin da mesma conta, embora possa editá-las via
qualquer outra tela.

**Decisão:** trocar o fetch local por `fetchTags(supabase)` da lib. Sem
isso, a tela de edição de catálogo edita um catálogo parcial — o que é
pior do que o bug de listagem isolado.

### 2.3 Renomear pode colidir com o índice único (23505)

`createTag` trata `23505` como "get-or-create" e devolve a etiqueta
existente. **Esse comportamento não pode ser copiado no update:** se o
usuário renomeia "Lead frio" para "Lead Frio " (que já existe), devolver
a outra etiqueta silenciosamente daria a impressão de sucesso e deixaria
duas etiquetas com o mesmo papel.

**Decisão:** `updateTag` propaga o conflito como erro tipado
(`TagNameConflictError`) e a UI mostra o erro **no campo de nome**, sem
fechar o modal. Checagem client-side prévia com `normalizeTagName` +
`findTagByName` (excluindo o próprio id) para feedback imediato; o erro
do banco continua sendo tratado, pois a checagem local perde corrida.

### 2.4 Cor arbitrária quebra o contraste do chip

O chip usa `backgroundColor: ${color}20` e `color: tag.color`
([tag-manager.tsx:168](../src/components/settings/tag-manager.tsx#L168)).
Com as 8 cores fixas (todas de luminância média) isso funciona nos dois
temas. Com HEX livre, `#000000` desaparece no tema escuro e `#ffff00`
desaparece no claro. O mesmo cálculo é replicado nos chips da lista de
conversas e da sidebar.

> ⚠️ **A calibragem desta seção não sobreviveu à medição — ver §11.1.**
> A métrica proposta abaixo reprova 6 dos 8 presets que já estão em
> produção. O implementado mede a cor contra a **superfície do card**,
> com limiar de **2:1**.

**Decisão:** não bloquear cores; **avisar**. O picker mostra prévia do
chip em fundo claro e escuro e exibe um aviso não-bloqueante quando o
contraste do texto sobre `${color}20` fica abaixo de ~3:1 (WCAG AA para
texto grande — o chip é `text-sm font-medium`, portanto o alvo formal
seria 4.5:1; usamos 3:1 como limiar de aviso porque o nome também é
transmitido por texto legível e por posição, nunca só pela cor).
Renderizar chips com cor corrigida automaticamente está **fora de
escopo** — mudaria a aparência de todas as etiquetas existentes.

### 2.5 Nenhuma biblioteca de color picker instalada

`package.json` não tem `react-colorful` nem equivalente; o design system
é Base UI + Tailwind v4. Adicionar dependência para um seletor usado em
uma tela não se justifica (mesmo raciocínio que descartou `cmdk` na
§4 do SPEC do Inbox).

**Decisão:** `input[type=color]` nativo (picker do SO, acessível por
teclado, zero bytes) + campo HEX + grade estendida gerada de constante
local. Sem dependência nova.

---

## 3. UI/UX — fluxo de interação

### 3.1 O chip vira dois alvos irmãos, não um alvo aninhado

Estrutura atual: `<span>` container com um `<button>` de exclusão dentro.
Estrutura alvo: **container não-clicável** com **dois botões irmãos**.

```
┌─────────────────────────────────────────┐
│  ● Newsletter        ✎ │ ×              │   ← hover
│  └──── botão editar ───┘  └─ botão ex.  │
└─────────────────────────────────────────┘
   corpo = alvo de edição      │ separador vertical
```

```tsx
// esqueleto (não é a implementação final)
<span
  className="group inline-flex items-center rounded-full ..."
  style={badgeStyle}
>
  <button type="button" onClick={() => openEdit(tag)} /* corpo */>
    <span className="size-2 rounded-full" /> {tag.name}
    <Pencil className="size-3 opacity-0 group-hover:opacity-70" />
  </button>
  <span aria-hidden className="mx-0.5 h-4 w-px bg-current/20" />
  <button type="button" onClick={() => confirmDelete(tag)} /* × */>
    <X className="size-3" />
  </button>
</span>
```

### 3.2 Como as áreas de clique são separadas (requisito crítico)

Seis medidas, em ordem de importância:

1. **Irmãos, não aninhados.** Botão dentro de botão é HTML inválido e
   produz propagação ambígua. Com dois `<button>` irmãos dentro de um
   `<span>` inerte, cada clique tem um único destino — não há
   `stopPropagation` a depender.
2. **Separador visual de 1px** (`bg-current/20`) entre corpo e `×`, mais
   `mx-0.5`. O usuário _vê_ onde uma zona termina.
3. **Alvo do `×` com no mínimo 28×28px** (`p-1.5` sobre um ícone de
   12px), acima do mínimo de 24px do WCAG 2.2 (2.5.8). Hoje o `×` tem
   `p-0.5` sobre `size-3` ≈ 16px — pequeno demais e colado no texto.
4. **Cursores distintos:** corpo `cursor-pointer` + `hover:brightness`,
   `×` com `hover:bg-black/10 dark:hover:bg-white/10` (o realce de fundo
   local confirma qual zona está armada antes do clique).
5. **`×` só aparece em hover/foco** em ponteiros finos
   (`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`),
   e **sempre visível** quando não há hover (`@media (hover: none)` →
   utilitário `not-hover:opacity-100`, ou fallback com breakpoint
   `max-lg:opacity-100`). Em toque, esconder o alvo é pior que mostrá-lo;
   em mouse, esconder reduz clique acidental sem custo de descoberta.
6. **A confirmação de exclusão permanece** como rede final. Nenhuma
   mudança aqui torna a exclusão irreversível em um clique — e é
   justamente por isso que o `×` pode continuar no chip.

Efeito colateral aceito: o chip fica ~10px mais largo em hover (ícone de
lápis + separador). Para evitar reflow da grade `flex-wrap`, o slot do
lápis é reservado com largura fixa e apenas a opacidade muda.

### 3.3 Por que modal, e não inline nem popover

| Opção                 | Avaliação                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modal (escolhido)** | O formulário tem nome + 8 swatches + gatilho custom + prévia + 2 botões. Cabe folgado, reusa `Dialog` já importado, é consistente com o modal de exclusão e com o `TagPickerDialog`.                    |
| Edição inline no chip | O chip vive num `flex-wrap`; transformá-lo em input reflui toda a grade e o texto do nome pode ser mais longo que o chip. Sem espaço para prévia.                                                       |
| Popover no chip       | `PopoverContent` tem `w-72` fixo. Caberia o nome + swatches, mas o picker custom já é um `Popover` — popover dentro de popover no Base UI é fonte de bug de foco e de posicionamento em telas pequenas. |

**Reuso:** o modal serve **apenas edição**. A criação continua na linha
inline (fluxo rápido, já familiar), mas passa a usar o mesmo
`TagColorPicker`. Unificar criação e edição num só modal é uma mudança de
produto não pedida.

### 3.4 Layout do modal de edição

```
┌────────────────────────────────────────────┐
│ 🏷  Editar etiqueta                    [×] │
│ Altere o nome e a cor. A mudança aparece   │
│ em todos os contatos com esta etiqueta.    │
├────────────────────────────────────────────┤
│ Nome                                       │
│ [ Newsletter                    ] 10/40    │
│ ⚠ Já existe uma etiqueta com esse nome.    │  ← só em conflito
│                                            │
│ Cor                                        │
│ ● ● ● ● ● ● ● ●  [🎨]   ← 8 presets + custom│
│                                            │
│ Prévia                                     │
│ ┌──────────────┬──────────────┐            │
│ │ ● Newsletter │ ● Newsletter │            │  claro / escuro
│ └──────────────┴──────────────┘            │
│ ⚠ Contraste baixo neste tema.              │  ← aviso, não bloqueio
├────────────────────────────────────────────┤
│                    [Cancelar] [Salvar]     │
└────────────────────────────────────────────┘
```

- `Salvar` desabilitado quando: nome vazio, nada mudou, conflito local
  detectado, ou salvamento em andamento (spinner no botão).
- `Enter` no campo de nome = Salvar. `Esc` = Cancelar (padrão do `Dialog`).
- Fechar com alterações pendentes **não** pede confirmação — o custo de
  refazer é baixo e um segundo modal sobre o primeiro é pior.

### 3.5 O picker de cor (`TagColorPicker`)

Fechado, é a fileira atual de swatches **mais** um nono botão: círculo
com gradiente cônico (arco-íris) e ícone `Pipette`. Quando a cor ativa
não é nenhum preset, esse botão exibe a cor escolhida e fica marcado.

Aberto (`Popover`, `w-72`):

```
┌──────────────────────────────────┐
│ Grade estendida (5 matizes × 6)  │  clique = seleciona e fecha
│  ■ ■ ■ ■ ■ ■                     │
│  ■ ■ ■ ■ ■ ■                     │
│  ■ ■ ■ ■ ■ ■                     │
│  ■ ■ ■ ■ ■ ■   (+ tons neutros)  │
│  ■ ■ ■ ■ ■ ■                     │
├──────────────────────────────────┤
│ [▮ nativo]  # [ 3b82f6      ]    │
│             ↑ valida ao digitar  │
└──────────────────────────────────┘
```

- **Grade estendida:** constante `EXTENDED_COLORS` em `src/lib/colors.ts`
  (matizes Tailwind em 3 tons cada + 3 neutros). Cobre 90% dos casos com
  um clique, sem abrir diálogo do SO.
- **`input[type=color]`:** para o "quero exatamente esta cor". Renderizado
  como swatch quadrado com o input real sobreposto e transparente
  (padrão comum; o input nativo não é estilizável entre navegadores).
  Atualiza o estado em `onChange` (contínuo enquanto arrasta).
- **Campo HEX:** aceita `#abc`, `abc`, `#aabbcc`, `AABBCC`. Normaliza
  para `#aabbcc` minúsculo. Enquanto inválido/incompleto, a borda fica
  `border-destructive` e o estado da cor **não** é atualizado (nada de
  prévia piscando a cada tecla).

---

## 4. Arquitetura de componentes

### 4.1 Árvore alvo

```
FieldsAndTagsPanel                              (inalterado)
└── TagManager                                  ALTERADO
    ├── TagBadge                                NOVO   (chip: corpo + ×)
    ├── linha de criação
    │   └── TagColorPicker                      NOVO   (substitui os swatches inline)
    ├── TagEditDialog                           NOVO
    │   ├── Input (nome)
    │   ├── TagColorPicker                      NOVO   (reuso)
    │   └── TagBadgePreview                     NOVO   (claro + escuro)
    └── Dialog de exclusão                      (inalterado)
```

### 4.2 Arquivos novos

| Arquivo                                        | Conteúdo                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/colors.ts`                            | `isValidHexColor`, `normalizeHexColor`, `relativeLuminance`, `contrastRatio`, `hasLowChipContrast`, `EXTENDED_COLORS`. Puro, sem React, sem I/O. |
| `src/lib/colors.test.ts`                       | Testes unitários (vitest) dos helpers acima.                                                                                                     |
| `src/components/settings/tag-color-picker.tsx` | `TagColorPicker` — presets + popover (grade, nativo, HEX).                                                                                       |
| `src/components/settings/tag-badge.tsx`        | `TagBadge` (corpo editável + `×`) e `TagBadgePreview` (só leitura, para o modal).                                                                |
| `src/components/settings/tag-edit-dialog.tsx`  | `TagEditDialog` — modal controlado de edição.                                                                                                    |

> **Localização de `TagColorPicker`:** fica em `components/settings` porque
> é onde nasce e é usado. O Inbox importar de `components/settings` já tem
> precedente invertido no repo (`custom-fields-settings.tsx` importa de
> `components/contacts`), então o follow-up de §1.3 não exige mover nada.

### 4.3 Arquivos alterados

| Arquivo                                   | Mudança                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/tags.ts`                         | `+ updateTag`, `+ TagNameConflictError`, `+ UpdateTagInput`. `createTag` intocado.                                                                             |
| `src/components/settings/tag-manager.tsx` | Usa `fetchTags` da lib (§2.2); gate `useCan('edit-settings')` (§2.1); renderiza `TagBadge`; monta `TagEditDialog`; troca swatches inline por `TagColorPicker`. |
| `messages/pt-BR.json`, `messages/en.json` | Novas chaves em `Settings.tagsAndFields` (§7).                                                                                                                 |

Nenhuma migração de banco é necessária: `tags.color` já é texto livre e
`tags_update` já existe desde a 017. Ver §5.5 para a `CHECK` opcional.

### 4.4 Contratos

```ts
// tag-color-picker.tsx
interface TagColorPickerProps {
  value: string; // hex normalizado, ex. '#10b981'
  onChange: (hex: string) => void; // só dispara com hex válido
  disabled?: boolean;
  /** 'sm' na linha de criação, 'md' no modal. */
  size?: 'sm' | 'md';
}

// tag-badge.tsx
interface TagBadgeProps {
  tag: Tag;
  /** Sem permissão → chip puramente informativo, sem lápis e sem ×. */
  canEdit: boolean;
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
}

// tag-edit-dialog.tsx
interface TagEditDialogProps {
  /** null = fechado. A identidade do objeto semeia o rascunho. */
  tag: Tag | null;
  /** Catálogo para a checagem local de nome duplicado (§2.3). */
  allTags: Tag[];
  onClose: () => void;
  /** Chamado após o UPDATE confirmado, com a linha devolvida pelo banco. */
  onSaved: (updated: Tag) => void;
}
```

`TagEditDialog` recebe `tag` por prop em vez de ler um context: ao
contrário do `TagPickerDialog` do Inbox (que tem múltiplos pontos de
acionamento e por isso justifica um Provider — §3.1 do SPEC do Inbox),
aqui existe **um único** ponto de acionamento, na mesma árvore. Provider
seria cerimônia sem ganho.

---

## 5. Estado e fluxo de dados

### 5.1 Estado no `TagManager`

```ts
const [tags, setTags] = useState<Tag[]>([]); // existente
const [editingTag, setEditingTag] = useState<Tag | null>(null); // NOVO
// tagToDelete / deleteDialogOpen / newTagName / selectedColor: mantidos
```

`editingTag` guarda o objeto inteiro (não só o id): o modal precisa de
`name` e `color` para semear o rascunho e comparar "mudou algo?".

### 5.2 Estado no `TagEditDialog`

Vive **dentro** do modal e é descartado ao fechar:

```ts
const [name, setName] = useState(tag?.name ?? '');
const [color, setColor] = useState(tag?.color ?? DEFAULT_TAG_COLOR);
const [saving, setSaving] = useState(false);
const [nameError, setNameError] = useState<string | null>(null);
```

**Semeadura:** o pai monta o modal com `key={tag?.id ?? 'none'}`. Trocar a
etiqueta editada remonta o componente e reinicializa o rascunho — sem
`useEffect` de sincronização (que é a fonte clássica de "abri a etiqueta
B e vi o nome da A").

Derivados (não são estado):

```ts
const trimmed = name.trim();
const dirty = trimmed !== tag.name || color !== tag.color;
const localConflict = allTags.some(
  (o) =>
    o.id !== tag.id && normalizeTagName(o.name) === normalizeTagName(trimmed)
);
const canSave = trimmed.length > 0 && dirty && !localConflict && !saving;
```

### 5.3 Persistência

Client Supabase direto, como todo o resto do módulo de configurações
(mesma decisão da §5.1 do SPEC do Inbox: a RLS já é a autoridade; uma
route handler só adicionaria um salto). Nova função na camada única:

```ts
// src/lib/tags.ts
export class TagNameConflictError extends Error {
  constructor(public readonly name: string) {
    super(`Tag name already in use: ${name}`);
    this.name = 'TagNameConflictError';
  }
}

export interface UpdateTagInput {
  id: string;
  name?: string; // já trimado pelo chamador
  color?: string; // hex normalizado
}

/**
 * Atualiza nome e/ou cor de uma etiqueta existente.
 *
 * Diferente de `createTag`, um 23505 aqui NÃO é get-or-create: o
 * usuário pediu para renomear ESTA etiqueta, e devolver outra
 * silenciosamente mesclaria duas etiquetas distintas (§2.3).
 *
 * `account_id` e `user_id` nunca são enviados: são imutáveis e a RLS
 * (`tags_update`, migração 017) resolve o escopo pelo `id`.
 */
export async function updateTag(
  supabase: SupabaseClient,
  { id, name, color }: UpdateTagInput
): Promise<Tag> {
  const patch: Record<string, string> = {};
  if (name !== undefined) patch.name = name;
  if (color !== undefined) patch.color = color;

  const { data, error } = await supabase
    .from('tags')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw new TagNameConflictError(name ?? '');
    }
    throw error;
  }
  return data as Tag;
}
```

Detalhes que importam:

- **`patch` parcial:** mandar `color` num update que só renomeia
  sobrescreveria uma cor alterada em paralelo por outro admin.
- **`.select().single()`** devolve a linha canônica, que é o que sobe para
  o estado do pai — nada de reconstruir o objeto no cliente.
- **`0 rows`** (id inexistente, ou RLS negando) faz `.single()` retornar
  erro `PGRST116`. A UI mapeia para "sem permissão ou etiqueta removida"
  e recarrega o catálogo.

### 5.4 Propagação da mudança

```
TagEditDialog.handleSave()
  → updateTag(...)                              (aguarda o banco)
  → onSaved(updatedRow)
      → setTags(prev => prev.map(t => t.id === updated.id ? updated : t))
      → setEditingTag(null)
      → toast.success('tagUpdated')
```

**Atualização confirmada, não otimista.** É a inversão consciente da
§5.3 do SPEC do Inbox, onde o toggle é otimista. A diferença: lá a
latência percebida importa (o operador etiqueta durante uma conversa) e o
efeito é um checkbox. Aqui o usuário já está num modal com botão de
salvar — 200ms de spinner é o feedback esperado — e um rollback visual de
nome/cor no meio de uma lista de chips é confuso. Em erro, o modal
permanece aberto com a mensagem, e nada no catálogo foi tocado.

**Outras telas.** `conversation-list.tsx`, `contact-sidebar.tsx`,
`contact-form.tsx`, `contact-detail-view.tsx`, `automation-builder.tsx` e
`step2-select-audience.tsx` cada uma busca o catálogo no próprio mount.
Um rename feito em Configurações **não** aparece numa aba de Inbox já
aberta até ela remontar. Aceito e documentado: Configurações é outra
rota, e voltar para o Inbox remonta a lista. Sincronizar exigiria
Supabase Realtime em `tags` ou um cache global — desproporcional para uma
mudança de configuração feita raramente por admins.

### 5.5 Validação de cor

Onde cada camada valida:

| Camada           | Regra                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `TagColorPicker` | Só chama `onChange` com `#rrggbb` minúsculo (`normalizeHexColor`).    |
| `TagEditDialog`  | Não habilita Salvar sem cor válida. Aviso de contraste é informativo. |
| `updateTag`      | Não valida formato — o contrato é receber hex já normalizado.         |
| Banco            | Sem `CHECK` hoje.                                                     |

**Migração opcional** (recomendada, mas separável):

```sql
-- 0XX_tags_color_format.sql
ALTER TABLE tags
  ADD CONSTRAINT tags_color_hex_chk CHECK (color ~* '^#[0-9a-f]{6}$');
```

Vale porque `tags` também é escrita por `resolve-import-tags.ts` (import
de CSV) e pelo fluxo n8n de ingestão de contatos, que não passam por este
picker. **Pré-requisito:** rodar
`SELECT DISTINCT color FROM tags WHERE color !~* '^#[0-9a-f]{6}$'` antes —
a constraint falha o `ALTER` se houver linha fora do formato.

### 5.6 Matriz de erros

| Situação                  | Código     | Tratamento                                                            |
| ------------------------- | ---------- | --------------------------------------------------------------------- |
| Nome duplicado (banco)    | `23505`    | `TagNameConflictError` → erro sob o campo, modal aberto               |
| Nome duplicado (local)    | —          | Salvar desabilitado + mensagem, sem ida ao banco                      |
| RLS nega (não-admin)      | `42501`    | Toast `onlyAdminsCanEdit`; ação já deveria estar gatada (gate furado) |
| Etiqueta sumiu / 0 linhas | `PGRST116` | Toast `tagNotFound` + `fetchTags` para ressincronizar; fecha o modal  |
| Rede / desconhecido       | —          | Toast `failedToUpdateTag`, modal aberto, rascunho preservado          |

---

## 6. Acessibilidade

- Corpo do chip: `<button>` real com
  `aria-label={t('editAria', { name })}` — não `div` com `onClick`.
- `×`: `aria-label={t('deleteAria', { name })}` (chave já existe).
- Ordem de tabulação por chip: corpo → `×`. `Enter`/`Space` no corpo abre
  o modal; o `×` oculto por opacidade permanece focável (é
  `opacity-0`, nunca `display:none`) e o `group-focus-within` o revela.
- Swatches: `role="radio"` dentro de `role="radiogroup"` com
  `aria-checked` — semanticamente é escolha única, e é o que o leitor de
  tela deve anunciar. (Hoje usa-se `aria-pressed` em botões soltos;
  mantido apenas se a implementação preferir não introduzir navegação por
  setas, caso em que `aria-pressed` continua aceitável.)
- Campo HEX: `<label>` associado, `aria-invalid` quando inválido,
  `aria-describedby` apontando para a mensagem de erro.
- `input[type=color]` é focável e operável por teclado nativamente; o
  swatch decorativo sobreposto leva `aria-hidden`.
- Aviso de contraste em `role="status"` (`aria-live="polite"`) — muda
  conforme o usuário arrasta a cor, e não deve interromper.
- A cor nunca é a única portadora de informação: o nome em texto está
  sempre presente, no chip e na prévia.

## 7. Internacionalização

Novas chaves em `Settings.tagsAndFields` (`messages/pt-BR.json` **e**
`messages/en.json` — ambos, sempre):

| Chave               | pt-BR                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| `editTag`           | "Editar etiqueta"                                                                  |
| `editTagDesc`       | "Altere o nome e a cor. A mudança aparece em todos os contatos com esta etiqueta." |
| `editAria`          | "Editar {name}"                                                                    |
| `nameLabel`         | "Nome"                                                                             |
| `colorLabel`        | "Cor"                                                                              |
| `customColor`       | "Cor personalizada"                                                                |
| `hexLabel`          | "Código HEX"                                                                       |
| `invalidHex`        | "Use um HEX de 3 ou 6 dígitos (ex.: #3b82f6)"                                      |
| `pickerNative`      | "Escolher no seletor do sistema"                                                   |
| `preview`           | "Prévia"                                                                           |
| `previewLight`      | "Tema claro"                                                                       |
| `previewDark`       | "Tema escuro"                                                                      |
| `lowContrast`       | "Contraste baixo — o nome pode ficar difícil de ler neste tema."                   |
| `nameInUse`         | "Já existe uma etiqueta com esse nome."                                            |
| `save`              | "Salvar"                                                                           |
| `saving`            | "Salvando..."                                                                      |
| `tagUpdated`        | "Etiqueta atualizada"                                                              |
| `failedToUpdateTag` | "Falha ao atualizar etiqueta"                                                      |
| `tagNotFound`       | "Etiqueta não encontrada — a lista foi recarregada."                               |
| `onlyAdminsCanEdit` | "Só administradores podem criar, editar ou excluir etiquetas."                     |

`cancel`, `deleteAria`, `nameRequired`, `useColor` e `colors.*` são
reusadas. Zero string literal em JSX.

---

## 8. Plano de implementação

| Fase | Entrega                                                                             | Verificação                                      |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1    | `src/lib/colors.ts` + `colors.test.ts`                                              | `npx vitest run src/lib/colors.test.ts`          |
| 2    | `updateTag` + `TagNameConflictError` em `lib/tags.ts`                               | typecheck; sem consumidor ainda                  |
| 3    | `TagColorPicker`; linha de criação passa a usá-lo                                   | criar etiqueta com cor custom persiste o hex     |
| 4    | `TagBadge` + `TagEditDialog`; `TagManager` ganha gate de role e `fetchTags` da lib  | matriz de §9                                     |
| 5    | Chaves de i18n nos dois locales                                                     | `npm run build` (next-intl acusa chave faltante) |
| 6    | _(opcional)_ migração da `CHECK` de cor; _(opcional)_ Inbox reusar `TagColorPicker` | query de §5.5 antes do `ALTER`                   |

Fases 1–2 são independentes de UI e podem ser revisadas em separado.

## 9. Critérios de aceite

1. Clicar no corpo de um chip abre o modal com nome e cor atuais preenchidos.
2. Clicar no `×` abre **apenas** a confirmação de exclusão — nunca o modal de edição.
3. Alternar entre dois chips diferentes nunca mostra o rascunho do anterior.
4. Salvar só nome mantém a cor; salvar só cor mantém o nome (verificado no banco, não só na UI).
5. Renomear para o nome de outra etiqueta (mesmo com caixa/espaços diferentes) bloqueia o Salvar e mostra `nameInUse`; nada é gravado.
6. Uma cor HEX arbitrária (ex.: `#7c3f00`) persiste e reaparece após recarregar a página.
7. HEX inválido/parcial nunca altera a prévia nem habilita o Salvar.
8. `#000000` e `#ffff00` são aceitos e disparam o aviso `lowContrast` no tema correspondente.
9. `viewer` e `agent` veem os chips sem lápis e sem `×`, mais a nota `onlyAdminsCanEdit`; nenhuma requisição de escrita é disparada.
10. Após editar, o chip no card reflete a mudança sem reload; voltar ao Inbox mostra o nome/cor novos.
11. Navegação só por teclado permite editar e excluir; `×` alcançável por Tab mesmo antes do hover.
12. Alvo do `×` mede ≥24×24px (medido no DevTools).
13. `npm run build` e `npx vitest run` passam.

## 10. Riscos

| Risco                                                                           | Mitigação                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Aparência do `input[type=color]` varia entre navegadores/SO                     | Input real transparente sobre swatch próprio; a grade estendida cobre o caso comum sem abrir o diálogo do SO    |
| Cores ruins degradam a legibilidade em todo o app                               | Aviso de contraste + prévia nos dois temas (§2.4); constraint opcional não impede cor feia, só formato inválido |
| Mudar o fetch para escopo de conta (§2.2) faz surgir etiquetas antes invisíveis | Comportamento correto, mas **avisar o usuário na entrega** — pode parecer que "apareceram etiquetas do nada"    |
| Chip mais largo em hover reflui a grade                                         | Slot do lápis com largura reservada; só a opacidade anima                                                       |

---

## 11. Desvios do as-built

### 11.1 Métrica e limiar de contraste (§2.4 / §5.5)

A §2.4 previa medir o texto do chip contra o fundo do chip
(`${color}20`), avisando abaixo de 3:1. Medido contra as 8 cores que já
estão em produção, esse critério reprova **6 delas**:

| Preset                  | Texto vs fundo do chip (claro) | Cor vs superfície (claro) |
| ----------------------- | ------------------------------ | ------------------------- |
| âmbar                   | 1,95                           | 2,15                      |
| ciano                   | 2,17                           | 2,43                      |
| esmeralda (**default**) | 2,25                           | 2,54                      |
| laranja                 | 2,46                           | 2,80                      |
| rosa                    | 3,02                           | 3,53                      |
| azul                    | 3,18                           | 3,68                      |
| vermelho                | 3,20                           | 3,76                      |
| violeta                 | 3,63                           | 4,23                      |

Um aviso que dispara em `DEFAULT_TAG_COLOR` só ensina o usuário a
ignorar avisos. A causa é estrutural: o fundo é uma tinta 12,5% da
**mesma** cor, então essa razão é comprimida por construção e não
discrimina nada.

**Implementado:** contraste da cor contra a **superfície do card**
(`--card`, convertido para `#ffffff` / `#111318`), com
`LOW_CONTRAST_RATIO = 2` — ancorado no pior preset em produção (âmbar,
2,15). Aprova tudo o que hoje é aceito e reprova o que realmente
desaparece no fundo: `#ffff00` (1,07 claro), `#f5f5f5` (1,09),
`#000000` (1,13 escuro). Dois testes de `colors.test.ts` travam essa
calibragem, para que subir o limiar exija decisão humana.

### 11.2 `lowContrast` virou três chaves

Uma chave só exigiria interpolar o nome do tema (`{theme}`) a partir de
outra string traduzida, ou concatenar "claro, escuro" com vírgula —
padrão que quebra em locales com concordância. Implementado como
`lowContrastLight` / `lowContrastDark` / `lowContrastBoth`.

### 11.3 Chaves de i18n não previstas na §7

- `colorGrid` — `aria-label` do grupo da grade estendida.
- `noTagsReadOnly` — o `noTags` existente termina em "crie a primeira
  abaixo", frase falsa quando o usuário não tem a linha de criação.
- `save` — a §7 listou; registrado aqui só porque `saving` já existia
  em outros namespaces e podia parecer duplicata.

### 11.4 `TagNameConflictError.tagName`, não `.name`

O snippet da §5.3 declarava `public readonly name: string` e em seguida
`this.name = 'TagNameConflictError'` — o segundo sobrescreve o
primeiro, e `Error.prototype.name` é o nome da **classe**, lido por
ferramenta de log. Um conflito na etiqueta "Financeiro" seria logado
como um erro da categoria "Financeiro". Renomeado para `tagName`.

### 11.5 `onStale` adicionado ao contrato do `TagEditDialog`

A §4.4 definia apenas `onClose` / `onSaved`, mas a §5.6 exige que o
`PGRST116` recarregue o catálogo e feche o modal — sem callback, o modal
ficaria pedindo para salvar uma linha inexistente.

### 11.6 A11y: `aria-pressed` em vez de `radiogroup`

A §6 previa `role="radio"` / `role="radiogroup"`, deixando `aria-pressed`
como alternativa aceitável se não houvesse navegação por setas. Não há —
e o botão de "cor personalizada" abre um popover, o que o torna um
péssimo `radio`. Implementado com `role="group"` + `aria-pressed`, que é
também o padrão que o card já usava.

### 11.7 `hexDraft` como `string | null`, sem `useEffect`

A regra `react-hooks/set-state-in-effect` é **erro** no ESLint deste
projeto, então sincronizar rascunho ↔ valor por efeito não compila.
`null` significa "espelhe `value`"; digitar preenche o rascunho, sair do
campo volta para `null`. Efeito colateral necessário: sem isso, digitar
"abcdef" era impossível — em "abc" o valor já vira `#aabbcc` (3 dígitos
é HEX válido) e a normalização reescrevia o texto no meio da digitação.

### 11.8 Ordem dos chips mudou

Consequência de adotar `fetchTags` da lib (§2.2): a ordenação passou de
`created_at` para `name`, alinhada a todos os outros consumidores do
catálogo.

### 11.9 Modal de edição não tem animação de saída

`key={tag.id}` remonta o componente, e quando `editingTag` vai a `null`
o conteúdo desmonta junto com o `open=false` — o fade de saída é
perdido. Trade-off aceito: preservar a animação exigiria um segundo
estado de "fechando", e a semeadura sem `useEffect` vale mais que 100ms
de fade.

### 11.10 `PG_INSUFFICIENT_PRIVILEGE` exportado

A §9.3 do SPEC do Inbox o havia descartado por falta de consumidor. Aqui
ele tem um: a §5.6 pede mensagem específica para `42501`. Exportado
junto com `PGRST_NO_SINGLE_ROW`.

### 11.11 Lápis e `×` sempre visíveis (§3.2, medida 5)

A §3.2 previa revelar os dois ícones em hover/foco em ponteiros finos.
Decisão do mantenedor após ver o resultado: **sempre visíveis**, em
qualquer viewport. Esconder o lápis escondia junto a existência da
edição — a feature nova ficava indescobrível para quem não passasse o
mouse por cima.

A separação das zonas de clique não dependia dessa medida: continuam de
pé os dois botões irmãos, o separador de 1px, o alvo de 28px, o realce
de fundo próprio do `×` e o modal de confirmação. O slot de largura fixa
do lápis perde a razão de existir (não há mais mudança de largura em
hover), mas fica: agora só a opacidade anima, de 70% para 100%.

---

## 12. Pendências operacionais

- [ ] **A migração 038 continua não aplicada** (pendência herdada do SPEC
      do Inbox, §10). Enquanto o índice único não existir, o `23505` nunca
      dispara: a checagem local de nome duplicado é a **única** guarda
      contra renomear para um nome já usado. Duas abas salvando nomes
      iguais ao mesmo tempo passam. O tratamento de `TagNameConflictError`
      já está no lugar e começa a valer no dia em que a migração rodar.
- [ ] **Fase 6, opcional:** migração da `CHECK` de formato de cor (rodar
      antes o `SELECT` de pré-visualização da §5.5) e reuso do
      `TagColorPicker` no `tag-picker-dialog.tsx` do Inbox.
- [ ] **Verificação manual dos critérios interativos** (§9, itens 1–12):
      exigem sessão de admin autenticada. O que build/teste cobre está
      marcado na §9 como verificado.
- [ ] **Commit.** As mudanças estão no working tree, não versionadas.
