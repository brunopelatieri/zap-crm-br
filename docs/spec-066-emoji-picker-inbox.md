# SPEC 066 — Seletor de emojis no composer do inbox (Frimousse)

> **Nota para quem for implementar — confirme o número do arquivo antes de commitar.**
> Este documento foi numerado como `066` a partir do índice observado em
> 2026-09-01. O `AGENTS.md` não é atualizado a cada SPEC nova, então rode
> no repo real antes de tocar em qualquer coisa:
>
> ```bash
> ls docs/spec-*.md docs/prd-*.md
> ```
>
> Se `066` já estiver ocupado, renomeie este arquivo para o próximo livre e
> ajuste o título, a linha do índice do `AGENTS.md` e todas as referências
> internas ("SPEC 066") de uma vez.

| Campo             | Valor                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Status            | Proposta — pronta para implementação                                   |
| Data              | 2026-09-01                                                             |
| Módulos afetados  | `src/lib/emoji/` (novo), `src/components/inbox/`, `src/components/ui/` |
| Migração Supabase | **Nenhuma** (ver §Configuração — Skin tone e §Configuração — Recentes) |
| Dependência nova  | `frimousse@^0.3.0` (runtime), `emojibase-data@^17` (dev)               |
| Rotas de API      | Nenhuma                                                                |

---

## Objetivo

### O problema

O composer da caixa de entrada (`src/components/inbox/message-composer.tsx`)
hoje oferece anexo, mensagem interativa, respostas rápidas, template,
rascunho por IA e nota de voz — **mas nenhuma forma de inserir emoji**. Num
CRM de WhatsApp voltado ao mercado brasileiro isso não é cosmético: o
atendente escreve com emoji o dia inteiro no WhatsApp Web e no celular, e
precisar alternar para o painel de emojis do sistema operacional (`Win+.` /
`Ctrl+Cmd+Espaço`) a cada mensagem é atrito real — pior ainda em máquinas
Windows corporativas onde o painel vem desabilitado por política.

### O que esta SPEC entrega

1. Um botão de emoji no composer do inbox que abre um seletor completo
   (busca, categorias, tom de pele, navegação por teclado) e insere o emoji
   **na posição do cursor**, sem perder o rascunho nem a seleção.
2. Uma camada de "emojis recentes" por usuário, que o Frimousse não traz
   nativamente.
3. Uma **estrutura reutilizável**: `src/lib/emoji/` (regra de negócio pura e
   testada) + `<EmojiPickerPopover>` (componente de UI genérico), de modo que
   plugar o mesmo seletor no personalizar de disparos
   (`src/components/broadcasts/step3-personalize.tsx`), no gerenciador de
   respostas rápidas (`src/components/settings/quick-replies-manager.tsx`) ou
   em qualquer `<textarea>` futuro seja um trabalho de minutos, não uma
   segunda integração do zero.

### Não-objetivos (explicitamente fora de escopo)

- **Reações a mensagens.** `src/components/inbox/message-reactions.tsx` já
  existe e tem o próprio conjunto reduzido de emojis. Trocá-lo pelo picker
  completo é uma decisão de produto separada — esta SPEC não encosta nele.
- **Segunda integração já implementada.** Broadcasts e respostas rápidas
  ficam preparadas, não entregues. A primeira integração é só o inbox.
- **Autocompletar por `:atalho:`** (digitar `:sorriso:` e virar 🙂). O
  Frimousse não faz isso e o dado de `shortcodes` da Emojibase é um segundo
  arquivo de ~170 KB por locale. Fica registrado como evolução futura.
- **Testar o Frimousse.** A suíte cobre só a camada de integração do ZAP CRM
  BR (ver §Boas Práticas — Plano de testes).

### Decisão já tomada (não reabrir)

