# Relatório de implementação — Internacionalização (i18n)

Documento de auditoria e especificação técnica da arquitetura de
idiomas do **ZAP CRM BR**. Cobre a evolução de um locale fixo por
variável de ambiente para seleção dinâmica por dispositivo (inglês +
português brasileiro), o que foi alterado no código, decisões de
produto e resultados da revisão de qualidade.

|                      |                                                                 |
| -------------------- | --------------------------------------------------------------- |
| **Status**           | Implementado (v1)                                               |
| **Biblioteca**       | [`next-intl`](https://next-intl.dev) `^4.13.1`                  |
| **Locales**          | `pt-BR` (padrão de runtime), `en` (fonte da verdade das chaves) |
| **Roteamento**       | Sem prefixo de URL (`/pt-br/...`)                               |
| **Persistência**     | Cookie `NEXT_LOCALE` (por dispositivo)                          |
| **Última validação** | Paridade de chaves + `tsc --noEmit` OK                          |

---

## 1. Objetivo e escopo

### Objetivo

Permitir que cada usuário escolha o idioma da interface (inglês ou
português do Brasil) em **Settings → Appearance**, com persistência
entre visitas no mesmo navegador/dispositivo, sem alterar URLs do app
e sem migration no Supabase.

### Dentro do escopo (v1)

- Resolução de locale no servidor (cookie → env → default).
- Dicionários `messages/en.json` e `messages/pt-BR.json` com a mesma
  árvore de chaves.
- Seletor de idioma na UI.
- Extração das principais lacunas de strings hardcoded (auth, join,
  notifications, agents, quick replies, interactive builder, labels
  de negócio em `src/lib/`).
- Guardrails de manutenção (`npm run i18n:check` local).
- Política explícita: respostas de `/api/**` permanecem em inglês.

### Fora do escopo (v1)

- Prefixo de locale na URL (SEO irrelevante: app privado,
  `robots: { index: false }`).
- Coluna `profiles.locale` / sync entre dispositivos.
- Tradução das ~53 rotas de API e das mensagens de
  `src/lib/flows/validate.ts` (compartilhadas com testes e API).
- Augmentação TypeScript estrita do `next-intl` (avaliada e
  descartada — ver §7).

---

## 2. Arquitetura

### 2.1 Biblioteca e integração Next.js

O projeto já usava `next-intl` via plugin em
[`next.config.ts`](../next.config.ts):

```ts
import createNextIntlPlugin from 'next-intl/plugin';
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
```

A configuração de request vive em [`src/i18n/request.ts`](../src/i18n/request.ts)
(`getRequestConfig`). O root layout
([`src/app/layout.tsx`](../src/app/layout.tsx)) carrega locale e
mensagens no servidor e envolve a árvore em
`<NextIntlClientProvider>`:

```tsx
const locale = await getLocale();
const messages = await getMessages();
// ...
<html lang={locale} ...>
  <NextIntlClientProvider messages={messages} locale={locale}>
```

O atributo `lang` do `<html>` acompanha o locale resolvido.

### 2.2 Resolução de locale (ordem de prioridade)

Implementada em `src/i18n/request.ts`:

1. **Cookie `NEXT_LOCALE`** — se o valor passar em `isAppLocale()`.
2. **`NEXT_PUBLIC_APP_LOCALE`** — default do deployment para quem
   ainda não escolheu idioma (primeira visita / cookies bloqueados).
3. **`DEFAULT_LOCALE` (`pt-BR`)** — último recurso.

Valores inválidos ou obsoletos nunca chegam ao
`import(\`../../messages/${locale}.json\`)`, o que elimina o warning
histórico `Module not found: Can't resolve '.../pt-BR.json'` quando a
env apontava para um locale sem arquivo.

> **Next.js 16:** `cookies()` é assíncrono — o código usa
> `await cookies()` obrigatoriamente.

### 2.3 Fonte da verdade de locales

[`src/lib/i18n/locales.ts`](../src/lib/i18n/locales.ts):

| Export              | Papel                        |
| ------------------- | ---------------------------- |
| `SUPPORTED_LOCALES` | `['pt-BR', 'en']`            |
| `AppLocale`         | Tipo união derivado do array |
| `DEFAULT_LOCALE`    | `'pt-BR'`                    |
| `LOCALE_COOKIE`     | `'NEXT_LOCALE'`              |
| `LOCALE_LABELS`     | Rótulos nativos no seletor   |
| `isAppLocale()`     | Type guard                   |

Nenhum outro módulo deve hardcodar a lista de idiomas.

### 2.4 Persistência e troca de idioma

| Peça              | Arquivo                                                                                             | Comportamento                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Server Action     | [`src/lib/i18n/actions.ts`](../src/lib/i18n/actions.ts)                                             | `setLocaleAction(locale)` grava cookie (`path: '/'`, `maxAge` ≈ 1 ano, `sameSite: 'lax'`) e chama `revalidatePath('/', 'layout')` |
| UI                | [`src/components/settings/language-switcher.tsx`](../src/components/settings/language-switcher.tsx) | Select shadcn; chama a action dentro de `useTransition`, depois `router.refresh()` + toast                                        |
| Local de exibição | [`appearance-panel.tsx`](../src/components/settings/appearance-panel.tsx)                           | Seção **Language** em Settings → Appearance                                                                                       |

Fluxo:

```
Usuário escolhe idioma
  → setLocaleAction (cookie NEXT_LOCALE)
  → router.refresh()
  → request.ts relê cookie
  → layout re-renderiza com getLocale/getMessages
  → NextIntlClientProvider propaga o novo dicionário
```

Sem hard reload e sem segmento `[locale]` nas rotas (`/dashboard`,
`/inbox`, etc. permanecem iguais).

### 2.5 Dicionários

| Arquivo                                         | Papel                                  |
| ----------------------------------------------- | -------------------------------------- |
| [`messages/en.json`](../messages/en.json)       | Fonte da verdade / fallback conceitual |
| [`messages/pt-BR.json`](../messages/pt-BR.json) | Tradução 1:1 da árvore de chaves       |

Namespaces de topo (ordem aproximada da navegação do produto):

`LoginPage`, `SignupPage`, `ForgotPasswordPage`, `JoinPage`,
`Sidebar`, `Header`, `ModeToggle`, `Dashboard`, `Inbox`, `Contacts`,
`Pipelines`, `Broadcasts`, `Automations`, `Flows`, `Notifications`,
`Agents`, `Currencies`, `Interactive`, `Settings`.

Convenção de uso nos componentes:

```ts
const t = useTranslations('Settings.appearance');
// Server Components / handlers: getTranslations('...')
```

Chaves novas **sempre** entram primeiro em `en.json`, depois são
espelhadas em `pt-BR.json`.

### 2.6 Variável de ambiente

`NEXT_PUBLIC_APP_LOCALE` (documentada em
[`.env.local.example`](../.env.local.example)):

- **Antes:** idioma fixo de toda a instância.
- **Agora:** apenas o default do servidor para visitantes sem cookie.

Valores aceitos: `en`, `pt-BR`.

---

## 3. Resumo do que foi executado (fases)

### Fase 0 — Estabilização

- Corrigido namespace inválido em
  `settings-overview.tsx`: `useTranslations('roles')` →
  `useTranslations('Settings.roles')`.
- Eliminado o warning de import dinâmico inválido via validação
  `isAppLocale` + criação de `messages/pt-BR.json`.

### Fase 1 — Fundação

- Criados `locales.ts`, reescrita de `request.ts`, Server Action
  `setLocaleAction`.
- Criado `messages/pt-BR.json` completo (paridade com `en.json`).
- Comentários de env atualizados.

### Fase 2 — Seletor

- `LanguageSwitcher` + chaves
  `Settings.appearance.language|languageDesc|languageChanged`.
- Integrado em Appearance ao lado de Mode / Accent.

### Fase 3 — Lacunas de UI

Instrumentados / traduzidos (entre outros):

| Área                                | Namespaces / abordagem                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Signup / forgot-password / join     | `SignupPage`, `ForgotPasswordPage`, `JoinPage`                                             |
| Notifications                       | `Notifications`                                                                            |
| AI Agents (page, playground, usage) | `Agents.*`                                                                                 |
| Quick replies                       | `Settings.quickReplies`                                                                    |
| Interactive builder                 | `Interactive.builder`                                                                      |
| Status de templates Meta            | `Settings.templates.status` + keys em `template-status.ts`                                 |
| Moedas                              | namespace `Currencies` + consumidores em deals/overview                                    |
| Galeria de automações               | `Automations.list.templateCards.*`                                                         |
| Triggers / relative time            | `Automations.builder.triggers.*.label`, `Automations.relative` + `formatRelative(..., t?)` |
| Galeria de flows                    | `Flows.list.templates.<slug>.*`                                                            |

**Labels de negócio em `src/lib/`:** enums/slugs/valores persistidos
**não** são traduzidos — só o texto de exibição. Ex.:
`broadcast-status.ts` já usava labels-como-chaves sob
`Broadcasts.status`; `template-status.ts` adotou o mesmo padrão.

**`flows/validate.ts`:** permanece em inglês (módulo compartilhado
com API e testes). Documentado no próprio arquivo.

### Fase 4 — Política de API

Decisão: **manter `/api/**` em inglês**.

Documentado em:

- Comentário em [`src/middleware.ts`](../src/middleware.ts) (próximo
  ao JSON `Unauthorized`).
- Seção _Language of error messages_ em
  [`docs/public-api.md`](./public-api.md).

A UI deve mapear códigos/formas de erro conhecidas para chaves
`next-intl` no client quando for exibir falhas ao usuário final.

### Fase 5 — Guardrails

| Artefato                                                            | Descrição                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`scripts/check-i18n-parity.mjs`](../scripts/check-i18n-parity.mjs) | Compara árvores de chaves `en.json` vs demais locales             |
| `npm run i18n:check`                                                | Script no `package.json` — rode localmente antes de commit/deploy |

