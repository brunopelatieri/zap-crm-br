# SPEC 051 — Exportação de contatos (CSV / XLSX)

> **Status:** implementada (F1–F7). Falta só a validação manual do §9 e o
> commit do código.
> **Depende de:** SPEC 044 (audiência multiformato), SPEC 045 (janela de 24h),
> SPEC 048/049 (canais), SPEC 050 (telefone BR).
> **Migração:** `064_contact_exports.sql` — aplicada em **vn**, **rs** e **jh**
> (2026-08-15).

---

## Contexto

`src/components/contacts/` tem `import-modal.tsx`, mas **não tem contraparte de
exportação**: hoje a única forma de tirar contatos do sistema é a API pública
`/api/v1/contacts` (chave de API + paginação por cursor), inacessível ao usuário
final. Quem precisa levar a base para uma planilha — auditoria, campanha externa,
backup, migração — não tem caminho.

Existe precedente de download no repositório
(`src/app/(dashboard)/broadcasts/[id]/page.tsx`,
`src/components/broadcasts/audience/audience-template-hint.tsx`), mas ambos geram
o arquivo no navegador a partir de dados já em memória. Exportar contatos é
diferente por três motivos, e são eles que definem esta SPEC:

1. **O teto de ~1000 linhas do PostgREST é silencioso** — documentado em
   `src/lib/contacts/contact-filter-query.ts:5-14` e nas migrações 025/061. Uma
   exportação "de todos" feita no cliente devolveria um arquivo plausível, com
   contatos faltando e ninguém avisando.
2. **Contato não é uma linha só** — etiquetas (`contact_tags`), campos
   personalizados (`contact_custom_values`), notas (`contact_notes`) e canal
   (derivado de `conversations.channel_id`) são quatro consultas extras, cada uma
   sujeita ao mesmo teto.
3. **É o maior vetor de vazamento da conta** — a RLS deixa qualquer membro
   (inclusive `viewer`) ler todos os contatos; baixar a base inteira em um clique
   é outra coisa, e a LGPD pede rastro de quem fez.

**Resultado esperado:** botão "Exportar" na página de contatos → modal de
configuração (formato, escopo, campos) → arquivo baixado com **todos** os
contatos do escopo escolhido, sem teto de paginação, com trilha de auditoria.

---

## Decisões fechadas com o mantenedor

| Tema              | Decisão                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Etiquetas/canais  | **Posicional**: `etiqueta_1`, `etiqueta_2`… `canal_1`, `canal_2`… — nº de colunas = maior contagem entre os exportados   |
| Onde gera         | **Rota de API no servidor** (`POST /api/contacts/export`) — primeira rota do repositório a devolver arquivo               |
| Seleção           | **Persiste entre páginas**; o "todos do filtro" vira escolha de escopo dentro do modal (§6.2)                            |
| Notas             | **Uma célula**, notas concatenadas, uma por linha, com a data na frente                                                   |
| Campos extras     | Consentimento (LGPD), situação do WhatsApp, telefone E.164, última interação — todos os quatro                           |
| Permissão         | **Admin / proprietário** (`canEditSettings`)                                                                             |
| Auditoria         | Tabela nova `contact_exports` — migração **064**                                                                         |

---

## 1. Arquitetura

```
[modal export-modal.tsx]  →  POST /api/contacts/export  →  fetch em lotes (RLS do usuário)
       (client)                    (route handler)              ↓
                                                          [serializer puro]
                                                                ↓
                                                    CSV string | XLSX buffer
                                                                ↓
       blob + <a download>   ←   Response(file, Content-Disposition)
                                                                ↓
                                                   INSERT contact_exports (service role)
```

Regra do repositório mantida: **lógica pura em `src/lib/contacts/`, efeito
colateral (download) no componente**, espelhando
`src/lib/audience/template-file.ts` ↔ `audience-template-hint.tsx`.

### 1.1 Por que POST e não GET

A lista de ids selecionados pode passar de mil itens — não cabe em querystring.
Com POST o browser não dispara download sozinho: o cliente lê `res.blob()` e
monta o `<a download>` (mesmo padrão de `audience-template-hint.tsx:31-52`, com
BOM e `setTimeout(revoke, 0)` — revogar logo após o clique cancela o download).

### 1.2 Por que o cliente de sessão, e não `supabaseAdmin`

