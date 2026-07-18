# Contribuindo — ZAP CRM BR

Este é um **repositório template**, não um produto colaborativo com
roadmap centralizado. O fluxo esperado é:

1. **Fork** para sua conta ou organização.
2. **Deploy** do fork (Hostinger, Vercel, Railway, VPS, etc.).
3. **Personalize** — rebrand, features, schema, traduções.

Você **não precisa** enviar mudanças de volta ao upstream. O fork
divergir é o objetivo.

## Infraestrutura do repositório

Este projeto **não mantém** a pasta `.github/`. Foram removidos de
propósito:

- GitHub Actions (`workflows/ci.yml`)
- Templates de issue e pull request
- Dependabot
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`

**Validação de qualidade** — rode localmente antes de publicar.
Guia completo (quando, por quê, sequências): **[docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md)**.

| Comando                | O que faz                                    |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Servidor de desenvolvimento (Turbopack).     |
| `npm run build`        | Build de produção.                           |
| `npm run typecheck`    | `tsc --noEmit`.                              |
| `npm run lint`         | ESLint.                                      |
| `npm run i18n:check`   | Paridade de chaves `en.json` ↔ `pt-BR.json`. |
| `npm run format:check` | Prettier (modo check-only).                  |
| `npm test`             | Vitest.                                      |

Se você quiser CI no **seu fork**, recrie `.github/workflows/` com os
steps acima — o upstream não fornece mais esse diretório.

## Fork e execução local

```bash
# Fork: https://github.com/brunopelatieri/zap-crm-br → Fork
git clone https://github.com/<seu-usuario>/zap-crm-br.git
cd zap-crm-br

cp .env.local.example .env.local   # Supabase + Meta + NEXT_PUBLIC_APP_LOCALE=pt-BR
npm install
npm run dev
```

Documentação técnica neste repositório:

- [README.md](./README.md)
- [Comandos de desenvolvimento](./docs/comandos-desenvolvimento.md)
- [docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md)
- [docs/public-api.md](./docs/public-api.md)
- [docs/mcp.md](./docs/mcp.md)

Guia completo de auto-hospedagem (projeto original wacrm, em inglês):
[wacrm.tech/docs](https://wacrm.tech/docs).

## Manter o fork atualizado

Para puxar correções do upstream original (wacrm):

```bash
git remote add upstream https://github.com/ArnasDon/wacrm.git  # uma vez
git fetch upstream
git checkout main
git merge upstream/main
# Resolva conflitos nas áreas que você customizou, depois:
git push origin main
```

O **ZAP CRM BR** é um fork localizado; merges do wacrm upstream podem
exigir retrabalho em traduções (`messages/pt-BR.json`) e defaults
(`pt-BR`, tema claro, accent emerald).

## Reportar bugs

Abra uma [issue](https://github.com/brunopelatieri/zap-crm-br/issues)
no repositório **zap-crm-br**. Inclua:

- Passos para reproduzir
- Locale ativo (`pt-BR` / `en`)
- Commit ou versão
- Logs do browser ou terminal (sem secrets)

Para bugs no **core wacrm** (não introduzidos no seu fork), considere
reportar em [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm/issues).

## Reportar vulnerabilidades de segurança

**Não abra issues públicas** para falhas de segurança.

Use o fluxo privado do GitHub:

**[Security Advisories → Report a vulnerability](https://github.com/brunopelatieri/zap-crm-br/security/advisories/new)**

Inclua impacto, passos de reprodução e, se possível, um patch sugerido.

## Pull requests

Não é o fluxo principal, mas correções pontuais podem ser bem-vindas:

- **Correções de segurança** — sempre; use Security Advisories primeiro.
- **Bugs** (crash, i18n quebrado, documentação errada).
- **Melhorias pequenas** (a11y, typos) — abra issue antes para alinhar.

Menos provável de ser aceito:

- Features novas de produto (pertencem ao seu fork).
- Mudanças de stack (ORM, UI kit, auth provider).
- Refactors opinativos sem motivo claro de correção.

Se enviar PR:

- Branch a partir da `main` atualizada.
- Rode `npm run typecheck`, `npm run i18n:check` e `npm test`.
- Um change lógico por PR; descreva o _porquê_ no corpo.

## Se você mantém um fork público

- Rebrand (nome, favicon, domínio) — **ZAP CRM BR** e `wacrm` são
  identidades distintas.
- Mantenha o [`LICENSE`](./LICENSE) MIT.
- Créditos ao [wacrm](https://github.com/ArnasDon/wacrm) são
  apreciados (veja [README — Créditos](./README.md#créditos)).

## Licenciamento

MIT ([`LICENSE`](./LICENSE)). Contribuições upstream são assumidas
como MIT. Adições no seu fork são suas para licenciar como quiser.