Tipagem estrita `AppConfig` / `IntlMessages` do next-intl foi
**avaliada e removida**: o codebase usa muitas chaves dinâmicas
(`t(\`status.${x}\`)`, etc.) e a augmentação gerava dezenas de erros
de TypeScript sem benefício proporcional na v1.

---

## 4. Estrutura de arquivos tocados (mapa)

### Núcleo i18n (novos / reescritos)

```
src/lib/i18n/locales.ts          # constantes + type guard
src/lib/i18n/actions.ts          # setLocaleAction
src/i18n/request.ts              # resolução cookie → env → default
src/components/settings/language-switcher.tsx
messages/en.json                 # + namespaces/chaves novas
messages/pt-BR.json              # dicionário completo
scripts/check-i18n-parity.mjs
```

### UI e lib (instrumentação / labels)

```
src/app/(auth)/signup/page.tsx
src/app/(auth)/forgot-password/page.tsx
src/app/join/[token]/page.tsx
src/app/(dashboard)/notifications/page.tsx
src/app/(dashboard)/agents/page.tsx
src/app/(dashboard)/automations/page.tsx
src/app/(dashboard)/automations/[id]/logs/page.tsx
src/app/(dashboard)/flows/page.tsx
src/components/agents/ai-playground.tsx
src/components/agents/ai-usage.tsx          # se presente
src/components/settings/appearance-panel.tsx
src/components/settings/settings-overview.tsx
src/components/settings/deals-settings.tsx
src/components/settings/quick-replies-manager.tsx
src/components/settings/template-manager.tsx
src/components/interactive/interactive-builder.tsx
src/lib/template-status.ts
src/lib/currency.ts                         # docs/fallback EN
src/lib/automations/trigger-meta.ts         # formatRelative(t?)
src/lib/flows/validate.ts                   # comentário de política
```