`filter_contacts_by_tags` é `SECURITY INVOKER` e **não recebe `account_id`** —
depende inteiramente da RLS. Chamá-la com service role retornaria contatos de
**todas as contas**. A rota lê com `createClient()` de `@/lib/supabase/server`
(RLS da sessão) e só usa `supabaseAdmin()` para o INSERT da auditoria —
exatamente a convenção documentada em `src/app/api/quick-replies/route.ts`
("RLS-scoped read via the user client, service-role write after an explicit role
check").

---

## 2. Catálogo de campos — `src/lib/contacts/export-fields.ts` (novo)

```ts
export type ContactExportFieldId =
  | 'name' | 'phone' | 'email' | 'tags'            // marcados por padrão
  | 'company' | 'created_at' | 'channels'
  | 'custom_fields' | 'notes'                       // complementares
  | 'phone_e164' | 'whatsapp_status'
  | 'consent' | 'last_interaction';                 // avançados

export interface ContactExportField {
  id: ContactExportFieldId;
  group: 'basic' | 'extra' | 'advanced';
  /** Marcado ao abrir o modal. */
  defaultOn: boolean;
  /** Não pode ser desmarcado (identidade do contato). */
  locked?: boolean;
  /** Gera N colunas conforme os dados (etiquetas, canais, campos personalizados). */
  dynamic?: boolean;
}
```

| Campo             | Grupo     | Padrão      | Colunas geradas (pt-BR)                                       | Origem                                              |
| ----------------- | --------- | ----------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `name`            | básico    | ✓           | `nome`                                                        | `contacts.name`                                     |
| `phone`           | básico    | ✓ **trava** | `telefone`                                                    | `contacts.phone`                                    |
| `email`           | básico    | ✓           | `email`                                                       | `contacts.email`                                    |
| `tags`            | básico    | ✓           | `etiqueta_1..N`                                               | `contact_tags` + `tags.name`                        |
| `company`         | extra     |             | `empresa`                                                     | `contacts.company`                                  |
| `created_at`      | extra     |             | `criado_em`                                                   | `contacts.created_at`                               |
| `channels`        | extra     |             | `canal_1..N`                                                  | `conversations.channel_id` → `channels.name`        |
| `custom_fields`   | extra     |             | uma por definição, header = `custom_fields.field_name`        | `contact_custom_values`                             |
| `notes`           | extra     |             | `notas`                                                       | `contact_notes`, concatenadas                       |
| `phone_e164`      | avançado  |             | `telefone_e164`                                               | `contacts.phone_normalized` (coluna gerada, 022)    |
| `whatsapp_status` | avançado  |             | `whatsapp`, `whatsapp_motivo`                                 | `contacts.whatsapp_status(_reason)`                 |
| `consent`         | avançado  |             | `consentimento`, `origem_consentimento`, `data_consentimento` | `contacts.opt_in_*` (SPEC 048)                      |
| `last_interaction`| avançado  |             | `ultima_interacao`, `janela_24h`                              | `conversations.last_message_at` / `last_customer_message_at` |

**`phone` é travado** (checkbox marcado e desabilitado, com tooltip): é a
identidade do contato e a chave de reimportação — um arquivo sem telefone não
volta para o sistema.

**A ordem das colunas é canônica** (a ordem desta tabela), nunca a ordem em que o
usuário clicou nos checkboxes.

**`custom_fields` no modal:** um checkbox mestre; se a conta tiver campos
definidos, abaixo dele uma sublista com um checkbox por campo (mestre em estado
`indeterminate` quando parcial). Se a conta não tiver nenhum campo personalizado,
o item nem aparece.

---

## 3. Serializer puro — `src/lib/contacts/export-serialize.ts` (novo)

Recebe linhas já coletadas + seleção de campos + rótulos traduzidos e devolve a
matriz do arquivo. **Zero I/O, zero `next-intl`** — é o que o torna testável.

```ts
export interface ContactExportRow {
  contact: Contact;                                    // linha crua de `contacts`
  tagNames: string[];                                  // ordenadas por nome
  channelNames: string[];                              // distintas, ordenadas por nome
  customValues: Record<string, string>;                // custom_field_id → value
  notes: { created_at: string; note_text: string }[];  // mais recente primeiro
  lastMessageAt: string | null;
  sessionWindowOpen: boolean | null;                   // null = canal sem janela (QR)
}

export interface ContactExportLabels {
  columns: Record<string, string>;      // 'name' → 'nome', …
  tagColumn: (n: number) => string;     // n → 'etiqueta_1'
  channelColumn: (n: number) => string;
  values: {
    optedIn: string; optedOut: string; unknown: string;
    valid: string; invalid: string;
    windowOpen: string; windowClosed: string; windowNA: string;
    consentSource: Record<string, string>;
    whatsappReason: Record<string, string>;
  };
  formatDate: (iso: string) => string;  // dd/MM/yyyy HH:mm no pt-BR
}

export function buildContactExportMatrix(
  rows: ContactExportRow[],
  fields: ContactExportFieldId[],
  customFieldDefs: { id: string; field_name: string }[],
  labels: ContactExportLabels
): string[][]; // [header, ...linhas]
```

Regras que os testes precisam fixar:

- **Largura das colunas dinâmicas** = `max` sobre as linhas exportadas. Contato
  com menos etiquetas ⇒ células vazias à direita. Ninguém com etiqueta ⇒
  **nenhuma** coluna `etiqueta_*` (não emitir `etiqueta_1` vazia).
- **Notas concatenadas**: `[dd/MM/yyyy] texto` por nota, separadas por `\n`
  dentro da mesma célula (o quoting RFC 4180 cuida disso no CSV; no XLSX vira
  quebra de linha real).
- **`janela_24h`** vem de `resolveSessionWindow`
  (`src/lib/channels/session-window.ts`) — canal QR não tem janela ⇒ rótulo "não
  se aplica", nunca "Fechada". É o mesmo cuidado da SPEC 045 §5.9: o padrão
  seguro para "não sei" não pode virar uma afirmação.
- **Nulos viram string vazia**, nunca `"null"` ou `"undefined"`.

---

## 4. Geração de arquivo — `src/lib/contacts/export-file.ts` (novo)

```ts
export function buildContactsCsv(matrix: string[][]): string;
export function contactExportFilename(prefix: string, format: 'csv' | 'xlsx', now: Date): string;
```

- **CSV**: quoting em todos os campos (`"` duplicado), `\r\n` como em
  `buildAudienceTemplateCsv`. O **BOM `﻿` é acrescentado na rota**, não aqui
  — mantém a função pura e comparável no teste.
- **O delimitador é vírgula, deliberadamente** — é o que `parse-contact-csv.ts`
  lê, então o CSV exportado **volta a ser importável pelo próprio sistema**. O
  Excel pt-BR abre CSV-vírgula em coluna única; quem quer Excel escolhe `.xlsx`,
  e é exatamente para isso que o formato existe no modal. O `formatCsvHint` /
  `formatXlsxHint` do modal precisa dizer isso ao usuário, senão ele descobre
  abrindo o arquivo errado.
- **XLSX**: dependência nova **`write-excel-file`** (par do `read-excel-file@9.3.5`
  já usado — mesmo autor, mesma API mental). Import **dinâmico dentro da rota**
  (`await import('write-excel-file/node')`), então não entra no bundle do app.
- **Toda célula do XLSX é `type: String`.** Sem isso o Excel transforma
  `5511900000001` em `5,5119E+12` e come zeros à esquerda — o telefone é o dado
  que mais importa e o mais fácil de corromper. Datas vão como texto já
  formatado no locale, para o arquivo bater com o que a tela mostra.
- Nome do arquivo: `contatos-2026-08-15.xlsx` (pt-BR) / `contacts-2026-08-15.xlsx`
  (en) — prefixo vem do i18n, data em ISO curta.

---

## 5. Coleta em lotes — `src/lib/contacts/export-fetch.ts` (novo)

```ts
export const CONTACT_EXPORT_BATCH = 1000;
export const CONTACT_EXPORT_MAX_ROWS = 50_000;

export async function fetchContactsForExport(
  supabase: SupabaseClient,
  scope: ContactExportScope,
  fields: ContactExportFieldId[]
): Promise<{ rows: ContactExportRow[]; truncated: boolean }>;
```

**Passo 1 — contatos base.** Reusa `planContactQuery` de
`contact-filter-query.ts` com `pageSize: 1000` e `page` crescente, mantendo a
mesma bifurcação RPC/tabela da tela — assim o export e a listagem **não podem
divergir de filtro**. Para `scope.mode === 'selection'`, é `.in('id', ids)` em
lotes de 1000, com a mesma ordenação (`created_at DESC, id`).

**Passo 2 — relacionamentos**, só para os campos pedidos, em lotes de contatos e
com laço de `range()` até vir menos que 1000 (o teto vale também para as tabelas
filhas: 500 contatos × 4 etiquetas já estoura):

| Campo              | Consulta                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `tags`             | `contact_tags(contact_id, tag_id)` + `tags(id, name)`                                             |
| `channels`         | `conversations(contact_id, channel_id)` distintos + `channels(id, name)`                          |
| `custom_fields`    | `custom_fields(*)` + `contact_custom_values(contact_id, custom_field_id, value)`                  |
| `notes`            | `contact_notes(contact_id, note_text, created_at)` ordenado desc                                  |
| `last_interaction` | `conversations(contact_id, last_message_at, last_customer_message_at, channel_id)` — maior por contato |

Helper genérico `fetchAllRows(makeQuery)` que pagina por `.range()` até esgotar —
é o antídoto ao teto silencioso e deve carregar um comentário explicando
exatamente isso, senão alguém o "simplifica" de volta para uma query só.

**Teto:** acima de `CONTACT_EXPORT_MAX_ROWS` a rota responde `413` com
`{ error: 'export_too_large', total }`; o modal traduz para "Filtre a lista antes
de exportar (N contatos)". Sem esse teto, uma conta grande derruba a função por
timeout e o usuário só vê o download falhar sem motivo.

---

## 6. Rota — `src/app/api/contacts/export/route.ts` (novo)

```ts
export const maxDuration = 60; // export grande passa dos 10s padrão do host

interface ContactExportRequest {
  format: 'csv' | 'xlsx';
  fields: ContactExportFieldId[];
  customFieldIds?: string[]; // subconjunto, quando 'custom_fields' está ligado
  scope:
    | { mode: 'filter'; search: string; tagIds: string[]; channelIds: string[] }
    | { mode: 'selection'; ids: string[] };
}
```

1. `ctx = await requireRole('admin')`, com `toErrorResponse(err)` no catch
   (padrão de `src/app/api/quick-replies/route.ts`). **Admin/proprietário**.
2. Validar o payload: formato conhecido, `fields` só com ids do catálogo,
   `scope.ids` ≤ `CONTACT_EXPORT_MAX_ROWS` e todos UUID. `phone` é forçado na
   lista mesmo que o cliente não mande.
3. Rótulos: `getTranslations({ namespace: 'Contacts.exportColumns' })` de
   `next-intl/server` — o `getRequestConfig` de `src/i18n/request.ts` já resolve
   o locale pelo cookie `NEXT_LOCALE`, então o arquivo sai no idioma da tela sem
   o cliente precisar mandar nada. É uma exceção consciente à regra "mensagens de
   `/api/**` ficam em inglês": aqui o conteúdo é **do usuário**, não de
   integração.
4. `fetchContactsForExport` → `buildContactExportMatrix` → CSV (com BOM) ou
   buffer XLSX.
5. `INSERT contact_exports` com `supabaseAdmin()` — **antes** de responder, e uma
   falha de auditoria **não** derruba o download (log + segue: o arquivo já foi
   montado, e negá-lo não protege ninguém).
6. Resposta:
   ```
   Content-Type: text/csv; charset=utf-8
                 | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
   Content-Disposition: attachment; filename="contatos-2026-08-15.csv"; filename*=UTF-8''...
   X-Export-Row-Count: 1284
   ```

### 6.1 Migração `064_contact_exports.sql`

```sql
CREATE TABLE IF NOT EXISTS contact_exports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  format      TEXT NOT NULL CHECK (format IN ('csv','xlsx')),
  scope       TEXT NOT NULL CHECK (scope IN ('filter','selection')),
  row_count   INT  NOT NULL,
  fields      TEXT[] NOT NULL,
  filter      JSONB,            -- {search, tag_ids, channel_ids} ou {selected: N}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_exports_account
  ON contact_exports(account_id, created_at DESC);

ALTER TABLE contact_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_exports_select ON contact_exports
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- Sem policy de INSERT/UPDATE/DELETE: a trilha só é escrita pela rota
-- (service role) e ninguém a edita depois — é isso que a torna trilha.
```

`user_id` é `ON DELETE SET NULL` (e não `CASCADE`): remover um membro **não pode**
apagar o registro de que ele exportou a base.

> ⚠️ Aplicar em **vn**, **rs** e **jh** — confirmar com o mantenedor antes, como
> manda o `AGENTS.md`.

### 6.2 Escopo e seleção — `src/app/(dashboard)/contacts/page.tsx`

Hoje `fetchContacts` faz `setSelected(new Set())` logo na linha 142: trocar de
página apaga tudo o que foi marcado.

- **Mudança:** limpar a seleção quando **o filtro** muda (`search` /
  `selectedTagIds` / `selectedChannelIds`), não quando a página muda — um
  `useEffect` com essas três dependências, e a linha 142 sai de `fetchContacts`.
- O checkbox do cabeçalho continua page-scoped ("todos desta página"); a barra de
  ações em massa passa a mostrar "N selecionados" somando páginas.
- **"Todos do filtro" mora no modal**, como escolha de escopo:
  - `( ) Todos os contatos do filtro atual (1.284)`
  - `(•) Apenas os 3 selecionados` — pré-selecionado sempre que houver seleção,
    conforme a regra do produto ("quem marcou, quer só o que marcou").
  - Sem nenhuma seleção, só a primeira opção aparece, como texto, sem radio.
- **Por que não um "selecionar todos os 1.284" na barra de ações:** essa mesma
  barra tem "Excluir selecionados". Um clique que transforma 25 em 1.284 numa
  barra cuja outra ação é destrutiva é um acidente esperando acontecer. Dentro do
  modal, o escopo amplo só alcança a exportação.

---

## 7. UI — `src/components/contacts/export-modal.tsx` (novo)

Espelha `import-modal.tsx`: shadcn `Dialog`, `DialogContent` com
`flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl`,
header fixo / corpo scrollável / `DialogFooter` fixo, `reset()` no
`onOpenChange(false)`, toasts `sonner`, ícones `lucide-react` (`Download`,
`FileSpreadsheet`, `FileText`, `Loader2`).

```
┌─ Exportar contatos ──────────────────────────────┐
│ Formato    (•) Excel (.xlsx)   ( ) CSV (.csv)    │
│            Abre direto no Excel · CSV volta a    │
│            ser importável pelo próprio sistema   │
│                                                  │
│ O que exportar                                   │
│   ( ) Todos os contatos do filtro atual (1.284)  │
│   (•) Apenas os 3 selecionados                   │
│                                                  │
│ Campos                        [Marcar todos]     │
│   Básicos                                        │
│    [x] Nome  [x] Telefone🔒 [x] E-mail [x] Etiq. │
│   Complementares                                 │
│    [ ] Empresa  [ ] Data de criação  [ ] Canal   │
│    [ ] Campos personalizados ▸  [ ] Notas        │
│   Avançados                                      │
│    [ ] Telefone E.164   [ ] Situação do WhatsApp │
│    [ ] Consentimento    [ ] Última interação     │
│                                                  │
│ Prévia: 12 colunas · ~1.284 linhas               │
│                          [Cancelar] [Exportar]   │
└──────────────────────────────────────────────────┘
```

- Botão na página: `<GatedButton>` com `useCan('edit-settings')` (= admin/owner),
  ao lado de "Importar"; e um botão "Exportar" também na barra de ações em massa
  quando há seleção.
- Durante o download: botão em `Loader2` + `disabled`; o modal não fecha até o
  blob chegar.
- Erros: `413` → aviso para filtrar; `403` → não deveria acontecer (botão gated),
  mas é tratado; demais → `toastFailed`.
- Sucesso: `toast.success` com a contagem lida de `X-Export-Row-Count`, e fecha.

### 7.1 i18n

`messages/en.json` **e** `messages/pt-BR.json` — `npm run i18n:check` falha se
divergirem.

- `Contacts.page.exportBtn`, `Contacts.page.exportSelected`
- `Contacts.exportModal.*` — `title, desc, formatLabel, formatCsv, formatCsvHint,
  formatXlsx, formatXlsxHint, scopeLabel, scopeFiltered, scopeSelected,
  fieldsLabel, groupBasic, groupExtra, groupAdvanced, phoneLocked,
  selectAllFields, clearFields, preview, exportBtn, exporting, cancel,
  filenamePrefix, toastDone(+_plural), toastTooLarge, toastFailed, toastEmpty`
- `Contacts.exportFields.*` — rótulo de cada checkbox
- `Contacts.exportColumns.*` — **cabeçalhos do arquivo**, incluindo
  `tagColumn: "etiqueta_{n}"` e `channelColumn: "canal_{n}"`
- `Contacts.exportValues.*` — enums (`optedIn`, `optedOut`, `unknown`, `valid`,
  `invalid`, `windowOpen`, `windowClosed`, `windowNA`, `consentSource.*`,
  `whatsappReason.*`)

Plurais no formato do repositório (`x` / `x_plural`), não ICU.

---

## 8. Fases de execução

| Fase   | Entrega                                    | Arquivos                                                                                    | Status |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| **F1** | Gravar a SPEC                              | este documento + linha no índice do `AGENTS.md`                                             | ✅ |
| **F2** | Catálogo + serializer puro **com testes**  | `src/lib/contacts/export-fields.ts`, `export-serialize.ts` (+ `.test.ts`)                   | ✅ |
| **F3** | Geradores de arquivo + dependência         | `src/lib/contacts/export-file.ts` (+ `.test.ts`), `package.json` (`write-excel-file`)       | ✅ |
| **F4** | Coleta em lotes                            | `src/lib/contacts/export-fetch.ts` (+ `.test.ts`)                                           | ✅ |
| **F5** | Migração 064 + rota                        | `supabase/migrations/064_contact_exports.sql`, `src/app/api/contacts/export/route.ts`       | ✅ migração aplicada em vn/rs/jh |
| **F6** | Modal + i18n                               | `src/components/contacts/export-modal.tsx`, `messages/en.json`, `messages/pt-BR.json`       | ✅ |
| **F7** | Integração na página + seleção persistente | `src/app/(dashboard)/contacts/page.tsx`                                                     | ✅ |
| **F8** | Validação completa                         | comandos do §9                                                                              | ✅ automática · ⚠️ manual pendente (sem credenciais de teste em navegador) |

**Adições fora da lista original de arquivos**, necessárias para fechar o
critério de round-trip do §4/§9.8 (um CSV exportado com cabeçalhos pt-BR
precisa voltar a ser importável): `src/lib/contacts/parse-contact-csv.ts`
ganhou aliases pt-BR (`telefone`, `nome`, `empresa`, `etiquetas`) — antes só
reconhecia cabeçalhos literais em inglês, e sem eles `parseContactCsv`
devolvia `rows: []` inteiro para um arquivo com cabeçalho `"telefone"`.
`src/lib/audience/parse-csv.ts` (`AUDIENCE_COLUMNS`) foi ajustado para
derivar dos mesmos aliases (`CONTACT_COLUMNS`), eliminando a lista
duplicada — comportamento do import de audiência inalterado (suíte
inteira permanece verde).

F2 → F4 são puros e testáveis sem browser — é onde o risco real (teto de linhas,
colunas dinâmicas) é fixado por teste antes de existir qualquer UI.

---

## 9. Verificação

**Automática** (ordem obrigatória do `AGENTS.md`; não há CI neste repositório):

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

**Testes que precisam existir** (Vitest, co-locados, stub manual do Supabase como
em `src/lib/contacts/dedupe.test.ts`):

- `export-serialize.test.ts` — largura dinâmica de `etiqueta_*` (0, 1, N);
  nenhuma coluna quando ninguém tem etiqueta; a ordem canônica das colunas
  independe da ordem de seleção; nulos viram `''`; notas concatenadas com data;
  `janela_24h` "não se aplica" em canal sem janela.
- `export-file.test.ts` — CSV com vírgula/aspas/quebra de linha no valor faz
  round-trip por `parseContactCsv`; CRLF; nome de arquivo com a data.
- `export-fetch.test.ts` — o laço de `range()` continua enquanto o lote vier
  cheio (fixture com 1000 + 250 linhas prova que a segunda página é buscada);
  `truncated` acima do teto.

**Manual** (`npm run dev`, conta com mais de uma página de contatos):

1. Sem filtro nem seleção → exportar xlsx → o total do arquivo bate com o
   "Mostrando … de N" da tela, **não** com 25.
2. Filtrar por 2 etiquetas → exportar → todos os contatos do filtro, colunas
   `etiqueta_1..N`.
3. Marcar 2 contatos na página 1, ir para a página 2, marcar mais 1 → a barra
   mostra "3 selecionados" → exportar → 3 linhas.
4. Marcar todos os campos numa conta com campos personalizados e notas →
   conferir cabeçalhos traduzidos e o conteúdo das colunas dinâmicas.
5. Trocar o idioma em Configurações → Aparência para `en` → reexportar →
   cabeçalhos em inglês, arquivo `contacts-….xlsx`.
6. Entrar com um usuário `viewer`/`agent` → botão "Exportar" bloqueado; um
   `POST /api/contacts/export` com a sessão dele → `403`.
7. `SELECT * FROM contact_exports ORDER BY created_at DESC LIMIT 5;` (MCP `vn`) →
   uma linha por exportação, com `row_count` correto.
8. Abrir o CSV exportado e reimportá-lo pelo `ImportModal` → todos reconhecidos
   como duplicados (prova do round-trip).
