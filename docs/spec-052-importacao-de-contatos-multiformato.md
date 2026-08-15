# SPEC 052 — Importação de contatos multiformato (Google Planilhas, Excel e CSV)

| Campo            | Valor                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | **Proposta** — decisões D-1 a D-8 aguardam ratificação do mantenedor                                                                                                 |
| Data             | 2026-08-15                                                                                                                                                           |
| Depende de       | SPEC 044 (audiência multiformato), SPEC 050 (telefone BR), SPEC 051 (exportação — round-trip de cabeçalhos)                                                          |
| Migrações        | **Nenhuma.** Esta SPEC não toca no schema                                                                                                                            |
| Dependência nova | **Nenhuma.** `read-excel-file@9.3.5` já está no `package.json` (usado pela audiência)                                                                                |
| Corrige          | 5 defeitos verificados por execução (§2.2): perda silenciosa de etiquetas, corrupção de colunas, CSV `;` ilegível, apóstrofo comido, validação BR ausente no disparo |

---

## 1. O problema, em uma frase

O importador de contatos aceita **um** formato (`.csv` separado por vírgula, escolhido por um
`<input type="file">` sem arraste) enquanto o importador de audiência de disparo — construído
pela SPEC 044 — aceita **três** fontes (Google Planilhas, `.xlsx`, `.csv`), com modelo para
baixar, referência de colunas, seletor de aba, barra de progresso e resumo de rejeitadas.

São dois importadores para a mesma operação — "ler uma planilha de pessoas" — no mesmo produto,
e o mais usado é o mais pobre.

### 1.1 O que esta SPEC **não** faz

- **Não** leva a triagem/"Análise de audiência" para os contatos (decisão do mantenedor, D-3).
  Importar contato é uma operação de cadastro, não de disparo: não existe cota da Meta, nem
  janela de 24 h, nem histórico de engajamento a revisar antes.
- **Não** mexe na validação de telefone da SPEC 050 — ela é **mantida como está** e passa a
  valer também para as fontes novas (D-2).
- **Não** cria tabela, coluna ou migração.

---

## 2. Estado atual (verificado no código em 2026-08-15)

### 2.1 Os dois caminhos, lado a lado

| Capacidade                           | Contatos (`import-modal.tsx`)      | Audiência (SPEC 044)                          |
| ------------------------------------ | ---------------------------------- | --------------------------------------------- |
| Fonte: arquivo `.csv`                | ✅                                 | ✅                                            |
| Fonte: arquivo `.xlsx`               | ❌                                 | ✅ (`read-excel-file`, import dinâmico)       |
| Fonte: Google Planilhas por link     | ❌                                 | ✅ (rota servidor, guarda SSRF)               |
| Arrastar e soltar                    | ❌ (só clique)                     | ✅                                            |
| Modelo de planilha para baixar       | ❌                                 | ✅ (`buildAudienceTemplateCsv`)               |
| Referência de colunas + apelidos     | ❌ (uma frase no `desc`)           | ✅ (`AudienceTemplateHint`, lista por coluna) |
| Seletor de aba (`.xlsx`)             | —                                  | ✅ (escolhe a aba com coluna de telefone)     |
| Teto de tamanho / linhas             | ❌ nenhum                          | ✅ 10 MB / 50 000 linhas                      |
| Barra de progresso                   | ❌                                 | ✅ (normalização fatiada, aba não trava)      |
| Resumo "lidas · válidas · inválidas" | ❌ (só uma lista de rejeitadas)    | ✅ (`AudienceImportSummary`)                  |
| Lista de linhas rejeitadas           | ✅ (SPEC 050 F3/D-4)               | ✅                                            |
| **Validação BR (SPEC 050)**          | ✅ `normalizeContactPhone`         | ❌ **só `isValidE164`** — ver §2.2 (J)        |
| Cria etiquetas na importação         | ✅ (admin+; agente vê "ignoradas") | ❌ (etiquetas do arquivo são só exibidas)     |

O tokenizador de CSV **já é compartilhado**: `readCsvTable` mora em
[`src/lib/contacts/parse-contact-csv.ts`](../src/lib/contacts/parse-contact-csv.ts) e
`src/lib/audience/parse-csv.ts` o importa, junto com `CONTACT_COLUMNS` e `parseTagCell`. Ou
seja: **metade da unificação já existe** — o que falta é a camada de formato (XLSX, Sheets) e a
camada de UI.

### 2.2 O que a execução mostrou (sonda descartável, 2026-08-15)

Antes de escrever qualquer instrução de formatação, os dois parsers foram exercitados com
`vitest` contra casos reais. **Estes não são cenários hipotéticos — são saídas colhidas.**