### Config / docs

```
.env.local.example
package.json                                # i18n:check
docs/public-api.md
docs/i18n-implementation-report.md          # este arquivo
README.md                                   # seção Idiomas
```

> **Nota (2026):** a pasta `.github/` foi removida deste repositório.
> Não há GitHub Actions para paridade i18n — use `npm run i18n:check`
> localmente ou configure CI no seu fork.

---

## 5. Resultados da auditoria de código

Auditoria executada após a implementação das fases 0–5.

### 5.1 Checks automatizados

| Check                                | Resultado                                    |
| ------------------------------------ | -------------------------------------------- |
| `npm run i18n:check`                 | Paridade EN ↔ pt-BR (mesma árvore de chaves) |
| `npm run typecheck`                  | Sem erros                                    |
| `vitest` em `flows/validate.test.ts` | 30/30 passando                               |

### 5.2 Bugs encontrados e corrigidos na auditoria

| Severidade           | Achado                                                                                                                                                                                                                               | Correção                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Alta (UI)**        | `Settings.sections` não tinha a chave `quick-replies`, mas o rail (`settings-rail.tsx`) e o tipo `SettingsSection` usam `'quick-replies'`. Em runtime o next-intl falhava / mostrava MISSING_MESSAGE ao abrir Settings com PT ou EN. | Adicionadas chaves `Settings.sections.quick-replies` em `en.json` e `pt-BR.json`. |
| **Alta (regressão)** | Em `ai-playground.tsx`, o callback `turns.map((t) => …)` sombreava o `t` de `useTranslations`, quebrando `t('handoffNote')` (erro TS2349 / runtime).                                                                                 | Renomeado o item do map para `turn`.                                              |
| **Média**            | `template-manager` passou a chamar `t(\`status.${label}\`)`antes das chaves`Settings.templates.status.*` existirem.                                                                                                                  | Chaves `draft`…`pendingDeletion` adicionadas em EN+PT.                            |
| **Média**            | Comentários em `currency.ts` referiam namespace `Currencies` sem o namespace / sem atualizar consumidores.                                                                                                                           | Namespace `Currencies` + uso em `deals-settings` / `settings-overview`.           |
| **Baixa (Fase 0)**   | Namespace `roles` inválido em overview.                                                                                                                                                                                              | `Settings.roles`.                                                                 |

