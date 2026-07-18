# Comandos de desenvolvimento — ZAP CRM BR

Guia de referência dos comandos `npm` do projeto: **o que fazem**,
**quando executar** e **por que importam**.

> Este repositório **não possui GitHub Actions** (pasta `.github/`
> removida). A qualidade depende de você rodar estes comandos
> localmente nos momentos certos — ou recriar CI no seu fork.

**Requisitos:** Node.js **≥ 20**, npm (vem com o Node).

---

## Visão rápida por momento

| Momento                              | Comandos recomendados                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| **Primeira vez no projeto**          | `npm install` → configurar `.env.local` → `npm run dev`                  |
| **Dia a dia (codando)**              | `npm run dev` (e opcionalmente `npm run test:watch`)                     |
| **Antes de commitar**                | `npm run typecheck` → `npm run i18n:check` → `npm run lint` → `npm test` |
| **Depois de editar traduções**       | `npm run i18n:check` (obrigatório)                                       |
| **Antes de deploy / push na `main`** | Sequência completa abaixo + `npm run build`                              |
| **Só formatar código**               | `npm run format`                                                         |
| **Verificar formatação sem alterar** | `npm run format:check`                                                   |

### Sequência completa (pré-deploy)

Rode na raiz do projeto, na ordem:

```bash
npm run typecheck
npm run i18n:check
npm run lint
npm run test
npm run format:check
npm run build
```

Se tudo passar, o código está alinhado com o que o projeto espera antes
de ir para produção.

---

## Comandos de setup

### `npm install`

|               |                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Instala dependências listadas em `package.json` (`node_modules/`).                                                               |
| **Quando**    | Após clonar o repo; após `git pull` que altere `package.json` ou `package-lock.json`; após trocar de branch com deps diferentes. |
| **Por quê**   | Sem `node_modules`, nenhum outro comando funciona. Lockfile garante versões reproduzíveis entre máquinas.                        |

```bash
git clone https://github.com/<seu-usuario>/zap-crm-br.git
cd zap-crm-br
npm install
cp .env.local.example .env.local
# Edite .env.local (Supabase, Meta, NEXT_PUBLIC_APP_LOCALE=pt-BR)
```

---

## Comandos de execução

### `npm run dev`

|               |                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Sobe o Next.js 16 em modo desenvolvimento (Turbopack), hot reload, em geral `http://localhost:3000`.             |
| **Quando**    | Sempre que for desenvolver ou testar UI/API localmente.                                                          |
| **Por quê**   | Ambiente rápido para iterar: alterações em `src/` recarregam sem rebuild completo. Lê variáveis de `.env.local`. |

**Observações:**

- Se a porta 3000 estiver ocupada, o Next.js pode usar 3001.
- Erros de runtime (ex.: next-intl `INVALID_MESSAGE`) aparecem no
  **terminal** e no **console do browser** — use os dois ao debugar.

### `npm run build`

|               |                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Gera build de **produção** (`.next/`): compila App Router, server actions, otimiza assets. O Next também roda checagem de tipos durante o build.                                    |
| **Quando**    | Antes do **primeiro deploy**; antes de push na branch que dispara deploy (ex.: `main` na Hostinger); quando quiser validar que o projeto compila como em produção.                  |
| **Por quê**   | `dev` tolera mais coisas que `build` não. Falhas de import, rotas inválidas ou erros de SSR só aparecem no build em alguns casos. Hostinger/Vercel executam este passo no servidor. |

```bash
npm run build
npm run start   # opcional: testar o build localmente
```

### `npm run start`

|               |                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Serve o app já buildado (`.next/`) em modo produção.                                                                |
| **Quando**    | Depois de `npm run build`, para simular produção localmente.                                                        |
| **Por quê**   | Confirma que o artefato de produção sobe sem depender do Turbopack de dev. **Não** use para desenvolvimento diário. |

---

## Comandos de qualidade (obrigatórios sem CI)

Sem GitHub Actions, estes substituem o pipeline que antes rodava em todo PR.

### `npm run typecheck`

|               |                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **O que faz** | `tsc --noEmit` — analisa TypeScript em todo o projeto **sem** gerar arquivos `.js`.                                           |
| **Quando**    | Antes de commit; após refactors grandes; após merge do upstream wacrm.                                                        |
| **Por quê**   | Pega erros de tipo cedo: props erradas, imports quebrados, APIs inexistentes. Mais rápido que `build` para feedback de tipos. |

**Falha típica:** renomear prop sem atualizar consumidor; shadowing de
`useTranslations` (`t` no map).

### `npm run i18n:check`

|               |                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Compara a árvore de chaves de `messages/en.json` (fonte da verdade) com `messages/pt-BR.json` e demais locales. Exit code ≠ 0 se faltar ou sobrar chave.   |
| **Quando**    | **Sempre** que editar `messages/en.json` ou `messages/pt-BR.json`; antes de commit que toque i18n; após adicionar `useTranslations('…')` com chaves novas. |
| **Por quê**   | Evita `MISSING_MESSAGE` em runtime no locale pt-BR (ou en). O ZAP CRM BR depende de paridade EN ↔ PT — ~1.600 chaves.                                      |

```bash
npm run i18n:check
# OK: "All locale dictionaries are in parity with en.json."
# Falha: lista chaves missing/extra por arquivo
```

**Implementação:** `scripts/check-i18n-parity.mjs`

### `npm run lint`

|               |                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| **O que faz** | ESLint sobre o código (`eslint.config.mjs`): regras de React, Next, hooks, etc.              |
| **Quando**    | Antes de commit; após mudanças em muitos arquivos.                                           |
| **Por quê**   | Mantém padrões e detecta anti-patterns (deps de hooks, imports não usados em regras ativas). |

