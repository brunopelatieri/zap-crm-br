# SPEC 050 — Padronização de números de telefone e validação brasileira

| Campo            | Valor                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Status           | **Aprovada — pronta para implementação (F1)**. Decisões D-1, D-2, D-5 e D-6 ratificadas pelo mantenedor em 2026-08-13 |
| Contexto         | [phone-number-format-standard.md](./context/phone-number-format-standard.md) — mapeamento dos pontos de entrada       |
| Referência       | [mobile_number_brasil_guide.md](./references/mobile_number_brasil_guide.md) — Anatel, 67 DDDs, regex                  |
| Migrações        | **058** (opcional, fase F5) — 055/056 existem, 057 está reservada pela SPEC 048                                       |
| Dependência nova | `react-phone-number-input` (+ `libphonenumber-js` transitiva)                                                         |
| Data             | 2026-08-13                                                                                                            |

---

## 1. O problema, em uma frase

`contacts.phone` é `TEXT NOT NULL` sem constraint, e **dois** dos caminhos de escrita gravam o
que o usuário digitou — enquanto os outros cinco gravam dígitos-only com DDI. O resultado é uma
coluna onde `"+55 (19) 9 9249-6598"` e `"5519992496598"` são o mesmo contato escrito de duas
formas, e onde um número sem DDI (`"19992496598"`) é indistinguível de um número de outro país.

Esta SPEC fecha os dois caminhos abertos e acrescenta o que o app nunca teve: **validação
brasileira de verdade** (DDD contra a lista da Anatel, celular × fixo), hoje existente apenas
**fora** do app, no workflow n8n.

### 1.1 O que NÃO é o problema

O formato canônico **já está decidido e implementado** — dígitos-only, com DDI, sem `+`
(`sanitizePhoneForMeta` / `normalizePhone`, e a coluna gerada `contacts.phone_normalized` da
migração 022). Esta SPEC **não inventa formato novo**: ela faz os dois caminhos divergentes
convergirem para o que já existe, e acrescenta uma camada de validação regional por cima.

---

## 2. Estado atual (verificado no código em 2026-08-13)

| Caminho de escrita                             | Grava hoje                      | Valida DDD?  |
| ---------------------------------------------- | ------------------------------- | ------------ |
| Formulário manual (`contact-form.tsx`)         | ❌ texto livre (`phone.trim()`) | ❌           |
| Importação CSV (`import-modal.tsx`)            | ❌ texto livre (valor do CSV)   | ❌           |
| Webhook Meta (`ingest.ts`)                     | ✅ dígitos-only                 | ❌           |
| API pública (`api/v1/contacts.ts`)             | ✅ dígitos-only                 | ❌           |
| Audiência de disparo (`audience/normalize.ts`) | ✅ dígitos-only                 | ❌           |
| Pareamento Evolution (`pair/route.ts`)         | ✅ dígitos-only (`^\d{10,15}$`) | ❌           |
| Ingestão n8n (externa)                         | ✅ dígitos-only                 | ✅ **única** |

A única validação hoje no app é `isValidE164` — `/^\+?[1-9]\d{6,14}$/`, que aceita
`999999999999` e qualquer DDD inexistente.

---

## 3. Objetivo

1. **Um formato gravado, sempre:** dígitos-only, com DDI, sem `+`, em **todos** os caminhos.
2. **Validação BR quando o deploy é brasileiro:** DDD contra os 67 códigos da Anatel; celular
   atual (11 dígitos), fixo (10 dígitos) **e celular legado de 8 dígitos** (10 dígitos no
   total) — os três **aceitos**, porque os três podem ter WhatsApp (ver D-6).
3. **DDI implícito quando o deploy é brasileiro:** número sem DDI ganha `55`. Deploy não-BR
   **recusa** o número sem DDI em vez de adivinhar país.
4. **Entrada guiada no formulário:** máscara + seletor de país, para o usuário não conseguir
   digitar algo inválido.