| #     | Entrada                                                                                 | Saída real                                                        | Veredito                                |
| ----- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| **A** | CSV `,` · última coluna `tags` com `vip,lead` **sem aspas**                             | `tagNames: ["vip"]` — `lead` **desaparece**                       | 🐛 perda silenciosa                     |
| **B** | CSV `,` · `tags` com `"vip, lead"` **com aspas**                                        | `tagNames: ["vip","lead"]`                                        | ✅                                      |
| **C** | CSV `,` · `tags` com `vip;lead` **sem aspas**                                           | `tagNames: ["vip","lead"]`                                        | ✅                                      |
| **D** | CSV `,` · `tags` **no meio**, `vip,lead` sem aspas                                      | `name: "lead"` — as colunas seguintes **deslizam**                | 🐛 corrupção silenciosa                 |
| **E** | CSV separado por **`;`** (padrão do Excel em pt-BR)                                     | contatos: `rows: []` · audiência: `throw missing_phone_column`    | 🐛 arquivo inteiro perdido              |
| **F** | `Maria D'Ávila`, `O'Brien & Co`                                                         | `Maria DÁvila`, `OBrien & Co` — o apóstrofo é **apagado**         | 🐛 dado corrompido                      |
| **G** | `"Maria ""Bibi"" Souza"` (aspas escapadas, RFC 4180)                                    | `Maria Bibi Souza` — as aspas internas somem                      | ⚠️ cosmético                            |
| **H** | XLSX · célula `tags` = `vip, lead`                                                      | `tagNames: ["vip","lead"]`                                        | ✅ (planilha não tem o problema do CSV) |
| **I** | XLSX · telefone como **número**                                                         | `5519992496598` correto; `'0 19 99249-6598'` como texto sobrevive | ✅ (já tratado)                         |
| **J** | Audiência: `5510987654321` (DDD 10 não existe), `19992496598` (sem DDI), `999999999999` | **as três passam como válidas**                                   | 🐛 SPEC 050 D-5 não cumprida            |
| **K** | `parseTagCell('vip\|lead')` / `('vip / lead')`                                          | uma etiqueta só — apenas `,` e `;` separam                        | ✅ (comportamento a documentar)         |

**O que isso significa para o pedido "qual é a instrução certa":**

- A instrução atual de **contatos** — _"tags separadas por vírgula; use aspas em células com
  múltiplas etiquetas"_ — está **correta mas incompleta**: omite o `;`, que é a forma que
  funciona **sem** aspas (C) e é a que o próprio modelo de planilha da audiência gera
  (`cliente;vip` em `template-file.ts`).
- A instrução atual de **audiência** — _"Etiquetas separadas por vírgula ou ponto e vírgula"_ —
  está **incorreta para CSV**: seguir "vírgula" ao pé da letra num `.csv` produz A ou D,
  dependendo da posição da coluna. Em `.xlsx` e Google Planilhas ela está certa (H).
- A instrução **verificada e universal** está na §6.

