# ZAP CRM BR — CRM para WhatsApp feito para o mercado brasileiro

> CRM para WhatsApp **100% em português do Brasil**, auto-hospedável e
> pensado para times brasileiros — caixa de entrada compartilhada,
> contatos, funis de vendas, disparos em massa e automações no-code.
> Interface traduzida, moeda BRL nativa e fluxos alinhados ao WhatsApp
> Business no Brasil. Faça o fork, personalize, hospede.

---

[Licença: MIT](./LICENSE)
[CI](https://github.com/brunopelatieri/zap-crm-br/actions/workflows/ci.yml)
[Idioma: pt-BR](./docs/i18n-implementation-report.md)
[i18n: next-intl](./docs/i18n-implementation-report.md)
[Next.js 16](https://nextjs.org)
[Supabase](https://supabase.com)
[Stars](https://github.com/brunopelatieri/zap-crm-br/stargazers)

Este repositório é o produto — clone ou faça o fork para rodar o seu
próprio CRM **em português**, com suporte opcional a inglês para times
internacionais. A interface, os rótulos de negócio e a experiência de
configuração foram localizadas para o **mercado brasileiro**.

---



## Feito para o Brasil — interface em português (pt-BR)

O **ZAP CRM BR** não é só um fork traduzido: a internacionalização
(i18n) é parte central do produto. Toda a experiência do painel —
login, caixa de entrada, contatos, funis, disparos, automações,
configurações e assistente de IA — está disponível em **português do
Brasil (**`pt-BR`**)**, com mais de **1.600 chaves** de tradução
mantidas em paridade automática no CI.


|                             |                                                                            |
| --------------------------- | -------------------------------------------------------------------------- |
| **Idioma recomendado**      | Português do Brasil (`pt-BR`)                                              |
| **Onde trocar no app**      | **Configurações → Aparência → Idioma**                                     |
| **Idioma padrão no deploy** | `NEXT_PUBLIC_APP_LOCALE=pt-BR` no `.env`                                   |
| **Persistência**            | Cookie por dispositivo (sem mudar a URL)                                   |
| **Idioma alternativo**      | Inglês (`en`) — útil para times multilíngues                               |
| **Especificação técnica**   | [docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md) |


**Por que isso importa para o mercado brasileiro**

- Onboarding e operação diária **sem barreira de idioma** para
atendentes, vendedores e gestores.
- Terminologia alinhada ao dia a dia de CRM no Brasil: *funil*,
*disparo*, *negócio*, *etiqueta*, *caixa de entrada*.
- **Real (BRL)** como moeda padrão em negócios e painéis.
- Fluxos de convite, cadastro e recuperação de senha em português —
primeira impressão profissional para clientes e equipe.

Para colocar o CRM **já em português na primeira visita**, configure:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

O usuário ainda pode alternar para inglês em **Configurações →
Aparência → Idioma**; a escolha fica salva no navegador.

---



## Créditos

> Este projeto é um fork/derivado do repositório original
> [wacrm](https://github.com/ArnasDon/wacrm) desenvolvido por
> [ArnasDon](https://github.com/ArnasDon). Todos os créditos pelo core
> original da aplicação pertencem ao autor original. As modificações,
> **localização para o mercado brasileiro**, internacionalização
> (i18n) e evolução deste projeto sob o nome **ZAP CRM BR** são
> mantidas por [Bruno Pelatieri](https://github.com/brunopelatieri) no
> repositório [zap-crm-br](https://github.com/brunopelatieri/zap-crm-br).

---



## O que você recebe — tudo pensado para operar em português

- **Caixa de entrada compartilhada** na API oficial do WhatsApp
Business — vários atendentes no mesmo número, atribuição por
conversa, status (aberta / pendente / encerrada) e anotações internas.
- **Contatos + etiquetas + campos personalizados** — importação via
CSV, deduplicação e busca por nome, telefone ou e-mail.
- **Funis de vendas (Kanban)** — negócios vinculados às conversas,
etapas personalizáveis e totais em **Real (BRL)**.
- **Disparos em massa** — templates aprovados pela Meta, funil de
entrega e leitura, personalização de variáveis por destinatário.
- **Automações no-code** — gatilhos por mensagem recebida, novo
contato, palavra-chave ou horário; ramificações, esperas, etiquetas
e webhooks. Construtor visual com rótulos em português.
- **Assistente de respostas com IA** — traga sua chave OpenAI ou
Anthropic (criptografada; sem taxa por assento). Gere rascunhos na
caixa de entrada, resposta automática opcional com limite por
conversa e handoff limpo para humano. **Base de conhecimento** em
português (FAQs, políticas, catálogo).
- **Painel em tempo real** — tempo de resposta, volume diário, valor
do funil e feed de atividades entre módulos.
- **Contas de equipe** — convite por link, papéis (proprietário /
admin / atendente / visualizador) e caixa compartilhada para todo o
time.
- **Gestão de conta** — perfil, e-mail, senha, avatar e logout em
todos os dispositivos.
- **API REST pública** (`/api/v1`) — chaves escopadas para integrar
com Zapier, n8n ou sistemas próprios. Veja
[docs/public-api.md](./docs/public-api.md).
- **Servidor MCP** — controle o CRM pelo Claude, Cursor e outros
assistentes via [Model Context Protocol](https://modelcontextprotocol.io).
Veja [docs/mcp.md](./docs/mcp.md).

---



## Por que fazer fork disso?

Isto é um **template**, não um SaaS fechado. Fazer o fork significa:

- **Propriedade total** — seu código, seu Supabase, seu domínio, seus
dados. Sem lock-in, sem cobrança por assento.
- **CRM em português de fábrica** — não é adaptação superficial: dicionário
`pt-BR` completo, seletor de idioma e CI que garante paridade com o
inglês. Ideal para agências, SaaS B2B e operações de atendimento no
Brasil.
- **Customização total** — adicione campos, remova módulos, estenda
traduções. Stack previsível: Next.js + Supabase + Tailwind.
- **Deploy rápido** — [Hostinger](https://www.hostinger.com/web-apps-hosting)
publica um fork em poucos cliques
([veja abaixo ↓](#-deploy-na-hostinger-recomendado)).
- **Segurança de produção** — AES-256-GCM nos tokens, RLS, webhooks
HMAC, CSP, rate limiting e CI em todo PR (incluindo checagem i18n).

Não é um framework. É um CRM concreto que você coloca no ar em uma
tarde — **em português** — e adapta ao seu negócio.

---



## Início rápido (com interface em português)

```bash
# Fork: https://github.com/brunopelatieri/zap-crm-br → Fork
git clone https://github.com/<seu-usuario>/zap-crm-br.git
cd zap-crm-br
npm install
cp .env.local.example .env.local
```

No `.env.local`, além das credenciais Supabase + Meta, defina:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

```bash
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000). Você será redirecionado para `/login`
(ou `/dashboard` se já estiver autenticado) — **em português do
Brasil**.

---



## 🚀 Deploy na Hostinger (recomendado)





O **ZAP CRM BR** roda na
[Hostinger](https://www.hostinger.com/web-apps-hosting) — caminho
testado para colocar um CRM **em português** em produção sem VPS.

**No hPanel**, inclua entre as variáveis de ambiente:

```env
NEXT_PUBLIC_APP_LOCALE=pt-BR
```



### Por que Hostinger?


|                         |                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Deploy via Git**      | Conecte o fork, push na `main`, build automático.                                                   |
| **Node.js gerenciado**  | Next.js 16 roda nos planos [Premium, Business e Cloud](https://www.hostinger.com/web-apps-hosting). |
| **SSL + domínio**       | HTTPS obrigatório para webhook do WhatsApp Business.                                                |
| **Variáveis no painel** | `SUPABASE_`*, `WHATSAPP_*`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_LOCALE`.                             |
| **Custo acessível**     | Alternativa simples a VPS + banco separado (Supabase).                                              |




### Em 60 segundos

1. **Fork** deste repositório.
2. **hPanel → Websites → Create → Node.js** e conecte o fork.
3. Cole credenciais Supabase + Meta + `NEXT_PUBLIC_APP_LOCALE=pt-BR`.
4. Push na `main`. Pronto — CRM em produção **em português**.

Guia com capturas (documentação original em inglês):
**[wacrm.tech/docs/deployment-hostinger](https://wacrm.tech/docs/deployment-hostinger)**.

> O ZAP CRM BR é MIT e roda em qualquer host Node.js (Vercel, Railway,
> VPS). A Hostinger é recomendada, não obrigatória.

---



## Internacionalização (i18n) — detalhes para desenvolvedores

Arquitetura com `[next-intl](https://next-intl.dev)`: **sem prefixo na
URL** (não existe `/pt-br/dashboard`). O locale é resolvido por cookie

- variável de ambiente.


|                           |                                                             |
| ------------------------- | ----------------------------------------------------------- |
| **Locale principal (BR)** | `pt-BR` — recomendado em todo deploy nacional               |
| **Locale alternativo**    | `en` — mantido para compatibilidade e times globais         |
| **Trocar no app**         | Configurações → Aparência → Idioma                          |
| **Cookie**                | `NEXT_LOCALE` (por dispositivo)                             |
| **Dicionários**           | `messages/pt-BR.json` e `messages/en.json`                  |
| **Paridade de chaves**    | `npm run i18n:check` (também no CI)                         |
| **API REST**              | Mensagens de `/api/`** em inglês (integrações); a UI traduz |
| erros quando necessário   |                                                             |


**Especificação completa (arquitetura, auditoria, fases):**
[docs/i18n-implementation-report.md](./docs/i18n-implementation-report.md)

### Adicionar outro idioma (ex.: espanhol)

1. Inclua o tag em `[src/lib/i18n/locales.ts](./src/lib/i18n/locales.ts)`
  (`SUPPORTED_LOCALES` + `LOCALE_LABELS`).
2. Copie `messages/en.json` → `messages/<locale>.json` e traduza os
  valores (mantenha as chaves e placeholders `{count}`, `{name}`, etc.).
3. Execute `npm run i18n:check` até passar.
4. O seletor em Configurações → Aparência lista o idioma automaticamente.

---



## Documentação

**Neste repositório (português / ZAP CRM BR):**

- [Relatório de implementação i18n](./docs/i18n-implementation-report.md)
- [API pública (](./docs/public-api.md)`/api/v1`[)](./docs/public-api.md)
- [Servidor MCP](./docs/mcp.md)

**Projeto original wacrm (inglês — mesma base técnica):**

- [wacrm.tech/docs](https://wacrm.tech/docs)
- [Primeiros passos](https://wacrm.tech/docs/getting-started)
- [Supabase](https://wacrm.tech/docs/supabase-setup) ·
[WhatsApp](https://wacrm.tech/docs/whatsapp-setup) ·
[Variáveis de ambiente](https://wacrm.tech/docs/environment-variables) ·
[Deploy Hostinger](https://wacrm.tech/docs/deployment-hostinger)

---



## Stack

- **App** — Next.js 16, React 19, TypeScript, Tailwind v4,
**next-intl** (pt-BR + en).
- **Dados** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (WhatsApp Business oficial).

---



## Contribuindo

Template para fork → personalizar → publicar. Bugs e segurança são
bem-vindos; features costumam ficar no seu fork. Veja
`[CONTRIBUTING.md](./CONTRIBUTING.md)` e
`[.github/SECURITY.md](./.github/SECURITY.md)`.

---



## Licença

[MIT](./LICENSE). Faça o fork, personalize, hospede **no Brasil, em
português**.

---

**ZAP CRM BR** é mantido por [Bruno Pelatieri](https://github.com/brunopelatieri)
sobre o core de [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm).
Veja [Créditos](#créditos).