5. **Rejeição legível na importação:** linha a linha, com número da linha e motivo — nunca um
   "31 linhas ignoradas" sem dizer quais.

### 3.1 Fora de escopo

- Reescrever dados já gravados fora do padrão (é a fase **F5**, opcional, com procedimento
  manual — ver §9).
- `CHECK` constraint em `contacts.phone` (fase F5, depende de F5.1 concluída).
- Validação regional de **outros** países (a lib de máscara já cobre formatação; validação
  específica por país só entra se algum deploy pedir).
- O tradutor inbound do canal QRCode (`remoteJid` → telefone) — é da SPEC 048/PRD 047 F4.
  Esta SPEC só garante que a função de sanitização que ele deve usar exista e esteja testada.

---

## 4. Decisões

> **Ratificadas pelo mantenedor em 2026-08-13:** D-1, D-2, D-5, D-6. D-3 e D-4 seguiram sem
> objeção e ficam como propostas na forma abaixo.

### D-1 ✅ — O que define "este deploy é brasileiro": `NEXT_PUBLIC_APP_LOCALE`, **não** o idioma da sessão

**Decisão:** ler `process.env.NEXT_PUBLIC_APP_LOCALE`, ignorando o cookie `NEXT_LOCALE`.

O app resolve idioma em três níveis (`src/i18n/request.ts`): cookie `NEXT_LOCALE` → env →
`DEFAULT_LOCALE`. **O cookie é por dispositivo.** Usar `useLocale()` para decidir validação
significaria que um operador que trocou a UI dele para inglês gravaria contatos com regra
diferente do colega ao lado — **na mesma conta, na mesma base**. Validação de telefone é regra
de **integridade de dado**, não preferência de exibição: tem que ser uniforme por instalação.

Por isso a resolução aqui é deliberadamente **diferente** da do i18n: `env → DEFAULT_LOCALE`,
pulando o cookie. Isso vai num helper próprio e explicitamente nomeado, para ninguém confundir
os dois mais tarde.

> ⚠️ **Duas consequências do `NEXT_PUBLIC_` que a doc do Next (`environment-variables.md`)
> confirma e que a implementação precisa respeitar:**
>
> 1. O valor é **inlinado no bundle durante `next build`** e congela ali. Mudar
>    `NEXT_PUBLIC_APP_LOCALE` exige **rebuild**, não basta reiniciar o servidor. Precisa estar
>    documentado no README, porque na Hostinger o build roda no push.
> 2. O inlining só acontece com **acesso literal**: `process.env.NEXT_PUBLIC_APP_LOCALE`
>    funciona; `const env = process.env; env.NEXT_PUBLIC_APP_LOCALE` **não é inlinado** e vira
>    `undefined` no browser, silenciosamente. O helper precisa conter a expressão literal.

**Aprovado:** com `NEXT_PUBLIC_APP_LOCALE` **ausente**, cai em `DEFAULT_LOCALE` (`'pt-BR'`) →
**modo BR ligado**, seguindo a mesma cadeia do i18n. A alternativa ("ausente = modo estrito")
faria uma instalação recém-clonada rejeitar todo número brasileiro — parece defeito, não
configuração. Fica **uma** definição de "este deploy é brasileiro", compartilhada com o i18n.

### D-2 ✅ — Número estrangeiro em deploy BR: aceito pelo caminho genérico

O pedido diz "número sem DDI + deploy pt-BR → adiciona 55; deploy não-pt-BR → recusa". Isso
deixa em aberto o caso que vai acontecer: **uma empresa brasileira com um cliente argentino.**

**Decisão:** a validação BR se aplica a números que **parecem domésticos**; um número que já
traz DDI estrangeiro passa pelo caminho genérico (`isValidE164`) e é aceito.

Classificação por comprimento, após remover tudo que não é dígito:

| Dígitos                         | Interpretação     | Validação aplicada (modo BR)           |
| ------------------------------- | ----------------- | -------------------------------------- |
| 10 ou 11                        | doméstico sem DDI | **BR** (prefixa `55`)                  |
| 12 ou 13 iniciando `55`         | doméstico com DDI | **BR** (remove `55`, valida, recompõe) |
| 12 a 15, **não** iniciando `55` | estrangeiro       | genérica (`isValidE164`)               |
| < 10 ou > 15                    | inválido          | rejeita                                |

Em modo **não-BR**, só a linha "estrangeiro" e a genérica valem: 10/11 dígitos sem DDI são
**recusados** com o motivo `missing_country_code`, exatamente como pedido.

> **Colisão que parece bug e não é — não "consertar" depois:** o DDD **55** existe (Rio Grande
> do Sul, Santa Maria). A regra "começa com 55 e tem 12–13 dígitos → é DDI" continua correta
> porque um número com DDD 55 e sem DDI tem 10 ou 11 dígitos (`55` + 8 ou 9), nunca 12–13.
> `5551987654321` (13) → DDI 55 + DDD 51 ✅. `55987654321` (11) → DDD 55 + celular ✅. Um
> comentário no código precisa dizer isso, senão alguém "corrige" e quebra o RS.

### D-3 — Quem decide, quando a lib de máscara e a validação BR discordam _(sem objeção)_

`react-phone-number-input` traz `libphonenumber-js`, que tem a própria noção de validade. Dois
validadores no mesmo campo produzem o pior defeito possível: **"válido na tela, rejeitado ao
salvar"** (ou o inverso, que trava o usuário sem explicação).

**Decisão proposta:** precedência explícita, sem empate.

- **Modo BR, número doméstico:** a validação desta SPEC é **autoritativa**. A lib serve só para
  máscara, formatação e seletor de país.
- **Qualquer outro caso:** `isValidPhoneNumber` da lib decide.

### D-4 — Rejeição na importação: resumo de linhas, não `alert()` _(sem objeção)_

**Decisão proposta:** reusar o padrão que já existe em
[`audience-import-summary.tsx`](../src/components/broadcasts/audience/audience-import-summary.tsx)
— chips de contagem + lista expansível de linhas rejeitadas com número da linha e motivo.

O pedido menciona "alert box (ou outro método — escolha o melhor)". Um `alert()` (ou um toast)
não resolve o problema real: numa planilha de 1.200 linhas, saber que "31 foram rejeitadas" sem
saber **quais** deixa o usuário sem ação possível. O componente citado já foi construído para
exatamente este problema no importador de audiência (SPEC 044 §3.5) — o importador de contatos
deve herdar o mesmo comportamento, não inventar um segundo.

**Comportamento:** a importação **não é bloqueada** — as linhas válidas entram, as inválidas são
listadas. Bloquear o arquivo inteiro por causa de 3 linhas ruins seria pior para o usuário.

### D-5 ✅ — Estritude por caminho de escrita

A validação BR **não** pode entrar em todos os caminhos com a mesma força: recusar um inbound
por DDD estranho significaria **perder uma mensagem recebida**.

| Caminho                    | Normaliza (DDI, dígitos-only) | Valida DDD/tipo  | Se inválido                |
| -------------------------- | ----------------------------- | ---------------- | -------------------------- |
| Formulário manual          | ✅                            | ✅               | **bloqueia** o salvar      |
| Importação CSV de contatos | ✅                            | ✅               | pula a linha + reporta     |
| Audiência de disparo       | ✅ (já faz)                   | ✅               | linha inválida (já existe) |
| API pública `/api/v1`      | ✅ (já faz)                   | ❌ **desligada** | —                          |
| Webhook Meta / QRCode      | ✅ (já faz)                   | ❌ **nunca**     | grava assim mesmo          |