**E o achado J é o mais grave**: a tabela D-5 da SPEC 050 afirma que a audiência de disparo
"✅ já normaliza · ✅ valida DDD/tipo". O código não faz isso —
[`src/lib/audience/normalize.ts:81-91`](../src/lib/audience/normalize.ts#L81-L91) usa
`sanitizePhoneForMeta` + `isValidE164` e nada mais. Consequências hoje, em produção:

1. O mesmo `19992496598` numa planilha vira **`5519992496598`** se entrar por Contatos e
   **`19992496598`** se entrar por Disparos — dois formatos para a mesma pessoa, e o segundo é
   um número que a Meta lê como DDI 19.
2. Um DDD inexistente (10, 20, 23…) entra na audiência e queima cota de disparo.

---

## 3. Objetivo

1. **Uma pipeline de ingestão, dois consumidores.** Contatos e audiência leem planilha pelo
   mesmo caminho: `fonte → matriz → linhas cruas → normalização → resultado`. Cada um mantém só
   a sua política (o que fazer com a linha e para onde ela vai).
2. **As três fontes no importador de contatos:** Google Planilhas, `.xlsx`, `.csv`, com a mesma
   interface do passo 2 do disparo (cards de fonte, modelo para baixar, referência de colunas,
   arraste, seletor de aba, progresso).
3. **Instrução de formatação que corresponde ao que o parser faz** — literalmente gerada da
   mesma constante que o parser consome, e verificada por teste (§6, §9.1).
4. **Validação de telefone da SPEC 050 preservada e estendida:** mantida exatamente como está
   nos contatos, e finalmente ligada na audiência (D-2).
5. **Alerta pós-importação:** ao final, a lista das linhas barradas pela validação — com número
   da linha e motivo — **continua visível** junto do resultado (hoje ela some quando o resultado
   aparece).

### 3.1 Fora de escopo

- Triagem/"Análise de audiência" no importador de contatos (D-3).
- Importar campos personalizados (`contact_custom_values`) ou notas. Hoje nenhum dos dois
  importadores faz isso; ampliar o conjunto de colunas é assunto próprio.
- Atualizar contato existente pela planilha (_upsert_). Hoje duplicata é **ignorada**, e
  continua sendo — mudar isso é uma decisão de produto separada, com risco de sobrescrever dado
  bom com dado velho.
- OAuth do Google. O caminho continua sendo link público, como na SPEC 044.

---

## 4. Decisões

> Nenhuma foi ratificada ainda. **D-2, D-7 e D-8 mudam comportamento fora do importador de
> contatos** e são as que mais precisam de um "pode ir" explícito.

### D-1 — Uma camada de planilha, com nome honesto: `src/lib/spreadsheet/`

Os módulos de formato moram hoje em `src/lib/audience/` porque nasceram para o disparo. Se o
importador de contatos passar a importar de lá, o repositório fica com contatos dependendo de
"audiência" para uma operação que não tem nada a ver com audiência — e a próxima pessoa a mexer
não vai saber qual dos dois manda.

**Decisão proposta:** mover os arquivos **de formato** (nada de regra de disparo):

| De                              | Para                               | Motivo                                           |
| ------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `lib/audience/parse-csv.ts`     | `lib/spreadsheet/parse-csv.ts`     | leitura de CSV, sem domínio                      |
| `lib/audience/parse-xlsx.ts`    | `lib/spreadsheet/parse-xlsx.ts`    | leitura de XLSX, sem domínio                     |
| `lib/audience/google-sheets.ts` | `lib/spreadsheet/google-sheets.ts` | download + guarda SSRF                           |
| `lib/audience/template-file.ts` | `lib/spreadsheet/template-file.ts` | gera o modelo a partir das colunas               |
| tipos de formato de `types.ts`  | `lib/spreadsheet/types.ts`         | `ParseErrorCode`, tetos, `SpreadsheetParseError` |

**Ficam onde estão** (são regra de disparo): `normalize.ts` na parte que produz
`NormalizedAudience`, `estimate.ts`, `stage.ts`, `triage.ts`, `engagement.ts`, `resolve.ts`.

Custo real medido: **13 linhas de import** em 7 arquivos. `AUDIENCE_COLUMNS` vira
`SPREADSHEET_COLUMNS` (continua derivado de `CONTACT_COLUMNS`, que segue sendo a fonte única);
`AudienceParseError` vira `SpreadsheetParseError`. Os testes co-locados vão junto.

**Alternativa mais barata, se você preferir risco zero de refactor:** não mover nada e importar
`@/lib/audience/*` a partir de contatos. Funciona, custa 0 arquivo tocado, e deixa uma dívida de
nomenclatura permanente. **Recomendação: mover** — é mecânico, o `typecheck` pega qualquer
esquecimento, e é o único momento em que o custo é 13 linhas.

### D-2 — A audiência de disparo passa a usar a validação da SPEC 050

O achado **J** (§2.2) mostra que a tabela D-5 da SPEC 050 descreve um estado que o código não
tem. Com a pipeline unificada, manter dois validadores diferentes na mesma leitura de planilha
seria pior do que hoje: a **mesma planilha** daria resultados diferentes dependendo do botão
clicado.

**Decisão proposta:** `createAudienceNormalizer` recebe o validador como parâmetro, e o padrão
para **os dois** consumidores passa a ser `normalizeContactPhone` (SPEC 050).

```ts
createRowNormalizer({ validate: normalizeContactPhone }); // padrão nos dois caminhos
```

**O que muda para quem dispara hoje:**

| Linha da planilha             | Antes                                | Depois                                |
| ----------------------------- | ------------------------------------ | ------------------------------------- |
| `19992496598` (sem DDI, BR)   | enviado como `19992496598` (DDI 19!) | vira `5519992496598` ✅ **corrigido** |
| `5510987654321` (DDD 10)      | entra na audiência                   | rejeitada · motivo `invalid_ddd`      |
| `999999999999`                | entra na audiência                   | rejeitada · motivo `invalid_ddd`      |
| `+351912345678` (estrangeiro) | entra                                | entra (D-2 da SPEC 050 preserva) ✅   |
| `551198765432` (legado 8 díg) | entra                                | entra (D-6 da SPEC 050 preserva) ✅   |

**Risco:** uma audiência que hoje "funciona" pode passar a listar linhas como inválidas. Em
todos os casos observados a linha rejeitada é um número que **a Meta recusaria de qualquer
forma** — o efeito prático é trocar uma falha silenciosa e paga por uma rejeição explícita e
gratuita. Mesmo assim: **é mudança de comportamento em produção e precisa do seu aval.**

**Escape hatch, caso você prefira faseado:** manter `isValidE164` como padrão da audiência por
uma versão, com a validação BR ligada só nos contatos — o parâmetro existe justamente para isso.
Custo: a divergência do achado J continua viva, e a SPEC 050 continua descrevendo o que não é.

### D-3 ✅ — Sem triagem no importador de contatos _(já decidido pelo mantenedor)_

Nada de `/broadcasts/new/[id]/triage`, nada de rascunho staged, nada de tabela de análise.

**O que fica, e por quê:**

| Elemento                                         | Fica? | Motivo                                                      |
| ------------------------------------------------ | ----- | ----------------------------------------------------------- |
| Pré-visualização das 5 primeiras                 | ✅    | Já existe hoje e é o que confirma "achei as colunas certas" |
| Chips `lidas · válidas · duplicadas · inválidas` | ✅    | É o "quanto vai entrar" — uma linha de texto, não uma tela  |
| Lista de linhas rejeitadas                       | ✅    | É o **alerta pedido** — mantida da SPEC 050 D-4             |
| Tabela de triagem / seleção linha a linha        | ❌    | É análise de disparo                                        |
| Estimativa, cota da Meta, engajamento            | ❌    | Idem                                                        |

**Mudança sobre o comportamento atual:** hoje a lista de rejeitadas está condicionada a
`!result` ([`import-modal.tsx:621`](../src/components/contacts/import-modal.tsx#L621)) — ela
**desaparece no instante em que a importação termina**, que é exatamente quando o usuário quer
lê-la. Passa a aparecer junto do resultado, com o rótulo "não importados".

### D-4 — Delimitador detectado, não presumido

`readCsvTable` divide o cabeçalho por `,` fixo (`parse-contact-csv.ts:118`). Um `.csv` exportado
pelo Excel em português é separado por `;` — achado **E**: o arquivo inteiro se perde, e o
usuário recebe "Nenhuma linha válida encontrada. Verifique se o CSV tem uma coluna phone" — que
manda ele procurar problema numa coluna que está lá.

**Decisão proposta:** farejar o delimitador na **linha de cabeçalho** (só nela), entre `,`, `;` e
tab; vence o que aparecer mais vezes; empate ou zero ocorrências → `,`.

Por que só o cabeçalho: é a linha que o autor da planilha controla e a única em que o delimitador
aparece por definição. Farejar no corpo trocaria o delimitador por causa de uma vírgula dentro de
um nome de empresa.

`parseCsvLine` passa a receber o delimitador (hoje `,` embutido em `parse-contact-csv.ts:196`).

### D-5 — Parar de comer o apóstrofo

`csvCell` e `parseContactCsv` fazem `.replace(/["']/g, '')` — apagam **toda** aspa simples do
valor, em qualquer posição. Achado **F**: `D'Ávila` → `DÁvila`, `Sant'Ana` → `SantAna`,
`O'Brien & Co` → `OBrien & Co`. Num CRM brasileiro isso atinge sobrenome comum, e o dado entra
errado **em silêncio**, sem linha rejeitada e sem aviso.

**Decisão proposta:** trocar a remoção global por remoção de **par envolvente** apenas
(`"…"` ou `'…'` cercando a célula inteira), e desescapar `""` → `"` conforme RFC 4180 (achado
**G**). O comportamento de todos os testes existentes é preservado — eles só usam aspas
envolventes.

> Isto também conserta o round-trip da SPEC 051: hoje um contato exportado com apóstrofo no nome
> volta diferente do que saiu.

### D-6 — A instrução de etiquetas, com o texto que os testes provam

Ver §6 para o texto final. Em resumo: **`;` é o separador recomendado** (funciona sem aspas nos
três formatos, e é o que o modelo já gera), a vírgula continua aceita **desde que a célula esteja
entre aspas** no CSV, e no Excel/Google Planilhas basta escrever na célula.

Acrescenta um fato que hoje não está escrito em lugar nenhum e que o usuário descobre por toast:
**etiqueta que ainda não existe é criada durante a importação — só para admin/dono.** Um agente
vê as desconhecidas serem ignoradas
([`resolve-import-tags.ts:65-70`](../src/lib/contacts/resolve-import-tags.ts#L65-L70)).

### D-7 — Tetos e a leitura de duplicatas que o PostgREST corta em 1000

Duas coisas que a importação de contatos não tem e vai precisar quando aceitar `.xlsx` de 50 000
linhas:

**(a) Teto de linhas.** O caminho de contatos insere pelo navegador, com o cliente sujeito a RLS,
em lotes de 50 — 50 000 linhas são 1 000 requisições sequenciais. **Proposta: 10 000 linhas** por
importação de contatos (a audiência continua com 50 000, porque lá o custo é uma leitura, não
1 000 escritas), com mensagem clara de "divida o arquivo". Teto de bytes: os mesmos 10 MB.

**(b) A leitura de telefones existentes está truncada — hoje, em produção.**

```ts
// import-modal.tsx:268-271
const { data: existingRows } = await supabase
  .from('contacts')
  .select('phone_normalized')
  .eq('account_id', accountId); // ← PostgREST devolve no máximo ~1000 linhas
```

Numa conta com mais de 1 000 contatos, esse `Set` está incompleto. Não corrompe dado — o índice
único da migração 022 é o backstop e a duplicata cai no `catch` como "ignorada" —, mas **o custo
é brutal**: cada lote de 50 que contenha uma duplicata falha inteiro e é reprocessado
**linha a linha**, 50 requisições em vez de 1. Numa base de 20 000 contatos com um arquivo de
reimportação, é o caminho lento em quase todos os lotes.

**Proposta:** paginar a leitura com `.range()` em páginas de 1 000 até esgotar (o mesmo padrão
que a SPEC 051 usa na exportação). Mesma correção, mesmo arquivo, custo de ~10 linhas.

> Alternativa mais ambiciosa, deliberadamente **fora** desta SPEC: mover a inserção para uma
> rota de servidor com o cliente `admin` e `upsert onConflict ignoreDuplicates`, como a
> exportação da SPEC 051 faz. Resolveria (a) e (b) de uma vez e destravaria as 50 000 linhas.
> É outra SPEC — o importador atual funciona, só não escala.

### D-8 — Uma rota de Google Planilhas, neutra: `POST /api/import/google-sheets`

A rota existente é `/api/broadcasts/audience/google-sheets`. Chamá-la a partir da tela de
contatos funciona (mesmo piso de papel: `requireRole('agent')` ≡ `useCan('send-messages')`, que
é o que a página de contatos exige para importar) mas deixa o log e a leitura mentindo.

**Decisão proposta:** criar `POST /api/import/google-sheets` — corpo idêntico, mesma guarda
SSRF, mesmo `RATE_LIMITS.audienceImport` (renomeado para `spreadsheetImport`) — e **apontar o
passo 2 do disparo para ela**, removendo a antiga. Uma implementação, um lugar.

Chave do rate limit passa a `sheet-import:${userId}`: o teto de 10/min é por usuário e não
distingue de onde ele importou — e não deve mesmo, é o Google que está sendo protegido.

---

## 5. Arquitetura

```
FONTE                          CAMADA COMUM                        CONSUMIDOR
─────                          ────────────                        ──────────
.csv  ─┐                  ┌─ parse-csv.ts   ─┐
.xlsx ─┼─ useSpreadsheet ─┼─ parse-xlsx.ts  ─┼─ RawRow[] ─ createRowNormalizer({validate})
Sheets ┘     Parser       └─ google-sheets  ─┘                │
  (via /api/import/google-sheets → texto CSV)                 │
                                                              ├─→ Contatos: insere + etiquetas
                                                              │   (dedupe na base, D-7)
                                                              └─→ Disparo: stage + triagem
                                                                  (inalterado)
```

**O que cada camada não sabe:** o parser não sabe o que é contato; o normalizador não sabe de
onde a linha veio; o consumidor não sabe se o arquivo era `.xlsx` ou um link do Google. Essa é a
propriedade que a SPEC 044 já tinha e que esta SPEC estende para o segundo consumidor.

### 5.1 Componentes de UI compartilhados

| Componente                | Origem                        | Mudança                                                                                                 |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ImportSourcePicker`      | `audience-source-picker.tsx`  | Recebe a lista de fontes por prop. Contatos passa 2 cards (Google, Arquivo); disparo passa os 5 de hoje |
| `SpreadsheetTemplateHint` | `audience-template-hint.tsx`  | Namespace i18n por prop + a nota de CSV da §6                                                           |
| `SpreadsheetDropzone`     | `spreadsheet-dropzone.tsx`    | Só move de pasta                                                                                        |
| `ImportRejectSummary`     | `audience-import-summary.tsx` | Motivos passam a vir do vocabulário unificado; `AudienceImportSummary` vira um envoltório fino          |

Destino: `src/components/import/`. Ambos os módulos passam a consumir de lá.

### 5.2 O que sai do `import-modal.tsx`

O arquivo tem 730 linhas e ganharia mais quatro fontes. A extração acompanha a mudança:
`ImportPreviewTable` (a tabela das 5 primeiras) e `ImportResultPanel` (chips + rejeitadas) saem
para `src/components/contacts/import/`. O modal fica com o que é dele: escolher fonte, orquestrar
o parser, inserir, resolver etiquetas.

### 5.3 O que **não** muda no fluxo de contatos

Deliberadamente intocados — são a parte que funciona e é testada: `dedupeByPhone`,
`resolveImportTagIds`, `assignImportedContactTags`, `isUniqueViolation`, a inserção em lotes de
50 com retentativa individual, e `normalizeContactPhone` (SPEC 050) como validador.

---

## 6. A instrução de formatação (o texto verificado)

Este é o entregável central do pedido. Cada linha abaixo corresponde a um comportamento
**executado** na §2.2 e vira um teste de regressão na §9.1.

### 6.1 Referência de colunas (o card "Modelo de planilha", nas duas telas)

| Coluna    | Estado          | Descrição                                                                                                                                             | Também aceita                               |
| --------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `phone`   | **obrigatória** | Telefone com DDD — ex.: `11987654321`. Numa instalação brasileira o DDI `55` é acrescentado sozinho. Espaços, parênteses, traços e `+` são ignorados. | `telefone`, `celular`, `whatsapp`, `numero` |
| `name`    | opcional        | Nome do contato.                                                                                                                                      | `nome`                                      |
| `email`   | opcional        | E-mail do contato.                                                                                                                                    | `e-mail`                                    |
| `company` | opcional        | Empresa do contato.                                                                                                                                   | `empresa`                                   |
| `tags`    | opcional        | Etiquetas do contato. Uma por célula, ou várias separadas por **ponto e vírgula**: `vip;lead`.                                                        | `etiquetas`                                 |

**Correção sobre o texto de hoje:** a descrição atual de `phone` diz "Telefone com DDI e DDD",
o que faz o usuário achar que `11987654321` será recusado. Ele não é — a SPEC 050 (D-1/D-2)
acrescenta o `55` quando o deploy é brasileiro. O texto novo diz o que o código faz.

### 6.2 As três notas de rodapé (novas)

Aparecem abaixo da lista de colunas, nas duas telas:

> **Etiquetas.** Separe por ponto e vírgula (`vip;lead`) — funciona nos três formatos. Se
> preferir vírgula num arquivo `.csv`, coloque a célula entre aspas: `"vip, lead"`. No Excel e
> no Google Planilhas basta escrever na célula.

> **Etiqueta nova é criada na importação** — se você for dono ou administrador da conta.
> Agentes veem as etiquetas desconhecidas serem ignoradas, com aviso ao final.

> **A primeira linha é sempre o cabeçalho.** Colunas que o sistema não conhece são ignoradas
> sem erro — pode deixar a planilha do jeito que ela já está.

**Por que a nota de etiquetas é assim, e não "separadas por vírgula ou ponto e vírgula":**
achados A e D. Num `.csv`, `vip,lead` sem aspas ou perde a segunda etiqueta (coluna final) ou
desloca todas as colunas seguintes (coluna do meio) — nos dois casos **sem erro visível**. O
`;` é o único separador que atravessa CSV, XLSX e Google Planilhas sem exigir aspas, e é o que
`buildAudienceTemplateCsv` já escreve no modelo (`cliente;vip`).

### 6.3 Texto do dropzone

> Arquivo `.csv` ou Excel (`.xlsx`), até 10 MB e 10 000 linhas.
> Também aceitamos `.csv` separado por ponto e vírgula (o padrão do Excel em português).

A segunda linha só passa a ser verdade com o D-4. Sem o D-4 ela não pode ser escrita — e é
justamente o arquivo que um usuário brasileiro produz clicando em "Salvar como CSV".

---

## 7. Fases de execução

Cada fase termina com a suíte verde e é revisável sozinha.

### F1 — Camada de planilha compartilhada (sem mudança de UI)

Move os arquivos do D-1, com os testes co-locados. Implementa o **D-4** (delimitador farejado) e
o **D-5** (apóstrofo / `""`). Nenhum componente muda; a audiência passa a ler CSV `;` e nomes com
apóstrofo — que é ganho puro para ela também.

**Termina quando:** `npm run test` verde, incluindo os casos novos A–K da §9.1.

### F2 — Normalizador parametrizado + validação unificada (D-2)

`createAudienceNormalizer` → `createRowNormalizer({ validate })`. Unifica o vocabulário de
motivos: `InvalidReason` passa a ser `PhoneRejectReason` (SPEC 050) **mais** `duplicate_in_file`.
`missing_phone` da audiência ≡ `empty` da SPEC 050 — fica `empty`, com a chave i18n antiga
mantida como sinônimo até a limpeza.

**Ponto de atenção:** os motivos são chaves de i18n em dois namespaces
(`Broadcasts.audience.invalidReason` e `Contacts.importModal.reason`). Consolidar num só
namespace (`Import.reason`) e apontar os dois consumidores para ele.

### F3 — Rota neutra de Google Planilhas (D-8)

Cria `POST /api/import/google-sheets`, aponta o passo 2 do disparo para ela, remove
`/api/broadcasts/audience/google-sheets`. Renomeia `RATE_LIMITS.audienceImport` →
`spreadsheetImport`.

### F4 — Componentes de UI compartilhados (§5.1)

Move e parametriza os quatro componentes para `src/components/import/`. O passo 2 do disparo
continua idêntico na tela — se algum pixel mudar, a parametrização errou.

### F5 — O novo importador de contatos

`import-modal.tsx` reescrito sobre a camada comum: cards de fonte (Google Planilhas
**recomendado** + Arquivo CSV/Excel), `SpreadsheetTemplateHint`, `SpreadsheetDropzone` com
arraste e seletor de aba, `useSpreadsheetParser` com progresso, chips de contagem, tabela de
pré-visualização, lista de rejeitadas **antes e depois** da importação (D-3).

Mantém intacto tudo da §5.3.

### F6 — Escala e correções do caminho de escrita (D-7)

Paginação da leitura de `phone_normalized` (`.range()` de 1 000 em 1 000) e teto de 10 000
linhas com mensagem própria.

### F7 — i18n, documentação e validação

Chaves novas nos dois dicionários (§8), linha desta SPEC no índice do `AGENTS.md`, **correção da
tabela D-5 da SPEC 050** (que hoje descreve a audiência como validando quando ela não valida — e
que só passa a ser verdade com o D-2), e a sequência completa da §9.3.

---

## 8. i18n

Namespace novo `Import.*`, compartilhado pelos dois importadores — é o que impede o vocabulário
de divergir de novo. `messages/en.json` é a fonte da verdade; `pt-BR.json` espelha.

| Chave                             | Conteúdo                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| `Import.source.*`                 | Rótulos dos cards de fonte (migra de `Broadcasts.audience.source`)    |
| `Import.template.*`               | Card de modelo + descrições de coluna (§6.1)                          |
| `Import.template.noteTags`        | Nota de etiquetas (§6.2) — **nova**                                   |
| `Import.template.noteTagCreation` | Nota de criação de etiqueta por papel — **nova**                      |
| `Import.template.noteHeader`      | Nota de cabeçalho/colunas extras — **nova**                           |
| `Import.upload.*`                 | Dropzone, progresso, aba, aceitos (§6.3)                              |
| `Import.reason.*`                 | Motivos unificados (F2)                                               |
| `Import.parseError.*`             | Códigos de erro de parsing, `+ too_many_rows_contacts` (teto de 10 k) |
| `Import.sheets.*`                 | Campo de link do Google + erros                                       |
| `Contacts.importModal.*`          | Só o que é específico de contato (resultado, etiquetas, toasts)       |

`Broadcasts.audience.{source,template,upload,sheets,parseError,invalidReason}` são **removidos**
depois que o passo 2 migrar — deixar os dois é convidar a edição do lado errado.

> ⚠️ `npm run i18n:check` compara ~1 600 chaves e quebra na menor divergência. Como esta SPEC
> **move** chaves, rodá-lo a cada fase (e não só no fim) é o que evita caçar a chave perdida
> depois de 200 linhas de diff.

---

## 9. Plano de teste

### 9.1 Automatizados (Vitest, co-locados)

Os casos A–K da §2.2 viram teste — foi como foram descobertos.

`src/lib/spreadsheet/parse-csv.test.ts`

| Caso | Entrada                                      | Esperado                                                     |
| ---- | -------------------------------------------- | ------------------------------------------------------------ |
| A    | CSV `,`, `tags` final = `vip,lead` sem aspas | `["vip"]` — **documenta a perda**; a nota da §6.2 é a defesa |
| B    | CSV `,`, `tags` = `"vip, lead"`              | `["vip","lead"]`                                             |
| C    | CSV `,`, `tags` = `vip;lead`                 | `["vip","lead"]`                                             |
| D    | CSV `,`, `tags` no meio sem aspas            | colunas deslocam — trava o comportamento conhecido           |
| E    | **CSV `;`** com `phone;name;email`           | **3 colunas reconhecidas** (D-4) — hoje devolve vazio        |
| E2   | CSV `;` com `tags` = `"vip, lead"`           | `["vip","lead"]` (aspas valem nos dois delimitadores)        |
| E3   | CSV `,` com vírgula dentro de campo citado   | delimitador continua `,` — o farejo olha só o cabeçalho      |
| F    | `Maria D'Ávila`, `O'Brien & Co`              | **preservados** (D-5) — hoje viram `DÁvila` / `OBrien`       |
| G    | `"Maria ""Bibi"" Souza"`                     | `Maria "Bibi" Souza` (D-5)                                   |
| K    | `parseTagCell('vip\|lead')`                  | `["vip                                                       | lead"]`— trava que só`,`e`;` separam |

`src/lib/spreadsheet/parse-xlsx.test.ts` — manter os existentes; acrescentar **H** (célula com
`vip, lead` → duas etiquetas, sem aspas) e cabeçalhos em pt-BR numa aba secundária.

`src/lib/spreadsheet/normalize.test.ts` (ex-`audience/normalize.test.ts`) — acrescentar **J**:

| Entrada         | Antes (hoje) | Depois (D-2)                            |
| --------------- | ------------ | --------------------------------------- |
| `5510987654321` | válida       | inválida · `invalid_ddd`                |
| `19992496598`   | válida crua  | válida · **`5519992496598`**            |
| `999999999999`  | válida       | inválida · `invalid_ddd`                |
| `+351912345678` | válida       | válida · `foreign`                      |
| `551198765432`  | válida       | válida · `mobile_legacy` (SPEC 050 D-6) |

**Não reescrever:** `phone/br.test.ts`, `dedupe.test.ts`, `phone-utils.test.ts` — devem passar
sem alteração. Se algum quebrar, a SPEC 050 foi violada e a fase está errada.

### 9.2 Manuais antes do merge

Marque cada um; os quatro primeiros são os que a suíte não alcança.

1. **CSV `;` do Excel em português.** Abrir o Excel em pt-BR → "Salvar como CSV UTF-8" →
   importar em **Contatos**. Hoje: "nenhuma linha válida". Depois: importa.
2. **Google Planilhas** com link público → contatos entram. Depois **tirar** o
   compartilhamento e repetir → mensagem de "planilha não está pública", não erro genérico.
3. **`.xlsx` com duas abas**, a primeira sendo uma capa sem telefone → o seletor aparece e a aba
   certa é escolhida sozinha.
4. **Etiquetas, os três jeitos** — `vip;lead` num CSV, `"vip, lead"` num CSV, `vip, lead` numa
   célula do Excel → as três produzem duas etiquetas. Repetir logado como **agente** → as
   desconhecidas são ignoradas com aviso.
5. **Alerta pós-importação (o pedido):** arquivo com 3 telefones bons e 3 ruins (DDD `10`, 6
   dígitos, vazio) → os 3 bons entram, e a lista dos 3 barrados **continua na tela** depois de
   "Importação concluída", com linha e motivo.
6. **Apóstrofo:** importar `Maria D'Ávila` → aparece com apóstrofo no detalhe do contato.
7. **SPEC 050 preservada:** `11 9876-5432` (legado) entra sem aviso na importação;
   `10 98765-4321` é barrado como `DDD inválido` — em pt-BR **e** em inglês.
8. **Disparo não regrediu:** passo 2 do disparo com as 5 fontes, uma planilha `.xlsx` e um link
   do Google → mesma tela, mesmos números, triagem funcionando.
9. **Tema e viewport:** modal de importação em claro/escuro e em 375 px de largura.

### 9.3 Sequência obrigatória (não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 10. Riscos e ordem

| Fase | Entrega                    | Risco se pular / se der errado                                                                                                                                  |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Camada comum + D-4 + D-5   | Nenhum ganho de UI ainda; se o farejo de delimitador errar, **os dois** importadores erram junto — por isso o farejo olha só o cabeçalho e cai em `,` no empate |
| F2   | Validação unificada (D-2)  | **Maior risco da SPEC:** muda o que a audiência aceita. Reversível por parâmetro                                                                                |
| F3   | Rota neutra                | Baixo. Rota interna, sem consumidor externo                                                                                                                     |
| F4   | Componentes compartilhados | Regressão visual no passo 2 do disparo — coberta pelo teste manual 8                                                                                            |
| F5   | Importador novo            | O ganho todo está aqui; sem F1–F4 não existe                                                                                                                    |
| F6   | Escala (D-7)               | Sem isso, um `.xlsx` grande fica lento e pode parecer travado                                                                                                   |
| F7   | i18n + docs                | `i18n:check` quebra o build; a SPEC 050 continua descrevendo errado                                                                                             |

**Risco transversal:** esta SPEC toca o importador de audiência, que é caminho de **disparo em
massa pago**. Toda fase precisa terminar com o teste manual 8 antes de seguir.

---

## 11. O que preciso de você, Bruno

### 11.1 Decisões para ratificar (bloqueiam o início)

| #       | Pergunta                                                                                       | Recomendação                         |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| **D-1** | Mover os módulos de formato para `src/lib/spreadsheet/` (13 imports) ou deixar em `audience/`? | **Mover**                            |
| **D-2** | A audiência de disparo passa a validar DDD/9º dígito (SPEC 050)? Muda produção.                | **Sim** — hoje ela envia para DDI 19 |
| **D-7** | Teto de 10 000 linhas na importação de **contatos** está bom?                                  | Sim, com "divida o arquivo"          |
| **D-8** | Trocar `/api/broadcasts/audience/google-sheets` por `/api/import/google-sheets`?               | **Sim**                              |

### 11.2 Material de teste que só você consegue produzir

Não dá para gerar isto com fidelidade aqui — são arquivos que dependem do seu Excel e da sua
conta Google:

1. **Um `.csv` salvo pelo Excel em português** (delimitador `;`, acentos, BOM), com ~20 linhas
   reais anonimizadas. É o insumo do teste manual 1 e o caso que mais aparece no suporte.
2. **Um `.xlsx` de verdade**, de preferência um que um cliente seu tenha mandado — com aba de
   capa, células mescladas se houver, telefone formatado como número **e** como texto.
3. **Um link de Google Planilhas público** de teste (pode ser com dados fictícios) para o teste
   manual 2 — e a confirmação de que a instalação consegue sair para `docs.google.com`
   (se a Hostinger bloquear egress, o caminho do Google falha em produção mesmo com o código
   certo, e é melhor descobrir antes da F5).

### 11.3 Confirmações de contexto

- **Migração: nenhuma.** Esta SPEC não pede nada nos projetos `vn`, `rs` ou `jh`.
- **Commit:** como sempre, entrego o comando pronto — o `git` é seu.
- **SPEC 050:** o §7 (F7) altera a tabela D-5 daquele documento. Se você preferir que a SPEC 050
  fique intocada e a correção viva só aqui, me avise — mas aí ficam duas descrições do mesmo
  comportamento, e uma delas errada.

---

## 12. Referências

- Audiência multiformato (a fonte deste desenho): [SPEC 044](./spec-044-audiencia-multiformato-e-triagem.md)
- Telefone e validação BR (preservada aqui): [SPEC 050](./spec-050-padronizacao-telefone-br.md)
- Exportação e round-trip de cabeçalhos: [SPEC 051](./spec-051-exportacao-de-contatos.md)
- Tokenizador compartilhado: `src/lib/contacts/parse-contact-csv.ts`
- Guarda SSRF do Google Sheets: `src/lib/audience/google-sheets.ts`
- Dedup autoritativo: `supabase/migrations/022_contact_phone_dedup.sql`