A biblioteca é o [**Frimousse**](https://frimousse.liveblocks.io/), da
Liveblocks. Verificado no npm em 2026-09-01:

| Fato                    | Valor confirmado                                                           |
| ----------------------- | -------------------------------------------------------------------------- |
| Última versão publicada | **0.3.0** (2025-07-15) — ainda é a mais recente; `[Unreleased]` está vazio |
| Dependências de runtime | **nenhuma** (`"dependencies": null`)                                       |
| Peer deps               | `react: "^18 \|\| ^19"`, `typescript: ">=5.1.0"` (opcional)                |
| `sideEffects`           | `false` — tree-shaking funciona                                            |
| Licença                 | MIT                                                                        |

Compatível com o projeto (React 19.2.4, TypeScript 6). O changelog desde a
v0.1.0 é curto e **nada quebrou** desde então:

- **0.3.0** — prop `sticky` no `EmojiPicker.Root` (desliga cabeçalho de
  categoria fixo); TypeScript ≥ 5.1 como peer opcional.
- **0.2.0** — `emojiVersion` passou a buscar aquela versão da Emojibase (em
  vez de sempre a mais recente); **prop `emojibaseUrl` adicionada** — é ela
  que viabiliza o self-host recomendado na §Configuração.
- **0.1.1** — correção do valor controlado em `EmojiPicker.Search`.

**A API descrita no prompt de origem desta SPEC está correta**, com uma
ressalva importante e uma armadilha, ambas confirmadas lendo o `.d.ts` e o
bundle publicados:

```ts
// cdn.jsdelivr.net/npm/frimousse@0.3.0/dist/index.d.ts (verbatim)
type Locale =
  | 'bn'
  | 'da'
  | 'de'
  | 'en-gb'
  | 'en'
  | 'es-mx'
  | 'es'
  | 'et'
  | 'fi'
  | 'fr'
  | 'hi'
  | 'hu'
  | 'it'
  | 'ja'
  | 'ko'
  | 'lt'
  | 'ms'
  | 'nb'
  | 'nl'
  | 'pl'
  | 'pt'
  | 'ru'
  | 'sv'
  | 'th'
  | 'uk'
  | 'vi'
  | 'zh-hant'
  | 'zh';

type SkinTone =
  'none' | 'light' | 'medium-light' | 'medium' | 'medium-dark' | 'dark';

type Emoji = { emoji: string; label: string };

interface EmojiPickerRootProps extends ComponentProps<'div'> {
  onEmojiSelect?: (emoji: Emoji) => void;
  locale?: Locale; // default "en"
  skinTone?: SkinTone; // default "none"
  columns?: number; // default 10
  emojiVersion?: number; // default: maior versão suportada pelo navegador
  emojibaseUrl?: string; // default "https://cdn.jsdelivr.net/npm/emojibase-data"
  sticky?: boolean; // default true
}
```

- **Ressalva 1 — não existe `pt-BR` no `Locale`.** Existe `pt`. O mapeamento
  é obrigatório e está especificado na §Configuração — i18n.
- **Ressalva 2 — `skinTone` é valor _inicial_, não controlado.** No bundle
  publicado, a prop é escrita no store uma vez (`useEffect(() => store.set({ skinTone }), [skinTone])`)
  e o `EmojiPicker.SkinToneSelector` altera o store por dentro, sem callback
  para fora. **Não existe `onSkinToneChange`.** Persistir a escolha do usuário
  exige um componente filho que leia `useSkinTone()` de dentro do `Root` — ver
  §Configuração — Skin tone. Sem isso a preferência simplesmente não persiste,
  e o bug é silencioso.
- **Ressalva 3 — o objeto de `onEmojiSelect` é `{ emoji, label }` e só.** Não
  vem `hexcode`, `group` nem `shortcodes`. A camada de recentes precisa
  persistir esses dois campos ela mesma (é o que a §Configuração — Recentes
  faz).

Exports públicos completos da v0.3.0: `EmojiPicker`, `useSkinTone`,
`useActiveEmoji`, os tipos `Emoji`/`Locale`/`SkinTone`/`Category` e os
`*Props` de cada parte.

---

## Arquitetura

### Visão geral

```
src/lib/emoji/                     ← REGRA DE NEGÓCIO (pura, testada, sem React)
  insert-at-cursor.ts              inserção de texto na posição do cursor
  insert-at-cursor.test.ts
  locale.ts                        AppLocale → Locale do Frimousse (+ fallback)
  locale.test.ts
  preferences.ts                   leitura/escrita do tom de pele
  preferences.test.ts
  recents.ts                       lista MRU de emojis recentes
  recents.test.ts
  storage.ts                       interface mínima de Storage (injeção)

src/hooks/
  use-emoji-preferences.ts         casca React fina sobre lib/emoji (estado + efeito)

src/components/ui/
  emoji-picker.tsx                 <EmojiPickerPopover> — GENÉRICO, reutilizável
  emoji-picker-panel.tsx           conteúdo do popover (carregado sob demanda)

src/components/inbox/
  message-composer.tsx             ÚNICO arquivo do inbox alterado

public/emojibase/{en,pt}/          dados da Emojibase auto-hospedados
scripts/sync-emojibase.mjs         regenera a pasta acima a partir do node_modules
messages/{en,pt-BR}.json           namespace novo "EmojiPicker"
next.config.ts                     regra de Cache-Control para /emojibase/*
src/middleware.ts                  exclusão de /emojibase do matcher
.prettierignore                    public/emojibase
```

O princípio de fronteira do projeto (`AGENTS.md` → "Lógica de negócio vive em
`src/lib/`") é o que decide o recorte: **nada em `src/lib/emoji/` importa
React nem toca em `window`**. As quatro regras que podem quebrar de forma
sutil (aritmética de cursor, fallback de locale, ordenação MRU, tolerância a
blob corrompido no storage) ficam do lado testável; a casca React só liga os
fios.

Isso não é preciosismo de arquitetura — é o que torna o plano de testes
executável. O Vitest deste repositório roda em `environment: 'node'`
(`vitest.config.ts`), **sem jsdom e sem `@testing-library/react`**. Uma
função pura que recebe um `Storage` injetado é testável hoje; uma que chama
`localStorage` direto não é.

### O fluxo de uma inserção

```
[agente clica 😀]
   │
   ▼
EmojiPicker.Root.onEmojiSelect({ emoji: "😀", label: "rosto sorridente" })
   │
   ├─► recents.push(storage, userId, { emoji, label })   ← src/lib/emoji/recents.ts
   │
   ▼
onSelect(emoji) no <EmojiPickerPopover>  (contrato genérico do componente)
   │
   ▼
message-composer.tsx: handleInsertEmoji
   │
   ├─ lê { value, selectionStart, selectionEnd } do textareaRef
   ├─► insertAtCursor(sel, "😀")  →  { value: "Olá 😀 tudo bem", caret: 6 }
   ├─ setText(result.value)
   ├─ caretRef.current = result.caret
   │
   ▼ requestAnimationFrame (depois do flush do React)
   ├─ adjustHeight()
   └─ textarea.setSelectionRange(caret, caret)   ← SEM .focus(): ver abaixo
```

**Por que `requestAnimationFrame`:** o `<textarea>` é controlado
(`value={text}`). Ao trocar o `value`, o navegador reposiciona o cursor no
fim do conteúdo. Restaurar a seleção só funciona **depois** que o React
aplicou o novo `value` no DOM. Este é exatamente o padrão que
`handlePickQuickReply` e `handleDraft` já usam no arquivo (linhas ~331 e
~416) — a nova função segue o mesmo desenho, e não inventa outro.

**Por que NÃO chamar `.focus()` a cada inserção:** o popover fica aberto para
inserções múltiplas (comportamento do WhatsApp Web — o agente escolhe 😀 e
depois 👍 sem reabrir). Devolver o foco ao textarea a cada clique fecharia o
popover pelo próprio mecanismo de foco do Base UI. `setSelectionRange()`
funciona em elemento sem foco em todos os navegadores-alvo, então a
contabilidade do cursor continua correta; o foco volta ao textarea **uma
vez**, no fechamento, via a prop `finalFocus` do `Popover.Popup` do Base UI.

### Ponto de integração exato no composer

Arquivo: `src/components/inbox/message-composer.tsx`.

O bloco de botões (a partir da linha ~732) é um flex com `order-1..order-6`
que reordena os irmãos abaixo de `xl` sem duplicar JSX. O gatilho de emoji
entra **entre o menu `+` e o botão de templates**, e os `order` seguintes
sobem um:

| Elemento              | `order` hoje | `order` depois |
| --------------------- | ------------ | -------------- |
| Menu de anexo (clipe) | 1            | 1              |
| Menu `+`              | 2            | 2              |
| **Gatilho de emoji**  | —            | **3**          |
| Templates             | 3            | 4              |
| Rascunho por IA (✨)  | 4            | 5              |
| Botão enviar          | 5            | 6              |
| `<textarea>`          | 6            | 7              |

Estado de desabilitação: **`disabled={inputsDisabled}`** (linha 235:
`readOnly || sessionExpired`), com o mesmo `title` condicional dos dois
`DropdownMenuTrigger` vizinhos. Racional:

- `readOnly` (papel sem permissão de envio) — inserir texto num campo que
  nunca vai enviar é UI que "erra ao clicar".
- `sessionExpired` (janela de 24 h fechada) — o campo livre já está
  desabilitado; só template sai. Não faz sentido abrir o picker.

O gatilho **não** usa `GatedButton` — segue o padrão dos
`DropdownMenuTrigger` irmãos (`disabled` + `title`), porque `GatedButton` é
para ações que _enviam_ e precisam do tooltip de papel; aqui a mensagem de
papel já vem pelo `title` e pelo placeholder do textarea.

O gatilho **é sempre renderizado** — não há `can(channelType, ...)` a
consultar: emoji é texto Unicode, todo canal (Cloud API e Evolution/QR
Code) aceita.

### Popover

Reuso obrigatório de `src/components/ui/popover.tsx` — o wrapper do projeto
sobre `@base-ui/react/popover`. **Nenhuma segunda biblioteca de popover
entra.** Dois ajustes de classe são necessários, porque o `PopoverContent`
padrão do projeto assume conteúdo de formulário:

```tsx
// padrão do projeto: w-72 flex flex-col gap-2.5 p-2.5
<PopoverContent
  align="start"
  side="top"
  sideOffset={8}
  className="w-auto gap-0 p-0"   // o picker traz o próprio padding e largura
  initialFocus={searchRef}        // foco no campo de busca, não no popup
  finalFocus={textareaRef}        // foco volta ao textarea ao fechar
>
```

`initialFocus` e `finalFocus` são props do `Popover.Popup` do Base UI e
**passam direto** pelo `...props` do wrapper — não é preciso alterar
`popover.tsx`. `side="top"` porque o composer fica no rodapé da tela.

### Reuso fora do inbox

`<EmojiPickerPopover>` mora em `src/components/ui/` e **não sabe o que é uma
conversa**. Contrato:

```tsx
interface EmojiPickerPopoverProps {
  /** Gatilho — normalmente um botão de ícone. Recebe os handlers do popover. */
  children: React.ReactNode;
  /** Chamado a cada emoji escolhido. O popover NÃO fecha sozinho. */
  onSelect: (emoji: Emoji) => void;
  /** Para onde o foco volta ao fechar — o campo de texto que recebe o emoji. */
  finalFocus?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  disabled?: boolean;
}
```

Plugar no personalizar de disparos ou no editor de respostas rápidas passa a
ser: renderizar o gatilho, apontar `finalFocus` para o campo e chamar
`insertAtCursor` no `onSelect`. Zero lógica duplicada.

### Fases de implementação

| Fase   | Entrega                                                                                                     | Arquivos                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **F1** | Dependências + dados auto-hospedados + script de sync + ajustes de `next.config.ts`/`middleware.ts`/ignores | `package.json`, `scripts/sync-emojibase.mjs`, `public/emojibase/**`, 3 configs    |
| **F2** | Camada pura `src/lib/emoji/` (4 módulos) + suíte Vitest co-locada                                           | `src/lib/emoji/*.ts`, `*.test.ts`                                                 |
| **F3** | Chaves i18n no namespace `EmojiPicker` (en + pt-BR)                                                         | `messages/en.json`, `messages/pt-BR.json`                                         |
| **F4** | `<EmojiPickerPanel>` + `<EmojiPickerPopover>` genéricos, com lazy-load                                      | `src/components/ui/emoji-picker*.tsx`                                             |
| **F5** | Integração no composer do inbox (gatilho, `order`, inserção no cursor)                                      | `src/components/inbox/message-composer.tsx`, `src/hooks/use-emoji-preferences.ts` |
| **F6** | Teste manual em navegador (checklist da §Boas Práticas) + gate local completo                               | —                                                                                 |

F1 a F4 não têm efeito visível: dá para parar em qualquer uma delas sem
deixar a aplicação num estado quebrado. F5 é a única que acende o recurso.

---

## Instalação

### Dependências

```bash
npm install frimousse@^0.3.0
npm install --save-dev emojibase-data@^17
```

- `frimousse` vai em **`dependencies`** — é código de runtime do cliente.
- `emojibase-data` vai em **`devDependencies`** — é a _fonte_ dos JSONs que o
  script de sync copia para `public/`. Nada dela é importado pelo app; deixá-la
  em `dependencies` daria a impressão errada de que o bundle a inclui.

### Por que não usar o CLI do shadcn

O Frimousse publica um registro shadcn
(`npx shadcn@latest add https://frimousse.liveblocks.io/r/emoji-picker`) que
gera um componente já estilizado com as variáveis do tema. **Não vamos usá-lo**,
por três motivos concretos deste repositório:

1. O componente do registro é escrito contra o Radix/Tailwind padrão do
   shadcn. Este projeto usa **`@base-ui/react`** nos primitivos (`popover.tsx`,
   `dropdown-menu.tsx` — inclusive com uma armadilha já documentada em
   `dropdown-menu-group-label.test.tsx`), então o arquivo gerado teria que ser
   reescrito de qualquer forma.
2. O CLI escreveria em `src/components/ui/` sem passar pelo Prettier/ESLint do
   projeto e sem os comentários em português que o restante da pasta mantém.
3. Precisamos de partes que o registro não tem (faixa de recentes, persistência
   de tom de pele, `emojibaseUrl` apontando para o self-host).

Usamos os primitivos crus (`import { EmojiPicker } from 'frimousse'`) e
escrevemos o wrapper — é menos código do que adaptar o gerado.

### Dados da Emojibase auto-hospedados

`scripts/sync-emojibase.mjs` — copia do `node_modules` para `public/`:

```js
// Copia os dados da Emojibase para public/emojibase/, de onde o Frimousse
// os busca em runtime (prop `emojibaseUrl`). Rode depois de atualizar a
// dependência `emojibase-data`:
//
//   npm run emoji:sync
//
// Os arquivos resultantes SÃO commitados de propósito — ver a justificativa
// em docs/spec-066-emoji-picker-inbox.md § Configuração — Fonte dos dados.
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'emojibase-data');
const dest = join(root, 'public', 'emojibase');

// Um locale da Emojibase por locale do app (ver src/lib/emoji/locale.ts).
// Adicionar um idioma ao app = adicionar o locale Emojibase equivalente aqui,
// senão o picker cai no inglês em silêncio.
const LOCALES = ['en', 'pt'];
const FILES = ['data.json', 'messages.json'];

for (const locale of LOCALES) {
  mkdirSync(join(dest, locale), { recursive: true });
  for (const file of FILES) {
    copyFileSync(join(src, locale, file), join(dest, locale, file));
  }
}
// A MIT exige preservar o aviso de copyright ao redistribuir os dados.
copyFileSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));

console.log(
  `emojibase: ${LOCALES.length} locale(s) sincronizado(s) em ${dest}`
);
```

Script em `package.json`:

```json
"emoji:sync": "node scripts/sync-emojibase.mjs"
```

Só esses **dois** arquivos por locale. O Frimousse busca exatamente
`${emojibaseUrl}/${locale}/data.json` e `${emojibaseUrl}/${locale}/messages.json`
— confirmado no bundle publicado:

```js
var we = (e, t) => `${e}/${t}/data.json`,
  ye = (e, t) => `${e}/${t}/messages.json`;
```

Nada de `compact.json`, `shortcodes/**` ou `*.d.ts` — copiar a pasta inteira
levaria mais de 10 MB de arquivos que ninguém lê.

Tamanhos reais (`emojibase-data@17.0.0`, medidos via API do jsDelivr):

| Arquivo             | Bytes        |
| ------------------- | ------------ |
| `en/data.json`      | 775.157      |
| `en/messages.json`  | 6.499        |
| `pt/data.json`      | 786.877      |
| `pt/messages.json`  | 6.736        |
| **Total commitado** | **~1,57 MB** |

### Ajustes de configuração exigidos pelo self-host

Três arquivos precisam saber que `/emojibase/**` existe. **Nenhum é
opcional** — sem eles o recurso funciona, mas de forma degradada e difícil de
diagnosticar.

**1. `.prettierignore`** — sem isto, `npm run format:check` tenta formatar
1,5 MB de JSON gerado e o `npm run format` reescreve os arquivos (que então
divergem do `node_modules` na próxima comparação). Entra na seção que já
existe:

```
# Gerado / vendorizado
supabase/migrations
public/opus
public/emojibase
```

**2. `src/middleware.ts`** — o matcher atual só exclui extensões de imagem:

```
'/((?!_next/static|_next/image|favicon.ico|api/whatsapp/webhook(?:/|$)|api/channels/evolution/webhook(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
```

Um `.json` em `public/` **passa pelo middleware** e paga um refresh de sessão
do Supabase a cada requisição de 780 KB. Adicione `emojibase(?:/|$)` à lista,
seguindo a convenção `(?:/|$)` que o próprio arquivo documenta (exclusão por
prefixo puro pegaria rotas futuras que só _comecem_ com o mesmo texto):

```
'/((?!_next/static|_next/image|favicon.ico|emojibase(?:/|$)|api/whatsapp/webhook(?:/|$)|api/channels/evolution/webhook(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
```

**3. `next.config.ts`** — a regra catch-all de cache aplica `s-maxage=300` a
tudo que não seja `_next/static`/`_next/image`/`api`. Dados de emoji
versionados pela dependência são imutáveis; revalidar a cada 5 minutos é
desperdício puro. Duas edições:

```ts
// (a) tirar /emojibase da catch-all — o Next mescla os headers de TODAS as
//     regras que casam, e dois Cache-Control na mesma resposta é ambíguo
{
  source: '/:path((?!_next/static|_next/image|api|emojibase).*)',
  headers: [{ key: 'Cache-Control', value: 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' }],
},
// (b) regra própria, antes da catch-all de segurança
{
  // Dados da Emojibase: o conteúdo é fixo por versão da dependência
  // (npm run emoji:sync). Um upgrade troca os bytes E o deploy, então
  // cache imutável é seguro e evita revalidar ~780 KB a cada 5 min.
  source: '/emojibase/:path*',
  headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
},
```

> ⚠️ **Armadilha:** `immutable` + arquivo com nome fixo significa que um
> `emoji:sync` que troque o conteúdo sem trocar o caminho pode servir dados
> velhos a quem já visitou. Na prática isso só acontece num upgrade de major
> da `emojibase-data`, é cosmético (emoji novo demora a aparecer) e se
> resolve num hard-refresh. Se algum dia isso incomodar, o caminho é
> versionar a pasta (`/emojibase/17/pt/data.json`) — não vale a complexidade
> hoje.

---

## Configuração

### Fonte dos dados de emoji: CDN (jsDelivr) vs. self-host

Esta é a decisão de maior consequência da SPEC, porque afeta CSP, deploys
offline e a postura de terceiros que fazem fork do produto.

| Critério                 | CDN padrão (jsDelivr)                                                                                  | Self-host em `public/emojibase/`                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Bundle JS inicial**    | **Zero** — JSON é buscado em runtime                                                                   | **Zero** — idem. _Nenhuma_ das opções entra no bundle                                |
| **Peso do repo/deploy**  | 0                                                                                                      | +1,57 MB de arquivos estáticos                                                       |
| **Latência 1ª abertura** | jsDelivr tem PoP no Brasil; mas custa DNS + TLS handshake com origem nova                              | Mesma origem, conexão HTTP/2 já aberta, brotli do host — normalmente **mais rápido** |
| **Aberturas seguintes**  | Idênticas: o Frimousse cacheia em `localStorage` sob `frimousse/data/{locale}` com validação por ETag  | Idênticas                                                                            |
| **CSP**                  | Exige abrir `connect-src https://cdn.jsdelivr.net` — furo permanente numa política que hoje é `'self'` | **Nenhuma mudança de CSP**                                                           |
| **Rede restrita**        | Proxy corporativo que bloqueia CDN público ⇒ picker gira para sempre                                   | Funciona                                                                             |
| **Deploy on-premise**    | Exige internet de saída no navegador do atendente                                                      | Funciona em intranet fechada                                                         |
| **Cadeia de suprimento** | Terceiro serve JSON adjacente ao seu app, fora do `package-lock.json`                                  | Versão fixada no lock, revisada como qualquer dependência                            |
| **Manutenção**           | Nenhuma                                                                                                | `npm run emoji:sync` a cada upgrade + lembrar de adicionar locale novo               |

**Recomendação: self-host.** A justificativa específica para o contexto de
PMEs brasileiras usando o ZAP CRM BR:

1. **O produto é auto-hospedável e instalado por terceiros.** O atendente
   típico está num desktop de escritório atrás de proxy/filtro de conteúdo —
   `cdn.jsdelivr.net` é exatamente o tipo de domínio que uma política de TI
   bloqueia por "CDN não classificada". O modo de falha é péssimo: o botão
   abre, o spinner nunca some, ninguém consegue explicar por quê, e o suporte
   recebe "o emoji não funciona" sem sinal de erro claro.
2. **O CSP deste repositório está deliberadamente em `Report-Only` para virar
   enforcing** (o comentário no `next.config.ts` diz isso com todas as
   letras: "quando tivermos confiança de que nada legítimo o dispara [...]
   trocamos a chave"). Introduzir agora uma dependência de rede a terceiro é
   remar contra esse plano — e um `connect-src` aberto para um CDN público é
   justamente a permissão que um XSS aproveitaria para exfiltrar.
3. **O custo é quase nulo.** Não é bundle JS, é arquivo estático. 1,57 MB no
   artefato de deploy, servido com brotli (~150–200 KB no fio por locale) e
   **uma vez por navegador** — depois o próprio Frimousse guarda em
   `localStorage`. Comparado com o `public/opus` que o projeto já vendoriza
   para o gravador de voz, é o mesmo tipo de troca já aceita aqui.

Configuração resultante no `EmojiPicker.Root`:

```tsx
<EmojiPicker.Root
  emojibaseUrl="/emojibase"   // caminho relativo, mesma origem
  locale={emojiLocale}
  // emojiVersion: NÃO passar. Quando `emojibaseUrl` é informada, o Frimousse
  // usa a URL literalmente (confirmado no bundle: `typeof o === "string" ? o
  // : ...`), então `emojiVersion` deixaria de influenciar a busca e passaria
  // a só restringir o filtro de suporte do navegador — pior do que a
  // autodetecção por canvas que ele já faz.
  ...
>
```

> **Se o mantenedor preferir o CDN mesmo assim** (deploy exclusivamente em
> nuvem pública, prioridade em manter o repo enxuto): omita `emojibaseUrl`,
> pule o script de sync e os três ajustes de configuração da §Instalação, e
> aplique **apenas** a mudança de CSP descrita na §Segurança. Todo o resto
> desta SPEC vale sem alteração — a decisão é um parâmetro, não uma
> arquitetura.

### i18n — mapeamento de locale

O app tem `SUPPORTED_LOCALES = ['pt-BR', 'en']` (`src/lib/i18n/locales.ts`).
A Emojibase **não tem `pt-BR`** — tem `pt`, que é o CLDR de português com
variantes europeias em alguns rótulos ("telemóvel", "autocarro"). Isso afeta
**só o texto de busca e o rótulo de leitor de tela**; o emoji renderizado é
idêntico. É uma degradação aceitável e muito melhor do que cair no inglês:
um atendente brasileiro digitando "coração" acha ❤️ com o dado `pt`, e não
acha com o `en`.

`src/lib/emoji/locale.ts`:

```ts
import type { Locale as EmojiLocale } from 'frimousse';
import { type AppLocale, SUPPORTED_LOCALES } from '@/lib/i18n/locales';

/**
 * Locale do app → locale da Emojibase.
 *
 * A Emojibase não publica `pt-BR`, só `pt` (CLDR). O dado `pt` traz alguns
 * rótulos em português europeu, mas o emoji é o mesmo e a busca em
 * português funciona — infinitamente melhor do que cair no inglês.
 *
 * Este Record é `Record<AppLocale, EmojiLocale>` de propósito: adicionar um
 * idioma em SUPPORTED_LOCALES sem adicioná-lo aqui QUEBRA O TYPECHECK, em
 * vez de servir rótulos em inglês em silêncio.
 */
export const EMOJI_LOCALE_BY_APP_LOCALE: Record<AppLocale, EmojiLocale> = {
  'pt-BR': 'pt',
  en: 'en',
};

/** Fallback quando o locale ativo não é reconhecido (cookie adulterado etc.). */
export const FALLBACK_EMOJI_LOCALE: EmojiLocale = 'en';

export function toEmojiLocale(locale: string | null | undefined): EmojiLocale {
  return (
    EMOJI_LOCALE_BY_APP_LOCALE[locale as AppLocale] ?? FALLBACK_EMOJI_LOCALE
  );
}

/** Locales da Emojibase que o script de sync precisa copiar. */
export const REQUIRED_EMOJIBASE_LOCALES: readonly EmojiLocale[] = [
  ...new Set(SUPPORTED_LOCALES.map((l) => EMOJI_LOCALE_BY_APP_LOCALE[l])),
];
```

O `Record<AppLocale, …>` tipado é o ponto principal: `useLocale() === 'pt-BR' ? 'pt' : 'en'`
escrito inline no componente pareceria idêntico e falharia em silêncio no dia
em que alguém adicionar `es` ao app.

`REQUIRED_EMOJIBASE_LOCALES` existe para que o `sync-emojibase.mjs` possa, se
o mantenedor quiser, derivar a lista em vez de repetir `['en', 'pt']` — mas o
script é `.mjs` sem transpilação de TS, então o padrão é a constante
duplicada com o comentário de aviso.

**Strings que são nossas** (o Frimousse não traz nenhum texto de UI —
categorias e rótulos vêm da Emojibase). Namespace novo de topo `EmojiPicker`,
não `Inbox.composer.*`, porque o componente é reutilizável fora do inbox:

`messages/en.json` (fonte da verdade):

```json
"EmojiPicker": {
  "trigger": "Insert emoji",
  "searchPlaceholder": "Search emoji…",
  "loading": "Loading emoji…",
  "empty": "No emoji found",
  "skinTone": "Skin tone",
  "recents": "Frequently used",
  "clearRecents": "Clear recently used"
}
```

`messages/pt-BR.json` (mesma árvore, só os valores traduzidos):

```json
"EmojiPicker": {
  "trigger": "Inserir emoji",
  "searchPlaceholder": "Buscar emoji…",
  "loading": "Carregando emojis…",
  "empty": "Nenhum emoji encontrado",
  "skinTone": "Tom de pele",
  "recents": "Usados com frequência",
  "clearRecents": "Limpar usados recentemente"
}
```

Sem placeholders ICU em nenhuma delas — nada de `{count}` para o
`INVALID_MESSAGE` das armadilhas conhecidas morder. `npm run i18n:check`
falha se um dos dois dicionários ficar para trás.

### Skin tone — onde persistir

| Opção                              | A favor                                                                                                                                                     | Contra                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`localStorage`** _(recomendado)_ | Zero migração; leitura síncrona antes do 1º render (sem "flash" de tom errado); nenhuma superfície de RLS; precedente direto no `use-theme.tsx`/`themes.ts` | Escopo de dispositivo — o agente reescolhe uma vez em cada máquina; some ao limpar o cache do navegador                                                                                                                                               |
| Coluna em `profiles` (Supabase)    | Segue o usuário entre dispositivos                                                                                                                          | Exige migração em **dois** projetos Supabase (`vn` e `rs`), cada uma com confirmação explícita do mantenedor; um round-trip antes do 1º render (ou flash); um `UPDATE` por troca de tom; revisão de política RLS — tudo por uma preferência cosmética |

**Decisão: `localStorage`.** A regra prática do repositório é que migração se
paga quando o dado precisa ser lido pelo servidor, auditado ou compartilhado.
Tom de pele não é nenhum dos três. Se algum dia existir uma coluna genérica
`profiles.ui_preferences jsonb` (para tema, densidade, idioma do picker,
etc.), este valor migra para lá numa linha — e o `localStorage` continua
servindo como cache local. Não construir isso agora.

Chave: **`zapcrm:emoji:skin-tone:{userId}`**. O sufixo com o `id` do usuário
autenticado (`useAuth()`) importa porque em PME é comum a mesma estação ser
usada por dois atendentes com logins diferentes — sem o sufixo, um herdaria a
preferência do outro.

`src/lib/emoji/preferences.ts`:

```ts
import type { SkinTone } from 'frimousse';
import type { KeyValueStorage } from './storage';

export const DEFAULT_SKIN_TONE: SkinTone = 'none';

const SKIN_TONES: readonly SkinTone[] = [
  'none',
  'light',
  'medium-light',
  'medium',
  'medium-dark',
  'dark',
];

export function skinToneKey(userId: string): string {
  return `zapcrm:emoji:skin-tone:${userId}`;
}

export function isSkinTone(value: unknown): value is SkinTone {
  return (
    typeof value === 'string' &&
    (SKIN_TONES as readonly string[]).includes(value)
  );
}

/** Nunca lança: storage indisponível ou valor inválido caem no default. */
export function readSkinTone(
  storage: KeyValueStorage | null,
  userId: string
): SkinTone {
  try {
    const raw = storage?.getItem(skinToneKey(userId));
    return isSkinTone(raw) ? raw : DEFAULT_SKIN_TONE;
  } catch {
    return DEFAULT_SKIN_TONE;
  }
}

/** Nunca lança: Safari em janela privada estoura a cota no setItem. */
export function writeSkinTone(
  storage: KeyValueStorage | null,
  userId: string,
  tone: SkinTone
): void {
  try {
    storage?.setItem(skinToneKey(userId), tone);
  } catch {
    /* preferência é best-effort — perder não pode derrubar o composer */
  }
}
```

`src/lib/emoji/storage.ts` — a interface injetada que torna tudo isso testável
no Vitest em `environment: 'node'` (onde **não existe** `localStorage`):

```ts
/** Subconjunto de `Storage` que a camada de emoji usa. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `null` no servidor e durante o primeiro render de hidratação. */
export function browserStorage(): KeyValueStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}
```

**A armadilha do `skinTone` (repetindo, porque custa caro esquecer):** passar
`skinTone={tone}` no `Root` só define o valor _inicial_. O
`EmojiPicker.SkinToneSelector` altera o store interno e **não avisa ninguém**.
Para persistir é preciso um filho dentro do `Root`:

```tsx
/**
 * Sem isto a escolha de tom de pele volta ao padrão a cada abertura.
 *
 * `skinTone` no Root é valor INICIAL (o Frimousse escreve no store uma vez,
 * num efeito com `[skinTone]` na lista de dependências) e a v0.3.0 não expõe
 * `onSkinToneChange`. `useSkinTone()` lê o store de dentro do contexto — é o
 * único caminho para observar o que o SkinToneSelector fez.
 */
function PersistSkinTone({ userId }: { userId: string }) {
  const [tone] = useSkinTone();
  useEffect(() => {
    writeSkinTone(browserStorage(), userId, tone);
  }, [tone, userId]);
  return null;
}
```

### Emojis recentes — projeto da camada

O Frimousse não tem "frequentes/recentes". **Construir**, e não descartar: no
uso real de atendimento, uma minoria pequena de emojis cobre a esmagadora
maioria dos envios (👍 ✅ 😊 🙏 📎 ⏰), e a diferença entre um clique e
"abrir + rolar/buscar + clicar" se multiplica por centenas de mensagens por
dia. É o item desta SPEC com maior retorno por linha de código.

**Onde a lógica mora:** `src/lib/emoji/recents.ts` — puro, sem React, com
storage injetado. As regras que podem quebrar de forma sutil são exatamente
as que precisam de teste: ordenação MRU, deduplicação, teto da lista,
tolerância a blob corrompido, isolamento por usuário. O hook
(`src/hooks/use-emoji-preferences.ts`) é casca fina: `useState` + `useEffect`
que chama a lib. Isso respeita a convenção do `AGENTS.md` e é o mesmo recorte
que `use-deal-draft.ts` já usa no inbox.

**Por que não no Supabase:** seriam duas migrações (vn + rs) e uma escrita de
rede _a cada emoji clicado_ — a operação mais frequente do recurso. Um dado
de conveniência, por dispositivo, cabe em `localStorage`.

**Modelo:**

```ts
import type { Emoji } from 'frimousse';
import type { KeyValueStorage } from './storage';

/** Quantos guardar. 16 = duas fileiras de 8 na largura do popover. */
export const MAX_RECENTS = 16;

/** Versão do formato. Blob de versão diferente é DESCARTADO, não migrado. */
const SCHEMA_VERSION = 1;

export interface RecentEmoji {
  /** O caractere JÁ com o tom de pele aplicado, como veio do onEmojiSelect. */
  emoji: string;
  /** Rótulo da Emojibase — usado como aria-label na faixa de recentes. */
  label: string;
  /** Epoch ms do último uso. Só para ordenar; não é exibido. */
  usedAt: number;
}

export function recentsKey(userId: string): string {
  return `zapcrm:emoji:recents:${userId}`;
}

export function readRecents(
  storage: KeyValueStorage | null,
  userId: string
): RecentEmoji[];

export function pushRecent(
  storage: KeyValueStorage | null,
  userId: string,
  emoji: Emoji,
  now?: number
): RecentEmoji[];

export function clearRecents(
  storage: KeyValueStorage | null,
  userId: string
): void;
```

Regras (cada uma vira um caso de teste):

1. `readRecents` devolve `[]` — nunca lança — para: chave ausente, JSON
   inválido, `version` diferente de `SCHEMA_VERSION`, `items` que não é
   array, storage `null` (servidor), `getItem` que estoura.
2. Entradas malformadas dentro de um array válido são **filtradas**, não
   invalidam a lista inteira (`emoji` e `label` precisam ser strings não
   vazias, `usedAt` precisa ser número finito).
3. `pushRecent` dedupa **pela string `emoji`** — que já carrega o tom de pele,
   então 👍 e 👍🏽 são entradas distintas de propósito: são caracteres
   diferentes e o agente escolheu cada um.
4. Ordem MRU: remove a ocorrência anterior, insere no início, corta em
   `MAX_RECENTS`.
5. `pushRecent` devolve a lista nova para o hook atualizar o estado sem
   reler o storage.
6. `now` é parâmetro injetável (default `Date.now()`) para que o teste de
   ordenação não dependa de relógio.
7. `usedAt` é gravado mas **não** define a ordem na leitura — a ordem é a do
   array. Guardar o timestamp permite uma futura política de expiração sem
   trocar o schema.

**UI:** a faixa de recentes é renderizada por **nós**, acima de
`EmojiPicker.Search`, e **não** dentro de `EmojiPicker.List` — a lista do
Frimousse é virtualizada e monta o próprio conteúdo a partir do dado da
Emojibase; não há ponto de extensão para injetar uma categoria. Uma linha de
até 16 botões não precisa de virtualização.

Quando a lista está vazia (usuário novo), a faixa **não é renderizada** —
sem estado vazio, sem cabeçalho órfão.

---

## Uso

### `src/lib/emoji/insert-at-cursor.ts`

```ts
/** Estado do campo no momento da inserção. */
export interface CursorSelection {
  value: string;
  /** `null` quando o campo nunca recebeu foco — trata-se como fim do texto. */
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface InsertResult {
  value: string;
  /** Onde deixar o cursor: logo depois do texto inserido. */
  caret: number;
}

/**
 * Insere `insert` na posição do cursor, substituindo a seleção se houver.
 *
 * Índices são clampados em [0, value.length] — um `selectionStart` obsoleto
 * (o textarea encolheu depois que o popover abriu) não pode produzir string
 * com `undefined` no meio.
 *
 * `caret` usa `insert.length` (unidades UTF-16), não a contagem de "pontos
 * de código percebidos": um emoji com ZWJ como 👨‍👩‍👧 ocupa 8 unidades, e
 * `setSelectionRange` fala em UTF-16 — usar contagem de grafemas deixaria o
 * cursor no meio da sequência.
 */
export function insertAtCursor(
  selection: CursorSelection,
  insert: string
): InsertResult {
  const { value } = selection;
  const end = clamp(selection.selectionEnd ?? value.length, 0, value.length);
  const start = clamp(selection.selectionStart ?? end, 0, end);

  return {
    value: value.slice(0, start) + insert + value.slice(end),
    caret: start + insert.length,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : max;
}
```

Note a diferença deliberada em relação a `handlePickQuickReply`, que **anexa
ao fim** com quebra de linha. Emoji é pontuação de frase: precisa cair onde o
cursor está, sem separador. São contratos diferentes de propósito — não
unifique as duas funções.

### `src/components/ui/emoji-picker-panel.tsx`

Conteúdo do popover. Fica em arquivo próprio **porque é o alvo do
`next/dynamic`** — separar o painel do gatilho é o que mantém o Frimousse
fora do chunk inicial do inbox.

```tsx
'use client';

import { EmojiPicker, useSkinTone, type Emoji } from 'frimousse';
import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { toEmojiLocale } from '@/lib/emoji/locale';
import { browserStorage } from '@/lib/emoji/storage';
import { readSkinTone, writeSkinTone } from '@/lib/emoji/preferences';
import type { RecentEmoji } from '@/lib/emoji/recents';

interface EmojiPickerPanelProps {
  onSelect: (emoji: Emoji) => void;
  recents: RecentEmoji[];
  userId: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

export default function EmojiPickerPanel({
  onSelect,
  recents,
  userId,
  searchRef,
}: EmojiPickerPanelProps) {
  const t = useTranslations('EmojiPicker');
  const emojiLocale = toEmojiLocale(useLocale());
  // Leitura síncrona: o valor precisa existir no PRIMEIRO render, porque o
  // Frimousse só lê `skinTone` como valor inicial (ver § Configuração).
  const initialSkinTone = readSkinTone(browserStorage(), userId);

  return (
    <EmojiPicker.Root
      locale={emojiLocale}
      emojibaseUrl="/emojibase"
      skinTone={initialSkinTone}
      columns={8}
      onEmojiSelect={onSelect}
      className="bg-popover isolate flex h-[368px] w-[352px] flex-col"
    >
      <PersistSkinTone userId={userId} />

      {recents.length > 0 && (
        <div
          role="group"
          aria-label={t('recents')}
          className="border-border flex flex-wrap gap-0.5 border-b p-2"
        >
          {recents.map((r) => (
            <button
              key={r.emoji}
              type="button"
              aria-label={r.label}
              title={r.label}
              onClick={() => onSelect({ emoji: r.emoji, label: r.label })}
              className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md text-lg"
            >
              {r.emoji}
            </button>
          ))}
        </div>
      )}

      <EmojiPicker.Search
        ref={searchRef}
        placeholder={t('searchPlaceholder')}
        className="border-border bg-muted text-foreground placeholder-muted-foreground m-2 rounded-md border px-2.5 py-1.5 text-sm outline-none"
      />

      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t('loading')}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t('empty')}
        </EmojiPicker.Empty>
        <EmojiPicker.List className="pb-1.5 select-none" />
      </EmojiPicker.Viewport>

      <div className="border-border flex items-center gap-2 border-t p-2">
        <EmojiPicker.SkinToneSelector aria-label={t('skinTone')} />
      </div>
    </EmojiPicker.Root>
  );
}

function PersistSkinTone({ userId }: { userId: string }) {
  const [tone] = useSkinTone();
  useEffect(() => {
    writeSkinTone(browserStorage(), userId, tone);
  }, [tone, userId]);
  return null;
}
```

`export default` é intencional: é o formato que `next/dynamic` consome sem
wrapper.

### `src/components/ui/emoji-picker.tsx`

O componente reutilizável — é ele que outros módulos vão importar.

```tsx
'use client';

import dynamic from 'next/dynamic';
import { useCallback, useRef, useState } from 'react';
import type { Emoji } from 'frimousse';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useEmojiRecents } from '@/hooks/use-emoji-preferences';

// Carregado só na primeira abertura. `ssr: false` porque o picker lê
// localStorage e mede o viewport — renderizar no servidor não produz nada
// aproveitável e ainda arrisca divergência de hidratação.
const EmojiPickerPanel = dynamic(() => import('./emoji-picker-panel'), {
  ssr: false,
});

export interface EmojiPickerPopoverProps {
  children: React.ReactNode;
  onSelect: (emoji: Emoji) => void;
  /** Campo que recebe o foco quando o popover fecha. */
  finalFocus?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

export function EmojiPickerPopover({
  children,
  onSelect,
  finalFocus,
  side = 'top',
  align = 'start',
}: EmojiPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { recents, remember, userId } = useEmojiRecents();

  const handleSelect = useCallback(
    (emoji: Emoji) => {
      remember(emoji);
      onSelect(emoji);
      // O popover NÃO fecha: inserção múltipla é o comportamento esperado
      // (WhatsApp Web). Esc, clique fora e o próprio gatilho fecham.
    },
    [remember, onSelect]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={children}
        // Baixa o chunk do painel antes do clique — o hover/foco costuma
        // preceder o clique em ~200 ms, o suficiente para o painel abrir
        // já montado.
        onPointerEnter={() => void import('./emoji-picker-panel')}
        onFocus={() => void import('./emoji-picker-panel')}
      />
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-auto gap-0 overflow-hidden p-0"
        initialFocus={searchRef}
        finalFocus={finalFocus}
      >
        {open && (
          <EmojiPickerPanel
            onSelect={handleSelect}
            recents={recents}
            userId={userId}
            searchRef={searchRef}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
```

> **Verificar na implementação:** o `PopoverTrigger` do projeto repassa
> `PopoverPrimitive.Trigger.Props`. No Base UI a composição com um elemento
> próprio é pela prop `render`. Se a versão instalada de `@base-ui/react`
> divergir, a alternativa é passar o botão como `children` — o padrão usado
> em `dropdown-menu.tsx` neste repositório, que estiliza o próprio
> `DropdownMenuTrigger` em vez de compor. Siga o que os componentes vizinhos
> já fazem; não introduza um terceiro padrão.

---

## Exemplos

### Integração no composer do inbox (`message-composer.tsx`)

**1. Imports e refs** (junto dos existentes):

```tsx
import { Smile } from 'lucide-react';
import type { Emoji } from 'frimousse';
import { EmojiPickerPopover } from '@/components/ui/emoji-picker';
import { insertAtCursor } from '@/lib/emoji/insert-at-cursor';
```

**2. Handler** (ao lado de `handlePickQuickReply`, seguindo o mesmo desenho):

```tsx
// Insere na POSIÇÃO DO CURSOR — diferente de `handlePickQuickReply`, que
// anexa ao fim com quebra de linha. Emoji é pontuação de frase; snippet é
// parágrafo. Os dois contratos são diferentes de propósito.
const handleInsertEmoji = useCallback(
  (picked: Emoji) => {
    const el = textareaRef.current;
    const next = insertAtCursor(
      {
        value: text,
        selectionStart: el?.selectionStart ?? null,
        selectionEnd: el?.selectionEnd ?? null,
      },
      picked.emoji
    );
    setText(next.value);
    // O textarea é controlado: trocar `value` joga o cursor para o fim.
    // Restaurar só funciona depois do flush do React — mesmo rAF que
    // `handleDraft`/`handlePickQuickReply` usam.
    //
    // Sem `.focus()` de propósito: o popover fica aberto para inserção
    // múltipla, e devolver o foco aqui o fecharia. `setSelectionRange`
    // funciona em elemento sem foco; o foco volta uma vez no fechamento,
    // via `finalFocus`.
    requestAnimationFrame(() => {
      adjustHeight();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  },
  [text, adjustHeight]
);
```

**3. Gatilho no JSX** — entre o `DropdownMenu` do `+` (order-2) e o bloco de
templates (que passa a `order-4`):

```tsx
{
  /* Emoji. Sem gate de canal: emoji é texto Unicode, todo canal aceita.
     Desabilitado com `inputsDisabled` (readOnly || sessionExpired) pelo
     mesmo motivo dos menus vizinhos — inserir num campo que não envia é
     UI que erra ao clicar. */
}
<EmojiPickerPopover
  onSelect={handleInsertEmoji}
  finalFocus={textareaRef}
  side="top"
  align="start"
>
  <button
    type="button"
    disabled={inputsDisabled}
    aria-label={tEmoji('trigger')}
    title={
      readOnly
        ? t('readOnlyTitle')
        : inputsDisabled
          ? undefined
          : tEmoji('trigger')
    }
    className="text-muted-foreground hover:text-foreground order-3 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50 xl:order-none"
  >
    <Smile className="h-4 w-4" />
  </button>
</EmojiPickerPopover>;
```

Com `const tEmoji = useTranslations('EmojiPicker');` declarado junto do `t`
existente. **Não** reaproveite o nome `t` — o arquivo já tem histórico de
shadowing de `useTranslations` na lista de armadilhas do `AGENTS.md`.

**4. Renumerar os `order`** de templates (3→4), IA (4→5), enviar (5→6) e
textarea (6→7). Passo mecânico, mas esquecê-lo faz o layout abaixo de 1280 px
embaralhar sem erro de build.

### Reuso futuro — personalizar de disparo

O que a segunda integração custa, dado tudo acima:

```tsx
const bodyRef = useRef<HTMLTextAreaElement>(null);
const [body, setBody] = useState('');

<EmojiPickerPopover
  onSelect={(e) => {
    const next = insertAtCursor(
      {
        value: body,
        selectionStart: bodyRef.current?.selectionStart ?? null,
        selectionEnd: bodyRef.current?.selectionEnd ?? null,
      },
      e.emoji
    );
    setBody(next.value);
    requestAnimationFrame(() =>
      bodyRef.current?.setSelectionRange(next.caret, next.caret)
    );
  }}
  finalFocus={bodyRef}
  side="bottom"
>
  <button type="button" aria-label={tEmoji('trigger')}>
    <Smile className="h-4 w-4" />
  </button>
</EmojiPickerPopover>;
```

Zero lógica nova, zero chave i18n nova, recentes e tom de pele compartilhados
com o inbox de graça. É esse o teste de que a estrutura ficou reutilizável.

> ⚠️ **Antes de plugar em templates da Meta**: o corpo de um template
> aprovado **não** pode ser editado, e o texto de variáveis passa por
> validação de comprimento (`src/lib/whatsapp/template-*.ts`). O picker cabe
> em campos de **texto livre** — o corpo de mensagem do inbox, notas, corpo
> de resposta rápida. Em campo de template, verifique a validação antes.

---

## Boas Práticas

### Acessibilidade e teclado

O que o Frimousse já entrega e **não** deve ser reimplementado: grade com
foco itinerante (setas ↑↓←→), `Enter` para selecionar, rótulos de leitor de
tela vindos do `messages.json` da Emojibase (em português, com o locale `pt`),
cabeçalhos de categoria anunciados, emojis não suportados pelo navegador
escondidos automaticamente (detecção por canvas).

O risco da integração está na **fronteira com o Popover do Base UI**. Pontos
a garantir e verificar:

1. **Foco inicial no campo de busca.** Sem `initialFocus`, o Base UI foca o
   `Popup` e a primeira tecla digitada não chega à busca. Use
   `initialFocus={searchRef}`.
2. **Foco final no textarea.** `finalFocus={textareaRef}` devolve o cursor ao
   rascunho ao fechar — sem isso o foco volta para o gatilho e o agente
   precisa de um `Tab` extra para continuar escrevendo.
3. **`Esc` fecha o popover, não limpa a busca.** O `EmojiPicker.Search` não
   intercepta `Escape`; confirme no teste manual.
4. **`Enter` dentro do picker não envia a mensagem.** O `handleKeyDown` de
   envio está no `onKeyDown` do `<textarea>`, e o popover renderiza num
   Portal (`PopoverPrimitive.Portal`) — o evento não borbulha pelo textarea.
   Confirme mesmo assim: um envio acidental ao escolher emoji seria o pior
   bug possível deste recurso.
5. **Nome acessível no gatilho.** Botão só de ícone precisa de `aria-label`
   (`EmojiPicker.trigger`), não só `title`.
6. **Faixa de recentes.** `role="group"` + `aria-label={t('recents')}`; cada
   botão com `aria-label={r.label}` — o caractere sozinho é lido de forma
   inconsistente por leitores de tela.
7. **Popover não-modal** (padrão do Base UI): o restante da página continua
   na árvore de acessibilidade. Não passe `modal` — o composer atrás precisa
   continuar legível.
8. **Contraste e tema.** Use exclusivamente os tokens (`bg-popover`,
   `text-foreground`, `border-border`, `hover:bg-muted`). O projeto tem tema
   claro/escuro por `data-mode` e paletas de acento — cor literal quebra num
   dos modos.

### Performance

| Preocupação                      | Mitigação                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peso no chunk inicial do inbox   | `next/dynamic(..., { ssr: false })` no **painel**, não no gatilho; `{open && <Panel/>}` garante que nem monta antes da primeira abertura                                        |
| Latência da primeira abertura    | Prefetch do chunk em `onPointerEnter`/`onFocus` do gatilho (`void import('./emoji-picker-panel')`) — o hover antecede o clique o suficiente                                     |
| Busca de ~780 KB de JSON         | Uma vez por navegador: o Frimousse cacheia em `localStorage` sob `frimousse/data/{locale}` com ETag, e revalida sem re-baixar                                                   |
| Lista longa                      | `EmojiPicker.List` já é virtualizada com re-renders mínimos — **não** envolver em `ScrollArea` própria nem em outro contêiner com altura dinâmica                               |
| Largura do popover × colunas     | `columns={8}` para o painel de 352 px. O default é 10 e estoura, gerando rolagem horizontal                                                                                     |
| Re-render em cascata do composer | `onSelect` memoizado com `useCallback`; o picker fica **não-controlado** (nada de estado de busca subindo para o composer)                                                      |
| Cota de `localStorage`           | ~780 KB por locale cacheado + recentes. Cota típica é 5 MB/origem; o app já guarda tema e rascunhos. Em cota estourada o Frimousse volta a buscar da rede (degrada, não quebra) |

Referência de tamanho: o pacote `frimousse` não tem dependências e é
`sideEffects: false` — o custo de JS é o do próprio picker, e ele fica num
chunk separado que só o inbox (e, no futuro, quem plugar o componente) baixa.

### Plano de testes (Vitest, co-locados)

**Restrição de ambiente que define o plano:** `vitest.config.ts` roda com
`environment: 'node'`, e o projeto **não tem** `jsdom` nem
`@testing-library/react`. Renderizar o picker num teste não é uma opção — e
não deveria ser: o Frimousse é testado pelo Frimousse. O valor está na camada
pura, que é justamente onde os bugs sutis moram.

O único teste `.tsx` existente (`dropdown-menu-group-label.test.tsx`) usa
`renderToStaticMarkup` para fixar um contrato de contexto. **Não** replicar
esse padrão aqui: o `EmojiPicker.Root` dispara efeitos e `fetch` no mount, e
o que importaria testar (foco, cursor, popover) não existe em SSR.

**`src/lib/emoji/insert-at-cursor.test.ts`**

| Caso                               | Asserção                                                        |
| ---------------------------------- | --------------------------------------------------------------- |
| Campo vazio                        | `{ value: '😀', caret: 2 }`                                     |
| Cursor no meio (`"Ola\| tudo"`)    | emoji entra na posição, `caret` logo depois                     |
| Seleção não vazia                  | o trecho selecionado é **substituído**                          |
| Cursor no fim                      | anexa; `caret === value.length`                                 |
| `selectionStart/End` `null`        | anexa no fim (campo nunca focado)                               |
| Índices maiores que `value.length` | clampados; nenhum `undefined` na string resultante              |
| Índices negativos / `NaN`          | clampados; não lança                                            |
| `start > end` (seleção invertida)  | normalizado, não corrompe a string                              |
| Emoji com ZWJ (`👨‍👩‍👧`)               | `caret === start + insert.length` em UTF-16 (8 unidades, não 1) |
| Emoji com tom de pele (`👍🏽`)       | idem — a sequência de modificador conta inteira                 |
| Duas inserções encadeadas          | segunda usa o `caret` da primeira e produz `"😀👍"`             |

**`src/lib/emoji/locale.test.ts`**

- `'pt-BR'` → `'pt'` (o caso que justifica o módulo existir).
- `'en'` → `'en'`.
- `undefined` / `null` / `'xx-YY'` / `'PT-br'` → `'en'` (fallback).
- **Teste de completude:** iterar `SUPPORTED_LOCALES` e afirmar que todo
  locale do app produz um valor diferente do fallback. É o teste que pega o
  dia em que alguém adicionar `es` a `locales.ts` e o picker cair no inglês
  em silêncio.
- `REQUIRED_EMOJIBASE_LOCALES` não tem duplicatas e cobre todo
  `SUPPORTED_LOCALES` — guarda o `sync-emojibase.mjs` de esquecer um locale.

**`src/lib/emoji/preferences.test.ts`** (com um `KeyValueStorage` falso, um
`Map`, já que não há `localStorage` no ambiente `node`)

- Storage vazio → `'none'`.
- Ida e volta de cada um dos 6 tons.
- Valor gravado inválido (`'roxo'`, `''`, `'null'`) → `'none'`.
- `storage === null` (servidor) → `'none'`, sem lançar.
- `getItem` que lança → `'none'`, sem lançar.
- `setItem` que lança (cota / janela privada do Safari) → não propaga.
- Usuários diferentes usam chaves diferentes: gravar para `u1` não afeta `u2`.

**`src/lib/emoji/recents.test.ts`**

- Storage vazio → `[]`.
- `pushRecent` de um emoji → lista com 1 item, campos preservados.
- MRU: `push(a); push(b); push(a)` → `[a, b]`, com `a` na frente.
- Deduplicação pela string `emoji`; 👍 e 👍🏽 permanecem **entradas separadas**.
- Teto: `MAX_RECENTS + 5` inserções → exatamente `MAX_RECENTS` itens, e o
  mais antigo saiu.
- JSON inválido no storage → `[]` (não lança).
- `version` diferente do atual → `[]` (descarte, não migração).
- `items` que não é array → `[]`.
- Array com entradas malformadas (`{}`, `{ emoji: 1 }`, `null`) → só as
  válidas sobrevivem.
- `clearRecents` esvazia e `readRecents` volta `[]`.
- Isolamento por `userId`.
- `pushRecent` devolve a mesma lista que um `readRecents` seguinte produziria
  (o hook confia nesse retorno).

**Fora de escopo, explicitamente:** busca, virtualização, navegação por
teclado, filtro de suporte a emoji, cache de dados — tudo isso é o Frimousse.

### Checklist de teste manual (F6, em navegador)

Sem jsdom, o comportamento de foco/cursor só se verifica de verdade
manualmente. Rodar em Chrome **e** Firefox, nos temas claro e escuro:

1. Botão de emoji aparece entre o `+` e o de templates; ícone alinhado com os
   irmãos em ≥1280 px e abaixo disso.
2. Abre o popover acima do composer, sem cortar na borda da janela.
3. Foco cai no campo de busca; digitar "cora" (pt-BR) acha ❤️ — **prova o
   fallback `pt-BR` → `pt`**.
4. Clicar num emoji o insere **na posição do cursor**, não no fim: escreva
   "Bom dia tudo bem", posicione o cursor depois de "dia", insira.
5. Com um trecho selecionado, o emoji **substitui** a seleção.
6. Popover **continua aberto**; um segundo emoji entra logo após o primeiro.
7. `Esc` fecha; o foco volta ao textarea **na posição correta**; continuar
   digitando escreve no lugar certo.
8. `Enter` dentro do picker **não** envia a mensagem.
9. Setas navegam a grade; `Enter` insere.
10. Trocar o tom de pele, fechar, reabrir → tom preservado. Recarregar a
    página → ainda preservado.
11. Após 3–4 usos, a faixa "Usados com frequência" aparece no topo, em ordem
    de uso mais recente, sem repetição.
12. Trocar o idioma em Configurações → Aparência para inglês: busca por
    "heart" funciona, textos de UI em inglês.
13. Conversa fora da janela de 24 h: botão **desabilitado**.
14. Usuário com papel somente-leitura: botão desabilitado, `title`
    "Read-only".
15. DevTools → Network: `/emojibase/pt/data.json` retorna **200 da mesma
    origem** (não de `cdn.jsdelivr.net`); segunda abertura não refaz a busca
    (Application → Local Storage tem `frimousse/data/pt`).
16. DevTools → Console: **nenhuma violação de CSP** relatada ao abrir o
    picker.
17. Emoji enviado chega correto no WhatsApp do destinatário (incluindo um com
    tom de pele e um com ZWJ, tipo 👨‍👩‍👧).

### Checklist de validação local (obrigatória — não há CI)

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

O que cada passo pega **neste** recurso:

| Comando        | Falha esperada se algo foi esquecido                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `typecheck`    | `EMOJI_LOCALE_BY_APP_LOCALE` sem entrada para um `AppLocale` novo; props do Base UI que não existem na versão instalada |
| `i18n:check`   | `EmojiPicker.*` presente só em `en.json` ou só em `pt-BR.json` (~1.600 chaves comparadas)                               |
| `lint`         | `useCallback` sem `text`/`adjustHeight` nas dependências — o bug clássico de cursor congelado num valor obsoleto        |
| `test`         | Os 4 arquivos de teste da §Plano de testes                                                                              |
| `format:check` | **Falha em 1,5 MB de JSON se `public/emojibase` não estiver no `.prettierignore`** — não pule este passo                |
| `build`        | `next/dynamic` mal formado; import de `frimousse` num Server Component (o painel precisa de `'use client'`)             |

Depois do gate verde, **rodar também `npm run emoji:sync` e conferir que o
`git status` fica limpo** — se ele reescrever arquivos, o commit anterior
estava dessincronizado da versão da dependência.

### Git

Commits e push são **manuais do mantenedor** (`AGENTS.md`). Comando pronto
para depois do gate verde e do teste manual:

```bash
git add -A && git commit -m "feat: seletor de emojis no composer do inbox com Frimousse, dados Emojibase auto-hospedados, recentes e tom de pele por usuario (SPEC 066)"
```

---

## Segurança

### Content Security Policy

`next.config.ts` já envia CSP, hoje como
**`Content-Security-Policy-Report-Only`**, com a intenção declarada de virar
enforcing. Política atual, nas diretivas relevantes:

```
default-src 'self'
connect-src 'self' https://*.supabase.co wss://*.supabase.co
img-src 'self' data: blob: https:
```

**Com a opção recomendada (self-host): nenhuma mudança de CSP é necessária.**
O Frimousse busca `/emojibase/pt/data.json` na própria origem, coberto por
`connect-src 'self'`. Esse é um argumento de peso a favor do self-host: o
recurso entra sem alargar a política, e não vira uma surpresa no dia em que o
cabeçalho deixar de ser `Report-Only`.

**Se o CDN for escolhido**, a única diretiva a mexer é `connect-src` — o
Frimousse busca os dados com `fetch`, e é `connect-src` que governa `fetch`,
não `script-src`:

```ts
"connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net",
```

Não é preciso tocar em `script-src` (nenhum JS é baixado do CDN), nem em
`img-src` (emoji são glifos de fonte, não imagens), nem em `font-src` (as
fontes de emoji são do sistema operacional). Prefira o host exato
`https://cdn.jsdelivr.net` a um curinga — e registre no comentário do
`next.config.ts` que essa entrada existe **por causa do picker de emoji**,
para que ninguém a remova achando que é resíduo.

### Injeção e sanitização

O emoji entra no `text` como qualquer outro caractere digitado e segue o
caminho já existente: `onSend(trimmed, replyTo?.id)` → rota de envio →
`src/lib/whatsapp/send-message.ts`. **Nenhuma superfície nova.** Em
particular:

- O texto **não** é interpolado em HTML em nenhum ponto — o React escapa, e
  as bolhas de mensagem renderizam texto, não `dangerouslySetInnerHTML`.
- O rótulo (`label`) da Emojibase é renderizado só em `aria-label`/`title` da
  faixa de recentes, como texto.
- Os dados da Emojibase são **JSON estático**, nunca `eval`/`Function`.

### Dado de terceiro em `localStorage`

Duas chaves nossas (`zapcrm:emoji:*`) e uma do Frimousse
(`frimousse/data/{locale}`).

- **Não guardam nada sensível.** Tom de pele e uma lista de caracteres. Nem
  telefone, nem conteúdo de conversa, nem token.
- `readRecents` trata o blob armazenado como **entrada não confiável**: JSON
  inválido, versão diferente, tipo errado e entradas malformadas produzem
  lista vazia ou filtrada, nunca exceção. Um `localStorage` adulterado por
  outra aba da mesma origem não pode derrubar o composer.
- O sufixo `:{userId}` nas chaves evita que dois atendentes que compartilham
  a estação vejam as preferências um do outro. Isso é higiene, **não** um
  limite de segurança: `localStorage` é por origem, e quem tem acesso ao
  navegador lê as duas chaves de qualquer jeito. Nada que precise de
  isolamento real pode ir para lá — motivo adicional pelo qual só preferência
  cosmética mora nessas chaves.

### Cadeia de suprimentos

- `frimousse` tem **zero dependências de runtime**, o que reduz a superfície
  ao próprio pacote. Fixar por intervalo caret (`^0.3.0`) com o
  `package-lock.json` commitado; conferir o changelog antes de subir de
  versão — é pré-1.0, então uma minor pode quebrar API.
- `emojibase-data` fica em `devDependencies` e **nada dela chega ao bundle** —
  só os 4 JSONs copiados, revisáveis no diff do commit.
- Com o self-host, **nenhum recurso de terceiro é buscado em runtime**, o que
  significa que um comprometimento do jsDelivr não alcança os atendentes.

---

## Troubleshooting

| Sintoma                                                | Causa provável                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Picker abre e fica em "Carregando emojis…" para sempre | `public/emojibase/` não foi gerado (`npm run emoji:sync`) ou não foi ao deploy. Confira `/emojibase/pt/data.json` no Network — 404 confirma                                |
| Mesmo sintoma, mas o arquivo existe                    | `emojibaseUrl` com barra no fim (`"/emojibase/"`) → URL vira `//pt/data.json`. O Frimousse concatena literalmente                                                          |
| Só quebra em produção, funciona em `dev`               | Regra de `Cache-Control` ou matcher do middleware não replicados; ou o host não serviu `public/` — ver §Instalação                                                         |
| Violação de CSP no console ao abrir                    | Opção CDN sem `https://cdn.jsdelivr.net` em `connect-src`. Com self-host isso não deveria acontecer — se acontecer, `emojibaseUrl` está apontando para fora da origem      |
| Requisição de `/emojibase/*.json` retorna 401/302      | `emojibase` não foi adicionado à exclusão do matcher em `src/middleware.ts`                                                                                                |
| Rótulos e busca em inglês num app em pt-BR             | `toEmojiLocale` não está sendo chamado (locale cru `'pt-BR'` foi passado, o Frimousse não reconhece e cai no default `'en'`)                                               |
| Busca em português não acha nada, rótulos em inglês    | `pt` não foi copiado pelo `sync-emojibase.mjs` — `LOCALES` desatualizado                                                                                                   |
| Emoji sempre entra no **fim** do texto                 | `.focus()` sendo chamado antes de `setSelectionRange`, ou `setSelectionRange` fora do `requestAnimationFrame` (React ainda não aplicou o novo `value`)                     |
| Cursor "congela" e insere sempre na mesma posição      | `handleInsertEmoji` memoizado sem `text` nas dependências — o closure lê um `text` obsoleto. `npm run lint` pega                                                           |
| Popover fecha a cada emoji escolhido                   | Algum `onSelect` chamando `setOpen(false)`, ou `.focus()` no textarea movendo o foco para fora do popup                                                                    |
| Tom de pele volta ao padrão a cada abertura            | Falta o `<PersistSkinTone>` dentro do `Root`. `skinTone` é valor **inicial** e a v0.3.0 não tem `onSkinToneChange` — ver §Configuração                                     |
| Recentes somem sozinhos                                | Navegador em modo privado, "limpar dados ao sair", ou cota de `localStorage` estourada (o cache de ~780 KB do Frimousse concorre pelo mesmo espaço)                        |
| Recentes de outro atendente aparecem                   | Chave sem o sufixo `:{userId}`                                                                                                                                             |
| `npm run format:check` falha com milhares de linhas    | `public/emojibase` fora do `.prettierignore`                                                                                                                               |
| `npm run i18n:check` falha                             | Namespace `EmojiPicker` adicionado em só um dos dicionários                                                                                                                |
| `Enter` no picker envia a mensagem                     | O `onKeyDown` de envio subiu para um contêiner que engloba o Portal do popover. Deve ficar **no `<textarea>`**                                                             |
| Rolagem horizontal dentro do picker                    | `columns` no default 10 com painel estreito. Use `columns={8}` para 352 px                                                                                                 |
| Quadradinhos (tofu) no lugar de alguns emojis          | Fonte de emoji do sistema desatualizada (Windows Server/LTSC antigo). O filtro por versão do Frimousse cobre o navegador, não fontes ausentes no SO — orientar atualização |
| Layout dos botões embaralha abaixo de 1280 px          | `order-*` não renumerados depois de inserir o gatilho (ver §Exemplos, passo 4)                                                                                             |

---

## Referências

### Frimousse

- Site e documentação: https://frimousse.liveblocks.io/
- Repositório: https://github.com/liveblocks/frimousse
- Changelog: https://github.com/liveblocks/frimousse/blob/main/CHANGELOG.md
- Pacote npm (0.3.0, MIT, sem dependências): https://www.npmjs.com/package/frimousse
- Tipos publicados (fonte de verdade da API usada nesta SPEC):
  https://cdn.jsdelivr.net/npm/frimousse@0.3.0/dist/index.d.ts
- Registro shadcn (não usado — ver §Instalação):
  `npx shadcn@latest add https://frimousse.liveblocks.io/r/emoji-picker`

### Emojibase

- Documentação: https://emojibase.dev/
- Conjuntos de dados e locales: https://emojibase.dev/docs/datasets/
- Repositório: https://github.com/milesj/emojibase
- Pacote npm: https://www.npmjs.com/package/emojibase-data

### Base UI

- Popover (props `initialFocus`, `finalFocus`, `render`):
  https://base-ui.com/react/components/popover

### Documentos deste repositório

| Documento                                                                               | Relevância                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                                                               | Convenções, armadilhas e o gate de validação local                            |
| [docs/comandos-desenvolvimento.md](./comandos-desenvolvimento.md)                       | Quando e por que rodar cada comando npm                                       |
| [docs/i18n-implementation-report.md](./i18n-implementation-report.md)                   | Arquitetura de i18n e o contrato de paridade                                  |
| [docs/spec-049-inbox-multicanal-e-motores.md](./spec-049-inbox-multicanal-e-motores.md) | Padrão de capacidade por canal no composer (e por que emoji não precisa dele) |
| `src/components/inbox/message-composer.tsx`                                             | Ponto único de integração no inbox                                            |
| `src/components/ui/popover.tsx`                                                         | Wrapper Base UI a reutilizar                                                  |
| `src/lib/i18n/locales.ts`                                                               | Fonte da verdade dos locales do app                                           |
| `src/lib/emoji/`                                                                        | Camada criada por esta SPEC                                                   |

---

## Créditos

- **Frimousse** — seletor de emojis headless e componível para React,
  desenvolvido e mantido pela **[Liveblocks](https://liveblocks.io/)**
  (https://github.com/liveblocks/frimousse). Toda a mecânica de picker desta
  entrega — grade virtualizada, busca, navegação por teclado, suporte a
  leitor de tela, tons de pele, filtro de emojis não suportados e cache local
  do dado — é trabalho do Frimousse. O ZAP CRM BR contribui apenas a camada
  de integração descrita neste documento.
- **Emojibase** — origem de **todos os dados de emoji** (caracteres,
  categorias, rótulos localizados, índices de busca e metadados de versão),
  projeto de **[Miles Johnson](https://github.com/milesj)**
  (https://github.com/milesj/emojibase). Os arquivos servidos a partir de
  `public/emojibase/` são cópias inalteradas do pacote `emojibase-data`.
- **ZAP CRM BR** — fork/derivado do [wacrm](https://github.com/ArnasDon/wacrm)
  de [ArnasDon](https://github.com/ArnasDon). Todos os créditos pelo core
  original pertencem ao autor original; a localização para o mercado
  brasileiro e a evolução sob o nome ZAP CRM BR são mantidas por
  [Bruno Pelatieri](https://github.com/brunopelatieri).

## Licença

- **Frimousse** — licença **MIT**
  (https://github.com/liveblocks/frimousse/blob/main/LICENSE). Compatível com
  o licenciamento MIT deste repositório; nenhuma obrigação de copyleft.
- **Emojibase / `emojibase-data`** — licença **MIT**
  (https://github.com/milesj/emojibase/blob/master/LICENSE). Os dados JSON
  auto-hospedados em `public/emojibase/` permanecem sob a licença MIT
  original — **mantenha o arquivo `LICENSE` da Emojibase junto a eles** (o
  `sync-emojibase.mjs` copia `node_modules/emojibase-data/LICENSE` para
  `public/emojibase/LICENSE`) para preservar o aviso de copyright exigido
  pela MIT ao redistribuir.
- **Emoji em si** — os glifos são renderizados pela fonte de emoji do sistema
  operacional do usuário (Apple Color Emoji, Noto Color Emoji, Segoe UI
  Emoji). **Nenhuma fonte ou imagem de emoji é redistribuída por este
  projeto**, o que evita as restrições de licenciamento de conjuntos de
  imagens de emoji proprietários.
- **ZAP CRM BR** — MIT, conforme `package.json` e o repositório original.