**Aprovado (API pública):** liga a **normalização** (que só melhora o dado gravado) e mantém a
validação de DDD **desligada**. Ligá-la quebraria integrações existentes que hoje criam contato
com qualquer número E.164 válido — revisitar só quando houver um consumidor real reclamando de
dado sujo. Consequência aceita e registrada: é possível criar, **pela API**, um contato com DDD
inexistente que o formulário recusaria.

**Por que o webhook nunca valida:** recusar um inbound por DDD estranho significa **perder uma
mensagem que o cliente enviou**. Nenhuma regra de qualidade de dado justifica isso.

### D-6 ✅ — Celular legado de 8 dígitos: **aceito**

O guia de referência recomenda "rejeitar ou sinalizar para revisão manual" o celular legado
(8 dígitos após o DDD, pré-Resolução 553/2010). **Não seguimos essa recomendação**, por decisão
do mantenedor: o próprio guia observa que o WhatsApp mantém contatos antigos nesse formato, e
este é um CRM **de WhatsApp** — recusar na entrada bloquearia o cadastro de uma pessoa que está
efetivamente alcançável pelo produto.

**Como isso resolve a ambiguidade dos 10 dígitos.** Um número de 10 dígitos é DDD + 8 dígitos
locais, e o primeiro dígito local decide a leitura:

| Primeiro dígito local | Leitura                                                                  | `kind`          |
| --------------------- | ------------------------------------------------------------------------ | --------------- |
| `9`                   | celular legado (não é fixo — fixo nunca começa com 9)                    | `mobile_legacy` |
| `6`, `7`, `8`         | fixo **ou** celular legado — indistinguível, e não precisamos distinguir | `landline`      |
| `2`, `3`, `4`, `5`    | fixo                                                                     | `landline`      |
| `0`, `1`              | inválido (tronco / códigos de serviço como 190)                          | rejeita         |

O `kind` é informativo — **nenhuma regra do produto depende dele**. Ele existe para diagnóstico
e para a mensagem de erro; classificar errado entre fixo e celular legado na faixa 6–8 não tem
consequência funcional.

**O 9º dígito NÃO é acrescentado automaticamente.** Converter `1198765432` em `11998765432`
seria adivinhar: se o número for na verdade um fixo iniciado em 8, o "conserto" produz um
número que não existe. Grava-se como veio (com DDI): `551198765432`, 12 dígitos.

> ✅ **Isto já conversa com o dedup existente.** `phonesMatch` (`phone-utils.ts`) compara os
> **últimos 8 dígitos** justamente para tolerar essa diferença. Um contato gravado como
> `551198765432` e um inbound que chegue como `5511998765432` resolvem para o **mesmo**
> contato. Ou seja: aceitar o legado não fragmenta a base — o mecanismo de tolerância já
> estava lá, e esta decisão passa a se apoiar nele de propósito.