### 5.3 Decisões conscientes / limitações conhecidas

1. **API e `validate.ts` em inglês** — integração, logs e testes
   compartilham as mesmas strings; traduzir exigiria issues com
   `code` + mapper no client (follow-up possível).
2. **Conteúdo de templates de automação/flow enviados ao cliente**
   (textos WhatsApp seed) permanece em inglês nos módulos — só a
   **galeria** (name/description) é i18n. Seed persistido no DB não
   é reescrito.
3. **Termos mantidos iguais em PT** quando são marca/UX
   internacional: `Admin`, `Beta`, `Template(s)`, `Playground`,
   `Status`, `Avatar`, `Euro`, etc. — não são falhas de tradução.
4. **Sem tipagem estrita de chaves** no TypeScript (ver Fase 5).
5. **Locale por dispositivo**, não por conta — alinhado ao tema
   (`localStorage`). Sync via Supabase fica como extensão futura.

### 5.4 Cobertura restante (não bloqueante)

Ainda podem existir strings em inglês em componentes de menor
tráfego ou em helpers de formatação não listados na Fase 3. O
padrão para novas features é: chave em `en.json` → espelho PT →
`useTranslations` / `getTranslations`. Rode `npm run i18n:check` antes
de commitar — a paridade de chaves quebra o script se EN e PT divergirem.

---

## 6. Como o estado é gerenciado

| Preocupação             | Estratégia                                        |
| ----------------------- | ------------------------------------------------- |
| Locale atual no SSR     | Cookie lido em `getRequestConfig`                 |
| Locale atual no client  | `useLocale()` (next-intl)                         |
| Troca de idioma         | Server Action + `router.refresh()`                |
| Mensagens no client     | Props do `NextIntlClientProvider`                 |
| Default de deployment   | `NEXT_PUBLIC_APP_LOCALE`                          |
| Paridade de dicionários | `npm run i18n:check`                              |
| Tema (independente)     | `localStorage` (`useTheme`) — ortogonal ao locale |

Não há store Redux/Zustand para idioma. O cookie é a única fonte
mutável; o servidor re-resolve a cada request.

---

## 7. Tipagem next-intl (avaliação)

Foi experimentada a augmentação:

```ts
declare module 'next-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof en;
  }
}
```

Resultado: dezenas de erros em `t()` com chaves dinâmicas já
existentes (`Broadcasts.status`, `Inbox.messageThread`, sidebar,
etc.). **Removida da árvore.** Reintroduzir só faz sentido depois de
refatorar call sites dinâmicos para unions literais ou helpers
tipados.

---

## 8. Guia rápido — adicionar um novo idioma

Passos canônicos (detalhados também no [README](../README.md#idiomas-i18n)):

1. Adicionar o tag em `SUPPORTED_LOCALES` e o rótulo em
   `LOCALE_LABELS` (`src/lib/i18n/locales.ts`).
2. Copiar `messages/en.json` → `messages/<locale>.json` e traduzir
   valores (manter chaves e placeholders ICU/`rich text` intactos).
3. Rodar `npm run i18n:check` até passar.
4. (Opcional) Definir `NEXT_PUBLIC_APP_LOCALE=<locale>` no deploy
   como default para novos visitantes.
5. O seletor em Settings → Appearance passa a listar o idioma
   automaticamente.

---

## 9. Referências internas

| Recurso              | Caminho                                                           |
| -------------------- | ----------------------------------------------------------------- |
| Constantes de locale | `src/lib/i18n/locales.ts`                                         |
| Request config       | `src/i18n/request.ts`                                             |
| Server Action        | `src/lib/i18n/actions.ts`                                         |
| Seletor              | `src/components/settings/language-switcher.tsx`                   |
| Dicionários          | `messages/*.json`                                                 |
| Paridade             | `scripts/check-i18n-parity.mjs` / `npm run i18n:check`            |
| Guia de comandos     | [docs/comandos-desenvolvimento.md](./comandos-desenvolvimento.md) |
| Política de API      | `docs/public-api.md` (§ Language of error messages)               |
| Env example          | `.env.local.example`                                              |

---

## 10. Histórico resumido

| Fase                        | Entrega                                                     |
| --------------------------- | ----------------------------------------------------------- |
| 0                           | Bugfix namespace `roles` + estabilização de locale inválido |
| 1                           | Cookie + action + `pt-BR.json`                              |
| 2                           | Language switcher em Appearance                             |
| 3                           | Extração de gaps de UI + labels de negócio                  |
| 4                           | Política API em inglês documentada                          |
| 5                           | Paridade via script local; tipagem estrita descartada       |
| Auditoria pós-implementação | Fix `Settings.sections.quick-replies`; este relatório       |