### `npm test`

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **O que faz** | Vitest em modo **run once** — executa `src/**/*.test.ts(x)` e encerra.                                          |
| **Quando**    | Antes de commit/deploy; após alterar lógica em `src/lib/` (validações, webhooks, WhatsApp, automations, flows). |
| **Por quê**   | Cobre regras críticas de negócio sem browser: dedupe, assinatura HMAC, validação de flows, rate limit, etc.     |

**Variáveis de teste** (em `vitest.config.ts`, não precisa configurar):
`ENCRYPTION_KEY` e `META_APP_SECRET` fictícios para módulos que leem
env no load.

### `npm run test:watch`

|               |                                                                          |
| ------------- | ------------------------------------------------------------------------ |
| **O que faz** | Vitest em modo **watch** — reexecuta testes afetados ao salvar arquivos. |
| **Quando**    | Enquanto desenvolve uma feature com testes (TDD ou ajuste de lib).       |
| **Por quê**   | Feedback rápido sem rodar a suíte inteira manualmente a cada save.       |

**Não substitui** `npm test` antes do deploy — use watch só no loop de dev.

### `npm run format`

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| **O que faz** | Prettier **reescreve** arquivos (`--write .`) conforme estilo do projeto.     |
| **Quando**    | Antes de commit se o editor não formatou; após merge com conflitos de estilo. |
| **Por quê**   | Diff limpo e consistente (aspas, trailing comma, quebras de linha).           |

### `npm run format:check`

|               |                                                                                       |
| ------------- | ------------------------------------------------------------------------------------- |
| **O que faz** | Prettier em modo **somente leitura** — falha se algum arquivo estiver fora do padrão. |
| **Quando**    | Na sequência pré-deploy; em CI do seu fork (equivalente ao check-only).               |
| **Por quê**   | Garante formatação sem modificar arquivos — útil em scripts automatizados.            |

---

## Fluxos por tipo de mudança

### Alterou só código TypeScript/React (sem traduções)

```bash
npm run typecheck
npm run lint
npm run test
npm run dev          # validação manual na UI
```

### Alterou traduções (`messages/*.json`)

```bash
npm run i18n:check   # primeiro — confirma paridade
npm run typecheck
npm run dev          # abra Settings / telas afetadas em pt-BR e en
```

**Regra:** nova chave em `en.json` → espelho em `pt-BR.json` (mesma
árvore; traduza só os **valores**).

### Alterou componente com `t()` / `t.rich()` / placeholders Meta

```bash
npm run i18n:check
npm run dev
```

Verifique o **console do browser** — erros `INVALID_MESSAGE` (ICU) não
sempre aparecem no `typecheck`.

### Vai fazer deploy (Hostinger, Vercel, VPS)

```bash
npm run typecheck
npm run i18n:check
npm run lint
npm run test
npm run format:check
npm run build
git push origin main
```

Na Hostinger, o push dispara build remoto — se falhar localmente,
provavelmente falhará no servidor.

### Merge do upstream wacrm

```bash
git merge upstream/main
# resolva conflitos (atenção: messages/pt-BR.json, defaults pt-BR)
npm install          # se package.json mudou
npm run i18n:check
npm run typecheck
npm run test
npm run build
```

---

## O que acontece se pular cada comando

| Comando ignorado | Risco                                                       |
| ---------------- | ----------------------------------------------------------- |
| `typecheck`      | Commit com erro de TS; build quebra tarde                   |
| `i18n:check`     | Tela em branco / `MISSING_MESSAGE` só em pt-BR              |
| `lint`           | Débito de estilo; possíveis bugs que ESLint pegaria         |
| `test`           | Regressão em lib crítica (webhook, criptografia, validação) |
| `build`          | Deploy falha; erro só aparece no host                       |
| `format:check`   | PR/diff ruidoso; inconsistência entre devs                  |

---

## Comandos que **não** existem no `package.json`

Evite assumir scripts do monorepo original ou de outros projetos:

| Comando                     | Situação                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `npm run ci`                | **Não definido** — use a sequência pré-deploy manual         |
| `npm run i18n:check` via CI | **Não há CI upstream** — rode local ou crie workflow no fork |

### Recriar CI no seu fork (opcional)

Se quiser automatizar, um workflow mínimo executaria:

```yaml
# .github/workflows/ci.yml (exemplo — não incluso no upstream)
- run: npm ci
- run: npm run typecheck
- run: npm run i18n:check
- run: npm run lint
- run: npm run test
- run: npm run format:check
- run: npm run build
```

Veja [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Referências

| Recurso                  | Caminho                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Scripts (`package.json`) | [`package.json`](../package.json)                                   |
| Paridade i18n            | [`scripts/check-i18n-parity.mjs`](../scripts/check-i18n-parity.mjs) |
| Arquitetura i18n         | [i18n-implementation-report.md](./i18n-implementation-report.md)    |
| Contribuição             | [CONTRIBUTING.md](../CONTRIBUTING.md)                               |
| Início rápido            | [README.md](../README.md)                                           |

---

## Checklist imprimível (colar no fluxo de trabalho)

```
[ ] npm install          (se deps mudaram)
[ ] npm run dev          (durante desenvolvimento)
[ ] npm run i18n:check   (se tocou messages/ ou t())
[ ] npm run typecheck
[ ] npm run lint
[ ] npm run test
[ ] npm run format:check (ou npm run format)
[ ] npm run build        (antes de deploy)
[ ] git push
```