**Custo aceito:** o formulário deixa de conseguir pegar o erro de digitação mais comum do
Brasil ("esqueci o 9"). Mitigação em F2: um **aviso não-bloqueante** ("este número tem 8
dígitos — confirme se está correto") quando um número de 10 dígitos é digitado **manualmente**.
Na **importação**, nenhum aviso — base legada é exatamente o caso de uso.

---

## 5. Modelo: o módulo compartilhado

### 5.1 `src/lib/i18n/deployment-locale.ts` (novo)

```ts
/** Locale DA INSTALAÇÃO — não o da sessão. Ver SPEC 050 §4 (D-1). */
export function getDeploymentLocale(): AppLocale;
export function isBrDeployment(): boolean;
```

Reusa `isAppLocale` / `DEFAULT_LOCALE` de `locales.ts` (não duplica a lista de idiomas). O
cabeçalho do arquivo precisa dizer, em uma frase, **por que não usa `useLocale()`** — senão a
primeira pessoa a mexer "corrige" para o cookie.

### 5.2 `src/lib/phone/br.ts` (novo)

Por que pasta nova e não dentro de `whatsapp/phone-utils.ts`: aquele arquivo é importado por
contatos, audiência, API pública e inbox — já não é "de WhatsApp" há tempo, mas movê-lo é um
refactor de dezenas de imports que não pertence a esta SPEC. O módulo novo **importa**
`sanitizePhoneForMeta` de lá; consolidar os dois fica para quando alguém tiver motivo.

```ts
export const BR_COUNTRY_CODE = '55';
export const BR_AREA_CODES: ReadonlySet<number>; // 67 DDDs (Anatel)

/** `mobile_legacy` = 8 dígitos locais, pré-nono dígito (D-6). Informativo. */
export type BrPhoneKind = 'mobile' | 'mobile_legacy' | 'landline';

export type PhoneRejectReason =
  | 'empty'
  | 'invalid_length'
  | 'invalid_ddd'
  | 'mobile_invalid_ninth_digit' // 11 díg.: o local de 9 díg. não começa com 9
  | 'invalid_local_prefix' // 10 díg.: local começa com 0 ou 1
  | 'missing_country_code'; // só em deploy não-BR

export type PhoneNormalizeResult =
  | {
      ok: true;
      phone: string; // dígitos-only, com DDI, sem `+`
      kind: BrPhoneKind | 'foreign';
      ddd: number | null;
      /** true em `mobile_legacy` — dispara o aviso não-bloqueante do formulário (D-6). */
      legacy: boolean;
    }
  | { ok: false; reason: PhoneRejectReason };

/** Pipeline completo. `phone` de saída = dígitos-only com DDI, sem `+`. */
export function normalizeContactPhone(
  raw: string,
  opts?: { brMode?: boolean } // default: isBrDeployment()
): PhoneNormalizeResult;

/** Exibição: 5519992496598 → "+55 (19) 99249-6598". Nunca lança. */
export function formatPhoneForDisplay(digits: string): string;
```

**Pipeline de `normalizeContactPhone` — a ordem é o comportamento:**

```
raw
 ├─ sanitizePhoneForMeta → só dígitos          (reusa phone-utils, não reimplementa)
 ├─ vazio?                          → reason: empty
 ├─ remove 0 de tronco à esquerda   (011… → 11…)
 ├─ classifica por comprimento      (tabela do D-2)
 │   ├─ estrangeiro → isValidE164 → ok | invalid_length
 │   └─ doméstico:
 │       ├─ modo BR desligado       → reason: missing_country_code
 │       ├─ tira o DDI 55 se houver
 │       ├─ DDD ∈ BR_AREA_CODES?    → senão invalid_ddd
 │       ├─ 11 díg.: local[0] === '9'?      → senão mobile_invalid_ninth_digit
 │       │                                   → kind: mobile
 │       ├─ 10 díg.: local[0] ∈ 2–9?        → senão invalid_local_prefix
 │       │      ├─ local[0] === '9' → kind: mobile_legacy · legacy: true  (D-6)
 │       │      └─ local[0] ∈ 2–8   → kind: landline
 │       └─ ok: '55' + nacional
 └─ ok
```

Fixo, celular atual **e** celular legado de 8 dígitos são aceitos (§3 item 2, D-6). O guia de
referência sugere, na seção de integração WhatsApp, recusar fixo — e, na tabela de casos de
borda, recusar o legado. **Não seguimos nenhuma das duas:** fixo com WhatsApp Business é comum
no Brasil, e o legado ainda existe em contatos antigos do próprio WhatsApp. Recusar qualquer um
dos dois impediria o cadastro de alguém que o produto alcança na prática.

### 5.3 Sobre `react-phone-number-input`

Dependência nova (traz `libphonenumber-js`). Pontos que a implementação precisa resolver, não
assumir:

- **CSS:** a lib traz `react-phone-number-input/style.css` própria. O projeto é Tailwind v4 +
  shadcn/ui com tema claro/escuro por token. É preciso verificar se o CSS da lib respeita o
  tema ou se o componente precisa ser estilizado sem a folha padrão. **Se a integração ficar
  feia ou brigar com o tema, o fallback é `react-phone-number-input/input`** (só o input, sem
  seletor de país e sem CSS) + um seletor de país shadcn próprio.
- **Formato do valor:** a lib entrega E.164 **com** `+`. Sanitizamos na submissão — não muda o
  formato gravado.
- **País padrão:** `BR` quando `isBrDeployment()`, sem país padrão caso contrário.
- **Peso:** conferir qual conjunto de metadata (`min` / `max` / `mobile`) é suficiente; o
  padrão é o maior.

---

## 6. Fases de execução

### F1 — Módulo compartilhado (nenhuma mudança de comportamento)

Cria `deployment-locale.ts`, `phone/br.ts` e os testes. Nada consome ainda. Termina verde e
sozinha — é o que permite revisar a regra isolada do ruído de UI.

### F2 — Formulário manual (`contact-form.tsx`)

Troca o `<Input>` cru pelo componente de máscara; valida com `normalizeContactPhone` no submit
**e** no blur (o blur já existe para checar duplicata — a validação entra no mesmo gancho);
grava `result.phone`. Erro inline abaixo do campo, no mesmo lugar onde hoje aparece o aviso de
duplicata. `phoneHint` e `phonePlaceholder` passam a depender do modo BR.

Inclui o **aviso não-bloqueante do D-6**: quando `result.legacy === true`, mostrar no mesmo
espaço um aviso âmbar ("8 dígitos — confirme") que **não** impede o salvar. Reusa o tratamento
visual que o `dupMatch` fuzzy já usa (borda âmbar), para não inventar um terceiro estilo de
aviso no mesmo campo.

### F3 — Importação CSV (`import-modal.tsx` + `parse-contact-csv.ts`)

Normaliza cada linha logo após o parse; separa válidas de rejeitadas (com `sourceRow` — o
`readCsvTable` **já devolve** `lineNumber`, hoje ignorado por este importador); grava o valor
normalizado; renderiza o resumo de rejeitadas (D-4). O `dedupeByPhone` passa a rodar **depois**
da normalização — hoje ele deduplica valores crus, então `"+55 19 …"` e `"5519…"` só não viram
dois contatos por causa do índice único do banco.

### F4 — Exibição

`formatPhoneForDisplay` aplicado onde hoje se renderiza `contact.phone` cru: detalhe do
contato, sidebar do inbox, lista de conversas, diretório de contatos, cards de negócio. Sem
isso, F2/F3 **pioram** a UX (todo mundo passa a ver `5519992496598`).

### F5 — (Opcional) Dados legados e constraint

Diagnóstico, limpeza e `CHECK` — ver §9. Não roda junto com F1–F4.

---

## 7. i18n

Chaves novas em `messages/en.json` **e** `messages/pt-BR.json` (o `npm run i18n:check` quebra
se divergirem). Reaproveitar a nomenclatura de motivos que já existe em
`Broadcasts.audience.invalidReason` para não ter dois vocabulários para a mesma coisa.

| Namespace                     | Chaves                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Contacts.form`               | `phoneInvalidDdd`, `phoneInvalidNinthDigit`, `phoneInvalidLocalPrefix`, `phoneInvalidLength`, `phoneMissingCountryCode`, `phoneHintBr`, `phoneLegacyWarning` (D-6, não-bloqueante) |
| `Contacts.importModal`        | `resultRejected`, `rejectedRows`, `rejectedLine`, `showAllRejected`                                                                                                                |
| `Contacts.importModal.reason` | mesmas chaves de motivo acima, em forma curta (para a coluna da lista)                                                                                                             |

Mensagens de `/api/**` permanecem em **inglês** (política da §4 do relatório de i18n).

---

## 8. Plano de teste

### 8.1 Automatizados (Vitest, co-locados)

`src/lib/phone/br.test.ts` — o núcleo. Casos obrigatórios:

| Entrada                               | Modo   | Esperado                                                           |
| ------------------------------------- | ------ | ------------------------------------------------------------------ |
| `+55 (19) 9 9249-6598`                | BR     | ok · `5519992496598` · mobile                                      |
| `19992496598`                         | BR     | ok · `5519992496598` (DDI adicionado)                              |
| `(11) 3456-7890`                      | BR     | ok · `551134567890` · **landline**                                 |
| `011 99999-9999`                      | BR     | ok (0 de tronco removido)                                          |
| `5551987654321`                       | BR     | ok · DDD 51 (**não** confundir com DDI+DDD 55)                     |
| `55987654321`                         | BR     | ok · DDD **55** (RS) · mobile                                      |
| `10 98765-4321`                       | BR     | ✗ `invalid_ddd`                                                    |
| `11 9876-543`                         | BR     | ✗ `invalid_length` (9 dígitos total — nem 10 nem 11)               |
| `+351 912 345 678`                    | BR     | ok · `foreign` (não rejeita estrangeiro)                           |
| `19992496598`                         | não-BR | ✗ `missing_country_code`                                           |
| `''` / `'abc'`                        | ambos  | ✗ `empty`                                                          |
| **D-6 — celular legado de 8 dígitos** |        |                                                                    |
| `11 9876-5432`                        | BR     | ok · `551198765432` · **`mobile_legacy`** · `legacy: true`         |
| `11 8765-4321`                        | BR     | ok · `landline` (inicial 8 — fixo **ou** legado, não distinguimos) |
| `11 1234-5678`                        | BR     | ✗ `invalid_local_prefix` (inicial 1)                               |
| `11 0234-5678`                        | BR     | ✗ `invalid_local_prefix` (inicial 0)                               |
| `11 88765-4321`                       | BR     | ✗ `mobile_invalid_ninth_digit` (11 díg. sem 9 inicial)             |

Um teste **obrigatório** fecha o D-6 contra o dedup, e não pertence a `br.test.ts` e sim a
`dedupe.test.ts`: `phonesMatch('551198765432', '5511998765432')` deve ser **`true`** — é o que
garante que aceitar o legado não fragmenta a base quando o mesmo contato chega pelo webhook
com o 9º dígito.

`src/lib/contacts/parse-contact-csv.test.ts` — estender com telefones mascarados/`+`/espaços.
`src/lib/whatsapp/phone-utils.test.ts` e `dedupe.test.ts` — **não** reescrever; devem continuar
passando sem alteração (prova de que nada do formato canônico mudou).

> ⚠️ `11 8765-4321` (10 dígitos, inicial `8`) é indistinguível entre fixo e celular legado.
> Resolvido pelo **D-6**: aceita como `landline`, e a classificação não afeta nada — o `kind`
> é informativo. O teste existe para travar o comportamento, não porque a distinção importe.
>
> ⚠️ **Correção feita na implementação (2026-08-13):** a versão anterior desta tabela tinha
> `11 98765-432` esperando `invalid_length` — um resquício do rascunho **anterior** ao D-6.
> Esse dado reduz aos mesmos 10 dígitos de `11 9876-5432` (local `98765432`, 8 dígitos,
> inicial `9`) e, pós-D-6, os dois têm que dar o **mesmo** resultado: `mobile_legacy`. Trocado
> por `11 9876-543` (9 dígitos totais — nem 10 nem 11), que é o caso genuíno de comprimento
> inválido dentro da faixa doméstica.

### 8.2 Manuais antes do merge

1. Cadastrar contato pelo formulário com máscara, em deploy pt-BR → gravado como `55…`.
2. Mesmo formulário com DDD `10` → bloqueia com mensagem legível **em pt-BR e em en**.
3. Importar CSV com mistura: válidos, DDD inválido, sem DDI, duplicado, estrangeiro →
   válidos entram, resumo lista os rejeitados com linha e motivo.
4. Trocar o idioma da UI para inglês **sem** mudar a env → validação BR **continua** valendo
   (é a prova de D-1).
5. Rodar com `NEXT_PUBLIC_APP_LOCALE=en` **e rebuild** → número sem DDI é recusado.
6. Conferir a máscara nos dois temas (claro/escuro) e em viewport móvel.
7. **D-6:** cadastrar `11 9876-5432` pelo formulário → **salva**, com aviso âmbar de 8 dígitos;
   o mesmo número via CSV → entra **sem** aviso.

### 8.3 Sequência de validação (obrigatória, não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

---

## 9. F5 — Dados legados (procedimento manual, **não** automático)

**Nada nesta fase roda sem o mantenedor pedir.** São três projetos Supabase (`vn`, `rs`, `jh`)
e o AGENTS.md exige confirmação antes de qualquer migração.

**9.1 Diagnóstico primeiro** — quantas linhas estão fora do padrão, e quantas colidiriam:

```sql
-- Linhas cujo `phone` difere da forma canônica
SELECT count(*) FROM contacts WHERE phone <> phone_normalized;

-- Colisões que um UPDATE cego criaria (o índice único rejeitaria)
SELECT account_id, phone_normalized, count(*)
FROM contacts GROUP BY 1, 2 HAVING count(*) > 1;
```

**9.2 Ordem obrigatória.** Um `UPDATE contacts SET phone = phone_normalized` pode violar
`idx_contacts_account_phone_normalized`. Rodar `SELECT public.merge_duplicate_contacts();`
(migração 022, já é idempotente e re-pontua os filhos) **antes** do UPDATE.

**9.3 `CHECK` constraint (migração 058)** — só depois de 9.2 confirmada em cada projeto, senão
a migração falha em produção. Formato sugerido: `phone ~ '^[1-9][0-9]{6,14}$'`.

---

## 10. Ordem de execução e riscos

| Fase | Entrega                | Risco se pular                                                     |
| ---- | ---------------------- | ------------------------------------------------------------------ |
| F1   | `phone/br.ts` + testes | —                                                                  |
| F2   | Formulário com máscara | Continua entrando texto livre pelo caminho mais usado              |
| F3   | Importação normalizada | CSV de cliente (com máscara BR) continua sujando a base            |
| F4   | Exibição formatada     | **F2/F3 pioram a UX** — todos veem `5519992496598`                 |
| F5   | Legado + constraint    | Base fica com dois formatos convivendo; nada quebra, mas não fecha |

**Risco principal:** F2 e F3 mudam o valor gravado. Um contato criado depois da mudança e um
criado antes vão diferir na coluna `phone` até a F5 rodar. Isso **não quebra envio** (todo
caminho de envio já sanitiza), mas quebra qualquer comparação por igualdade de string que
alguém tenha escrito fora dos helpers de dedupe. Nenhuma foi encontrada no levantamento — mas
é o que procurar antes do merge.

---

## 11. Referências

- Mapeamento dos pontos de entrada: [phone-number-format-standard.md](./context/phone-number-format-standard.md)
- Regras Anatel, 67 DDDs, regex e casos de borda: [mobile_number_brasil_guide.md](./references/mobile_number_brasil_guide.md)
- Padrão de resumo de linhas rejeitadas: [SPEC 044 §3.5](./spec-044-audiencia-multiformato-e-triagem.md)
- Resolução de locale e política de i18n: [i18n-implementation-report.md](./i18n-implementation-report.md)
- Validação BR já existente (fora do app): [n8n_automation/SPEC_contact_ingestion_workflow.md](../n8n_automation/SPEC_contact_ingestion_workflow.md)
- Dedup autoritativo: `supabase/migrations/022_contact_phone_dedup.sql`
