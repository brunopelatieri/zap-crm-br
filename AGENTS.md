# ZAP CRM BR — CRM para WhatsApp feito para o mercado brasileiro

**ZAP CRM BR** é um CRM para WhatsApp auto-hospedável, construído sobre Next.js e Supabase (caixa de entrada compartilhada, contatos, funis de vendas, disparos em massa e automações no-code), localizado e adaptado para as necessidades do mercado brasileiro.

- **Repositório (mantenedor):** https://github.com/brunopelatieri/zap-crm-br
- **Mantenedor / autor das modificações:** [Bruno Pelatieri](https://github.com/brunopelatieri)
- **Repositório original:** https://github.com/ArnasDon/wacrm
- **Autor original:** [ArnasDon](https://github.com/ArnasDon)

## Créditos

> Este projeto é um fork/derivado do repositório original [wacrm](https://github.com/ArnasDon/wacrm) desenvolvido por [ArnasDon](https://github.com/ArnasDon). Todos os créditos pelo core original da aplicação pertencem ao autor original. As modificações, localização para o mercado brasileiro e evolução deste projeto sob o nome **ZAP CRM BR** são mantidas por [Bruno Pelatieri](https://github.com/brunopelatieri) no repositório [zap-crm-br](https://github.com/brunopelatieri/zap-crm-br).

---

## Stack

| Camada        | Tecnologia                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| App           | Next.js **16.2.6** (App Router, Turbopack), React **19.2.4**, TypeScript **6** |
| Estilo        | Tailwind **v4**, shadcn/ui, `@base-ui/react`, `lucide-react`, `sonner`         |
| i18n          | **next-intl v4** — `pt-BR` (principal) + `en`, **sem prefixo de URL**          |
| Dados         | Supabase (Postgres + Auth + Storage + **RLS**)                                 |
| WhatsApp      | Meta Cloud API (WhatsApp Business oficial)                                     |
| Editor visual | `@xyflow/react` + `@dagrejs/dagre` (flows), `@dnd-kit` (kanban)                |
| Testes        | Vitest (co-locados: `*.test.ts` ao lado do fonte)                              |
| Node          | **≥ 20**                                                                       |

---

## Mapa do repositório

```
src/
  middleware.ts            Auth guard + resolução de locale (roda em toda request)
  app/
    (auth)/                login, signup, forgot-password, reset-password
    (dashboard)/           dashboard, inbox, contacts, pipelines, broadcasts,
                           automations, flows, agents, notifications, settings
    api/                   Rotas internas do app (ver "Rotas de API" abaixo)
    api/v1/                API REST pública (chaves escopadas) — docs/public-api.md
    join/[token]/          Aceite de convite de equipe
  components/<módulo>/     UI por módulo, espelha as rotas do (dashboard)
  components/ui/           Primitivos shadcn/ui (não editar sem necessidade)
  lib/<módulo>/            Regra de negócio — é AQUI que a lógica vive e é testada
  hooks/                   Hooks React compartilhados
  i18n/request.ts          Config server-side do next-intl
  types/index.ts           Tipos do domínio (schema do banco, entidades)
messages/                  en.json (fonte da verdade) + pt-BR.json (espelho)
supabase/migrations/       001 → 054 — schema versionado
supabase/setup/            Scripts NÃO-migração (ex.: cron-jobs.sql)
docs/                      SPECs e guias (índice no fim deste arquivo)
n8n_automation/            Workflows n8n versionados (credenciais redigidas)
mcp-server/                Servidor MCP para controlar o CRM por assistentes
scripts/                   check-i18n-parity.mjs
```

### Onde mexer, por tipo de tarefa

| Tarefa                     | Comece por                                                                      |
| -------------------------- | ------------------------------------------------------------------------------- |
| Envio/recebimento WhatsApp | `src/lib/whatsapp/` (`send-message`, `meta-api`, `webhook-signature`)           |
| Templates da Meta          | `src/lib/whatsapp/template-*.ts` (validators, lifecycle, send-builder)          |
| Disparos em massa          | `src/lib/whatsapp/broadcast-*.ts` + `src/lib/broadcasts/` + `src/lib/audience/` |
| Automações no-code         | `src/lib/automations/` (`engine`, `validate`, `schedule`, `window-*`)           |
| Flows (editor visual)      | `src/lib/flows/` + `src/components/flows/`                                      |
| Inbox / atribuição         | `src/lib/inbox/` + `src/components/inbox/`                                      |
| Contatos / importação      | `src/lib/contacts/` (`dedupe`, `parse-contact-csv`, `opt-out`)                  |
| IA (rascunho/auto-reply)   | `src/lib/ai/` + `src/lib/ai/providers/`                                         |
| Permissões / papéis        | `src/lib/auth/roles.ts`, `account.ts`, `api-context.ts`                         |
| API pública                | `src/lib/api/v1/` + `src/app/api/v1/`                                           |
| Webhooks de saída          | `src/lib/webhooks/` (inclui guarda **SSRF**)                                    |
| Painel / métricas          | `src/lib/dashboard/`                                                            |

### Rotas de API que rodam sozinhas (cron)

Três rotas dependem de agendador externo e exigem o header `x-cron-secret` (`AUTOMATION_CRON_SECRET`). **Sem a variável no servidor, respondem `503` de propósito.**

| Rota                    | Responsabilidade                                                          |
| ----------------------- | ------------------------------------------------------------------------- |
| `/api/broadcasts/cron`  | Dispara campanhas agendadas que venceram                                  |
| `/api/automations/cron` | Retoma esperas, gatilho "Baseado em horário", reengajamento de janela 24h |
| `/api/flows/cron`       | Encerra execuções de fluxo abandonadas                                    |

Falha silenciosa: sem cron, o recurso **nunca acontece** e nada quebra visivelmente.

---

## Convenções obrigatórias

**Clientes Supabase — escolher o certo importa (RLS depende disso):**

| Arquivo                      | Uso                               | Cuidado                                                                                             |
| ---------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/lib/supabase/client.ts` | Browser / Client Components       | Sujeito a RLS                                                                                       |
| `src/lib/supabase/server.ts` | Server Components, Route Handlers | Sujeito a RLS, usa cookies da sessão                                                                |
| `src/lib/supabase/admin.ts`  | **service_role** — ignora RLS     | Só em rotas de servidor com autorização já validada. Nunca importar em código que chega ao browser. |

**i18n — toda string visível ao usuário é traduzida:**

- `messages/en.json` é a **fonte da verdade**; `messages/pt-BR.json` espelha a mesma árvore (traduz só os valores, preserva placeholders `{count}`, `{name}`).
- Chave nova em um exige chave nova no outro → `npm run i18n:check` falha se divergir (~1.600 chaves).
- Locale resolvido por cookie `NEXT_LOCALE` + `NEXT_PUBLIC_APP_LOCALE`. **Não existe `/pt-br/...` na URL** — nunca adicione prefixo de locale a rotas.
- Mensagens de `/api/**` ficam em **inglês** (são para integrações); a UI traduz o erro quando necessário.

**Lógica de negócio vive em `src/lib/`, não em componentes.** É o que permite testar sem browser — todo módulo relevante já tem `*.test.ts` co-locado. Ao adicionar regra nova, adicione o teste ao lado.

**Migrações Supabase:** numeração sequencial em `supabase/migrations/` (atual: até `054`; próxima é `055`). Scripts que carregam URL/segredo do deploy específico **não** são migração — vão em `supabase/setup/` (senão o fork de terceiros agendaria chamadas para o seu domínio).

> ⚠️ Existem **três projetos Supabase** neste contexto (MCPs `vn` — padrão, `rs` e `jh`). **Sempre confirmar com o mantenedor antes de aplicar migração** em qualquer um deles.

**Git:** commits e push são executados **manualmente pelo mantenedor**. Agentes devem entregar o comando pronto, não executá-lo.

---

## Armadilhas conhecidas

| Sintoma                                       | Causa provável                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Tela quebrada só em pt-BR (ou só em en)       | Chave ausente em um dicionário — rodar `i18n:check`                                      |
| `INVALID_MESSAGE` no console do browser       | Sintaxe ICU errada em `t.rich()` / placeholder — `typecheck` **não** pega                |
| Agendamento "não dispara", sem erro           | Cron não configurado, ou `AUTOMATION_CRON_SECRET` ausente (rota devolve 503)             |
| Erro de tipo com `t` dentro de `.map()`       | Shadowing de `useTranslations` — renomeie a variável do map                              |
| Build passa em `dev` e falha no host          | `dev` é mais tolerante — sempre rodar `npm run build` antes do push                      |
| Query retorna vazio inesperadamente           | Cliente Supabase errado (RLS barrando) ou membership de conta não resolvida              |
| E-mail de confirmação aponta para `localhost` | **Site URL** do Supabase não trocada para produção (independe de `NEXT_PUBLIC_SITE_URL`) |

---

## Validação local — obrigatória (não há CI neste repositório)

A pasta `.github/` não existe: sem GitHub Actions, sem Dependabot. **A qualidade depende de rodar isto localmente**, na ordem, antes de push/deploy:

```bash
npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build
```

| Comando                | Cobre                                                 |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Desenvolvimento (Turbopack, `localhost:3000`)         |
| `npm run typecheck`    | `tsc --noEmit` — tipos, props, imports                |
| `npm run i18n:check`   | Paridade `en.json` ↔ `pt-BR.json`                     |
| `npm run lint`         | ESLint (React, Next, hooks)                           |
| `npm run test`         | Vitest, uma passada (`test:watch` no loop de dev)     |
| `npm run format:check` | Prettier somente-leitura (`npm run format` reescreve) |
| `npm run build`        | Mesmo passo que o host executa no deploy              |

Guia detalhado (quando e por quê de cada um): [docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md).

---

## Índice da documentação

| Documento                                                                                                | Assunto                                                                       |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [README.md](./README.md)                                                                                 | Visão do produto, deploy, configuração de cron e i18n                         |
| [docs/comandos-desenvolvimento.md](./docs/comandos-desenvolvimento.md)                                   | Comandos npm: o que fazem, quando rodar                                       |
| [docs/public-api.md](./docs/public-api.md)                                                               | API REST pública `/api/v1`                                                    |
| [docs/mcp.md](./docs/mcp.md)                                                                             | Servidor MCP                                                                  |
| [docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md)                               | Arquitetura de i18n                                                           |
| [docs/teste-ab-disparos.md](./docs/teste-ab-disparos.md)                                                 | Teste A/B de templates com significância estatística                          |
| [docs/spec-040-media-privada.md](./docs/spec-040-media-privada.md)                                       | Mídia privada                                                                 |
| [docs/spec-041-atribuicao-fora-do-inbox.md](./docs/spec-041-atribuicao-fora-do-inbox.md)                 | Atribuição fora do inbox                                                      |
| [docs/spec-042-supervisao-e-escopo-de-contatos.md](./docs/spec-042-supervisao-e-escopo-de-contatos.md)   | Supervisão e escopo de contatos                                               |
| [docs/spec-043-quadro-de-atribuicao.md](./docs/spec-043-quadro-de-atribuicao.md)                         | Quadro de atribuição                                                          |
| [docs/spec-044-audiencia-multiformato-e-triagem.md](./docs/spec-044-audiencia-multiformato-e-triagem.md) | Audiência multiformato e triagem                                              |
| [docs/spec-045-reengajamento-janela-24h.md](./docs/spec-045-reengajamento-janela-24h.md)                 | Reengajamento antes da janela de 24h fechar                                   |
| [docs/spec-046-agendamento-visual.md](./docs/spec-046-agendamento-visual.md)                             | Construtor visual do gatilho "Baseado em horário"                             |
| [docs/prd-047-canais-e-whatsapp-qrcode.md](./docs/prd-047-canais-e-whatsapp-qrcode.md)                   | **PRD** — camada de canais + WhatsApp QRCode (Evolution Go)                   |
| [docs/spec-048-canal-whatsapp-qrcode.md](./docs/spec-048-canal-whatsapp-qrcode.md)                       | **SPEC** — canal WhatsApp QRCode: fundação, adaptador, plano de teste         |
| [docs/spec-049-inbox-multicanal-e-motores.md](./docs/spec-049-inbox-multicanal-e-motores.md)             | **SPEC** — inbox multicanal (F5) e motores cientes de canal (F6)              |
| [docs/references/EVOLUTION_GO_REFERENCE.md](./docs/references/EVOLUTION_GO_REFERENCE.md)                 | Referência da API Evolution Go (⚠️ incompleta — ver SPEC 048 §1)              |
| [docs/spec-050-padronizacao-telefone-br.md](./docs/spec-050-padronizacao-telefone-br.md)                 | **SPEC** — padronização de telefone + validação brasileira (DDD/celular/fixo) |
| [docs/context/phone-number-format-standard.md](./docs/context/phone-number-format-standard.md)           | Padrão de formato de telefone — mapeamento de todos os pontos de entrada      |
| [docs/spec-051-exportacao-de-contatos.md](./docs/spec-051-exportacao-de-contatos.md)                     | **SPEC** — exportação de contatos em CSV/XLSX (campos, escopo, auditoria)     |
| [docs/spec-inbox-tag-management.md](./docs/spec-inbox-tag-management.md)                                 | Gestão de etiquetas dentro do inbox                                           |
| [docs/spec-inbox-tabs-assignment.md](./docs/spec-inbox-tabs-assignment.md)                               | Abas do inbox e atribuição                                                    |
| [docs/spec-inbox-kanban-integration.md](./docs/spec-inbox-kanban-integration.md)                         | Integração inbox ↔ funil kanban                                               |
| [docs/spec-settings-tag-editing.md](./docs/spec-settings-tag-editing.md)                                 | Edição de etiquetas em Configurações                                          |
| [docs/templates_email_send/](./docs/templates_email_send/)                                               | Templates de e-mail transacional do Supabase                                  |
| [docs/issues_resolved/](./docs/issues_resolved/)                                                         | Histórico de problemas resolvidos                                             |
| [supabase/setup/cron-jobs.sql](./supabase/setup/cron-jobs.sql)                                           | Script pronto de agendamento via Supabase Cron                                |
| [n8n_automation/README.md](./n8n_automation/README.md)                                                   | Ingestão de contatos e integrações externas via n8n                           |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                     | Fluxo de contribuição                                                         |

---

## Diretrizes técnicas

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
