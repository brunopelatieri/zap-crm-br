# SPEC 053 — Validação e deploy do fluxo de redefinição de senha (Supabase Auth)

| Campo      | Valor                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------- |
| Status     | **Em validação — 3 bugs/achados: origin (deployado), middleware apagando o code-verifier (deployado), scanner de link consumindo o token (página de confirmação pronta, aguardando commit + deploy + colar template no dashboard + reteste)** |
| Escopo     | Validação de configuração + teste end-to-end. **Não é criação de página nova** (ver §2)    |
| Migração   | Nenhuma — mudança é de configuração no dashboard do Supabase, não de schema               |
| Projeto(s) | `vn` (produção) é o alvo desta SPEC. `rs`/`jh` ficam fora até D-1 decidir o contrário      |
| Data       | 2026-08-17                                                                                 |

---

## 1. O problema, em uma frase

O pedido original era "criar a página de nova senha" — mas ela **já existe, já foi codificada e
já foi ajustada uma vez** (commit `009d5c1`, i18n PT/EN completo). O problema real é que **esse
fluxo nunca foi validado ponta a ponta em produção**, e a configuração do Supabase Auth
(`vn`) hoje só tem a Site URL de produção cadastrada — sem entradas na allowlist de *Redirect
URLs* — o que é o suspeito nº1 para o link do e-mail não devolver o usuário para a tela certa.

### 1.1 O que NÃO é o problema

- Não falta componente, não falta rota, não falta chave de i18n.
- Não é um redesenho de UX — o formulário de `/reset-password` já cobre os estados necessários
  (erro, sucesso, loading).
- Não é o template de e-mail — o HTML de "Redefinição de senha" já está desenhado e documentado.

---

## 2. Estado atual (verificado no código em 2026-08-17)

| Peça                          | Arquivo                                                                                     | Situação                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Solicitar link                | [`forgot-password/page.tsx`](../src/app/(auth)/forgot-password/page.tsx)                     | ✅ chama `resetPasswordForEmail` com `redirectTo: origin/auth/callback?next=/reset-password` |
| Trocar `code` por sessão       | [`auth/callback/route.ts`](../src/app/auth/callback/route.ts)                                | ✅ `exchangeCodeForSession`, redireciona para `next` (com allowlist de path relativo) |
| Formulário de nova senha       | [`reset-password/page.tsx`](../src/app/(auth)/reset-password/page.tsx)                       | ✅ `updateUser({password})`, valida tamanho/confirmação, mapeia erros do Supabase, faz `signOut()` global ao final |
| Gate de acesso                 | [`middleware.ts:78-92`](../src/middleware.ts)                                                | ✅ `/reset-password` exige sessão válida (recovery), redireciona sem sessão |
| i18n                            | `messages/{en,pt-BR}.json` → `ResetPasswordPage`, `ForgotPasswordPage`                       | ✅ paridade completa, inclusive chaves de erro específicas do Supabase     |
| Template de e-mail              | [`zap-crm-br_supabase_email_templates.md` §5](../docs/templates_email_send/zap-crm-br_supabase_email_templates.md) | ✅ HTML pronto, usa `{{ .ConfirmationURL }}`                              |
| **Redirect URLs no Supabase**   | Dashboard `vn` → Authentication → URL Configuration                                          | ✅ **`https://vn.local.ia.br/auth/callback` cadastrada pelo mantenedor (local + produção, 2026-08-17)** |
| **Teste end-to-end em produção**| —                                                                                             | ❓ **sem evidência de que já rodou uma vez do início ao fim — pendente (F4)** |

O `{{ .ConfirmationURL }}` do template resolve para
`{SUPABASE_URL}/auth/v1/verify?token=...&type=recovery&redirect_to=<valor enviado em redirectTo>`.
O Supabase **só honra o `redirect_to`** se ele bater com uma entrada na allowlist de
*Additional Redirect URLs*; caso contrário, ignora o parâmetro e manda o usuário para a Site
URL "crua" — que não é `/auth/callback`, então o `code` nunca vira sessão e `/reset-password`
nunca é alcançável com sessão válida.

---

## 2.1. Bug real encontrado ao testar em produção (2026-08-17)

Com a Redirect URL já cadastrada (D-1/D-2/D-3 ratificados), o mantenedor rodou o passo 4 do §6
em produção e o navegador chegou em `https://0.0.0.0:3000/login?error=auth_callback_failed` —
ou seja, `/auth/callback` **entrou no branch de erro** e, além disso, montou o redirect com o
endereço interno de bind do processo Next.js (`0.0.0.0:3000`) em vez de `https://vn.local.ia.br`.

**Causa raiz:** [`auth/callback/route.ts`](../src/app/auth/callback/route.ts) usava
`request.nextUrl.origin` para montar a URL de redirect. No deploy da Hostinger (Node.js
gerenciado, proxy reverso na frente do processo), o cabeçalho `Host` cru que chega ao processo
Next nem sempre reflete o domínio público — o proxy expõe o hostname real via
`X-Forwarded-Host`/`X-Forwarded-Proto`, não via `Host`. Essa mesma armadilha já tinha sido
resolvida em [`/api/account/invitations/route.ts`](../src/app/api/account/invitations/route.ts)
(função `getBaseUrl`), que prioriza os headers forwarded — mas `auth/callback/route.ts` nunca
tinha sido atualizada para o mesmo padrão.

**Correção aplicada:**

- Novo helper [`src/lib/http/request-origin.ts`](../src/lib/http/request-origin.ts)
  (`resolveRequestOrigin`), com teste co-locado, extraindo a mesma ordem de resolução já
  comprovada em produção pelo endpoint de convites: `NEXT_PUBLIC_SITE_URL` explícita →
  `X-Forwarded-Host`/`X-Forwarded-Proto` → `Host` header + protocolo da requisição → fallback.
- `auth/callback/route.ts` agora usa `resolveRequestOrigin(request, request.nextUrl.origin)` em
  vez de `request.nextUrl.origin` puro; `request.nextUrl.origin` vira só o fallback de último
  caso.
- Validado localmente: `npx vitest run` (1690/1690 passando), `npx tsc --noEmit` limpo,
  `npm run lint` sem erros novos, `npm run build` verde.
- **Ainda não commitado nem deployado** — precisa ir para produção antes de repetir o passo 4
  do §6.

**Nota para fora do escopo:** `middleware.ts` usa `request.nextUrl.clone()` para montar os
redirects internos do gate de autenticação (`/login`, `/dashboard`), herdando o mesmo
`request.nextUrl` — se esse componente também for afetado pelo Host cru em algum cenário, é uma
investigação separada; não foi reportado nenhum sintoma ali e fica fora do escopo desta SPEC
(ver §3.1).

### 2.1.1 Segundo achado: `error=auth_callback_failed` persiste mesmo com o domínio correto

Reanalisando o teste do passo 4: o parâmetro `error=auth_callback_failed` **já estava presente**
mesmo antes da correção do domínio — ou seja, o bug de origin (acima) não é a causa única. Um
segundo teste, em produção no domínio `jh.local.ia.br` (projeto Supabase `jh`, que espelha `vn`),
confirmado pelo mantenedor como feito **no mesmo navegador/aba** que a solicitação de reset,
reproduziu o mesmo erro.

**Evidência dos Auth logs do projeto `jh`** (`mcp__jh__query_logs`, janela 18:06–18:12 UTC de
2026-08-17):

- `POST /recover` → `200` às 18:06:53 (solicitação aceita).
- `GET /verify` → `303` às 18:07:02 (token do e-mail válido, Supabase redirecionou de volta para
  `/auth/callback` com sucesso).
- **Nenhuma chamada subsequente a `/token` (troca do código PKCE) aparece nos logs** — nem de
  sucesso, nem de erro.

Isso indica que a requisição chegou em `auth/callback/route.ts`, mas `exchangeCodeForSession`
falhou **antes de qualquer chamada de rede ao Supabase** — comportamento típico do SDK
(`@supabase/ssr`/`auth-js`) quando não encontra o cookie `code_verifier` do PKCE na requisição, e
lança o erro localmente sem tentar a troca. Como o mantenedor confirmou ter clicado o link no
mesmo navegador/aba (descartando a causa mais comum — abrir o link em outro dispositivo/app de
e-mail), a causa exata do cookie ausente/não lido precisou de instrumentação para ser confirmada.

**Instrumentação adicionada** (2026-08-17): `auth/callback/route.ts` passou a logar no servidor
(nunca o `code` nem o valor do cookie, só metadados) — `message`/`status`/`code` do erro quando
`exchangeCodeForSession` falha, ou a lista de nomes de cookies presentes quando `code` nem chega
na query string. Depois do deploy, o log real capturado foi:

```
[auth/callback] exchangeCodeForSession failed {"message":"PKCE code verifier not found in
storage. This can happen if the auth flow was initiated in a different browser or device, or if
the storage was cleared. For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr on both
the server and client to store the code verifier in cookies.","status":400,"code":"pkce_code_verifier_not_found"}
```

O mantenedor também confirmou, inspecionando DevTools → Application → Cookies logo após submeter
`/forgot-password`, que o cookie `sb-<ref>-auth-token-code-verifier` **é gravado corretamente**
no navegador (`SameSite=Lax`, `path=/`, sem `domain` customizado, validade até 2027) — ou seja, a
gravação no client não é o problema.

### 2.1.2 Causa raiz confirmada: `middleware.ts` apaga o cookie antes da troca

Rastreado até o código-fonte instalado de `@supabase/auth-js`
(`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js`, método `_getUser`, linha ~2637):
quando `getUser()` encontra uma sessão cujo JWT não corresponde mais a uma sessão ativa no banco
(`AuthSessionMissingError` — típico de uma sessão revogada/expirada, mas com o cookie ainda
presente no navegador), o SDK roda uma limpeza que **remove tanto o cookie de sessão quanto o
cookie `-code-verifier`**:

```js
if (isAuthSessionMissingError(error)) {
  await this._removeSession();
  await removeItemAsync(this.storage, `${this.storageKey}-code-verifier`);
}
```

[`src/middleware.ts`](../src/middleware.ts) chama `supabase.auth.getUser()` em **toda
requisição** que bate no matcher (praticamente todas as rotas, incluindo `/auth/callback`) —
mas nenhum dos três gates do middleware (redirecionar logado para fora de `/login`, redirecionar
deslogado para fora de rota protegida, bloquear `/api/whatsapp/*` sem sessão) **se aplica a
`/auth/callback`**. Ou seja: o `getUser()` rodava ali sem nenhum propósito — e, quando o
navegador de teste carregava um cookie de sessão obsoleto (bem provável, já que o mantenedor
testa a própria conta em produção há dias, com vários logins/logouts), esse `getUser()` apagava o
`code-verifier` **antes** de `auth/callback/route.ts` (que roda depois do middleware) conseguir
ler o mesmo cookie para `exchangeCodeForSession`.

**Correção aplicada:** [`src/middleware.ts`](../src/middleware.ts) agora retorna cedo
(`NextResponse.next()`) para `pathname === '/auth/callback'`, antes de instanciar o client do
Supabase ou chamar `getUser()` — pulando o gate inteiro para essa rota, já que nenhum gate se
aplica a ela mesmo. Teste de regressão adicionado em
[`src/middleware.test.ts`](../src/middleware.test.ts) (`getUser()` nunca é chamado para
`/auth/callback`).

**Validado:** `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (1691/1691), `npm run build` —
todos limpos. **Commitado e deployado** junto com o bug 2.1.1 (ver §8).

### 2.1.3 Terceiro achado, pós-deploy: scanner de link de e-mail consumindo o token

Depois do deploy da correção do middleware, o mantenedor testou de novo em produção (`vn`) e o
erro mudou de assinatura — não é mais `pkce_code_verifier_not_found`. O link do botão do e-mail
(gerado por `{{ .ConfirmationURL }}`) aponta para
`{SUPABASE_URL}/auth/v1/verify?token=pkce_...&type=recovery&redirect_to=...`; ao clicar, o
navegador caiu direto em `.../login?error=auth_callback_failed#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=`
— ou seja, o `/verify` do próprio Supabase já rejeitou o token como usado/expirado, **antes** de
qualquer código do app entrar em ação (o `#error=...` na URL final é o fragment original da
resposta de erro do Supabase, preservado pelo navegador através do redirect para `/login` que o
`auth/callback/route.ts` faz quando não recebe `code`).

**Evidência nos Auth logs do `vn`** (três tentativas seguidas, 18:06/19:21/19:24 UTC de
2026-08-17): em cada uma, **duas chamadas a `/verify` chegam quase no mesmo segundo** — uma com
`303` (sucesso, consome o token) e outra com `403 "One-time token not found"` (chega depois,
token já gasto). Como os tokens de recovery do Supabase são de uso único, isso indica que **duas
requisições diferentes** disputam o mesmo link quase ao mesmo tempo — assinatura clássica de um
scanner de segurança de e-mail (Microsoft Defender "Safe Links", proxy corporativo, ou
pré-carregamento do próprio cliente de e-mail) fazendo um `GET` automático no link antes (ou
juntamente com) o clique real do usuário.

**Correção aplicada** (mudança de arquitetura, fora do escopo original da SPEC 053, mas
autorizada pelo mantenedor após a explicação do achado):

- Nova página [`src/app/auth/confirm/page.tsx`](../src/app/auth/confirm/page.tsx) — recebe
  `token_hash`, `type` e `next` na query string e só chama `supabase.auth.verifyOtp({type,
token_hash})` no clique de um botão, nunca no carregamento da página. Um scanner que faz `GET`
  nessa URL só carrega a página (inofensivo); o token só é gasto quando um humano clica.
- Template "Reset Password" ([`docs/templates_email_send/...md`](./templates_email_send/zap-crm-br_supabase_email_templates.md)
  §5) trocado de `{{ .ConfirmationURL }}` para
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=%2Freset-password`.
  Os outros 5 templates (signup, invite, magic link, change email, reauthentication) **continuam
  em `.ConfirmationURL`** — migrá-los é trabalho futuro, não desta SPEC.
- [`src/middleware.ts`](../src/middleware.ts) ganhou a mesma exceção de `/auth/callback` para
  `/auth/confirm` (mesmo raciocínio do bug 2.1.2 — nenhum gate se aplica, e `getUser()` não deve
  rodar em rotas de troca de token).
- Novas chaves i18n em `messages/{en,pt-BR}.json` → `AuthConfirmPage` (paridade confirmada por
  `npm run i18n:check`). Novo mapeamento `otp_expired` → `errorLinkExpired` em
  [`src/lib/auth/error-messages.ts`](../src/lib/auth/error-messages.ts).
- Testes de regressão em [`src/middleware.test.ts`](../src/middleware.test.ts).

**Validado:** `npx tsc --noEmit`, `npm run i18n:check`, `npm run lint`, `npx vitest run`
(1695/1695), `npm run format:check`, `npm run build` — todos limpos. **Ainda não commitado.**

**Ação necessária no dashboard do Supabase (`vn`):** colar o HTML atualizado do template "Reset
Password" em Authentication → Emails → Reset Password → Source. Sem isso, o e-mail continua
saindo com o link antigo (`.ConfirmationURL`) mesmo com o código do app já deployado.

---

## 3. Objetivo

1. Confirmar (ou corrigir) a allowlist de Redirect URLs do projeto `vn` para incluir o padrão de
   callback da aplicação.
2. Rodar o fluxo completo em produção pelo menos uma vez, do clique em "Esqueci minha senha" até
   o login com a senha nova — com evidência (prints/logs), não só leitura de código.
3. Documentar o resultado (o que estava configurado, o que foi mudado, se mudou) para não
   repetir a investigação da próxima vez que um fluxo de e-mail do Supabase quebrar em silêncio.

### 3.1 Fora de escopo

- Alterar o layout/UX das páginas `forgot-password` ou `reset-password`.
- Mexer nos projetos `rs`/`jh` (a menos que D-1 decida replicar a configuração nos três).
- Qualquer outro fluxo de e-mail do Supabase (confirmação de cadastro, convite, magic link,
  troca de e-mail, OTP) — só entram se a checagem da allowlist revelar que também estão afetados,
  e mesmo assim como nota, não como trabalho desta SPEC.

---

## 4. Decisões

> D-1 a D-3 ratificados pelo mantenedor em 2026-08-17: a URL de confirmação
> `https://vn.local.ia.br/auth/callback` foi cadastrada manualmente no dashboard do projeto `vn`,
> tanto no ambiente local quanto em produção — exatamente como proposto abaixo.

### D-1 — Qual(is) projeto(s) Supabase validar

**Ratificado:** só `vn`, porque é o único com URL de produção real configurada hoje
(`https://vn.local.ia.br`). `rs` e `jh` não têm domínio de produção próprio nesta SPEC — se e
quando tiverem, replica-se a mesma checagem lá.

### D-2 — Padrão da Redirect URL a cadastrar

**Ratificado:** cadastrada `https://vn.local.ia.br/auth/callback` como entrada exata (não
wildcard). O app só gera `redirectTo` para esse único path (`/auth/callback?next=...`) em todos
os fluxos que o usam (reset de senha, convite — ver `join/[token]`), então uma entrada exata é
suficiente e mais segura que `https://vn.local.ia.br/**`, que abriria redirect para qualquer path
do domínio.

### D-3 — Quem aplica a mudança de configuração

**Ratificado:** o mantenedor aplicou manualmente no dashboard (Authentication → URL Configuration →
Add URL) em 2026-08-17, porque nenhuma ferramenta MCP disponível expõe leitura/escrita dessa
config — só `execute_sql`, `apply_migration` etc., que não alcançam configuração de Auth. O
agente confirma o resultado depois via teste funcional (§6), não via leitura direta da config.

### D-4 — Quem roda o teste end-to-end

**Ratificado:** o mantenedor executa o roteiro do §6 manualmente (precisa de acesso à caixa de
e-mail real para clicar no link recebido) e reporta cada etapa. O agente pode preparar o roteiro
e revisar logs (`query_logs` do projeto `vn`) durante a execução, mas não tem como reproduzir a
etapa "clicar no link do e-mail" sozinho.

---

## 5. Plano de validação

| Fase | O quê                                                                                       | Quem          | Status |
| ---- | -------------------------------------------------------------------------------------------- | ------------- | ------ |
| F1   | Conferir Authentication → URL Configuration no dashboard `vn`: Site URL e Redirect URLs atuais | Mantenedor    | ✅ concluída (2026-08-17) |
| F2   | Se `https://vn.local.ia.br/auth/callback` não estiver na allowlist, adicionar (D-2)          | Mantenedor    | ✅ concluída (2026-08-17, local + produção) |
| F3   | Confirmar que o template "Reset Password" em Authentication → Emails está colado (§5 do doc de templates, **versão nova** com `/auth/confirm`) | Mantenedor    | ❓ pendente — template mudou (§2.1.3), precisa recolar |
| F3.1 | **[Novo]** Corrigir `auth/callback/route.ts` para não usar `request.nextUrl.origin` cru (bug §2.1) | Agente        | ✅ commitado e deployado (2026-08-17, commits `4e98a66`/`3ac64ed`) |
| F3.2 | **[Novo]** Corrigir `middleware.ts` para pular `/auth/callback` (bug §2.1.2 — causa raiz confirmada) | Agente        | ✅ commitado e deployado (2026-08-17) |
| F3.3 | **[Novo]** Página `/auth/confirm` + template novo, contra scanner de link (§2.1.3) | Agente        | ✅ código pronto e validado (2026-08-17) — falta commit + deploy + colar template (F3) |
| F4   | Rodar o roteiro de teste manual (§6) em produção — **repetir após F3.3 e F3 estarem em produção** | Mantenedor    | ❓ pendente (bloqueado por F3.3 + F3) |
| F5   | Se algo falhar, revisar `query_logs` do projeto `vn` (Auth logs) para achar a causa           | Agente         | — (só se F4 falhar) |
| F6   | Atualizar esta SPEC com o resultado (Status → Concluída) e a config final                    | Agente        | pendente |

---

## 6. Roteiro de teste manual (produção, `vn.local.ia.br`)

1. Abrir `/forgot-password` em aba anônima, informar um e-mail de teste com acesso real à caixa.
2. Confirmar que a tela de sucesso aparece ("Verifique seu e-mail").
3. Abrir a caixa de entrada, localizar o e-mail "Redefina sua senha" (verificar remetente/SMTP
   configurado, layout do template).
4. Clicar no botão "Redefinir senha" do e-mail.
5. **Ponto crítico:** confirmar que o navegador chega em `/reset-password` **já autenticado**
   (não em `/login` nem em `/dashboard` — isso indicaria que o `redirect_to` foi ignorado, ver §2).
6. Preencher nova senha (≥ 6 caracteres) + confirmação, submeter.
7. Confirmar tela de sucesso e que o clique em "Ir para o login" leva a `/login`.
8. Fazer login com a **senha nova** — deve funcionar.
9. Tentar login com a senha **antiga** — deve falhar (prova que `updateUser` + `signOut` global
   realmente invalidou a sessão anterior).
10. Repetir o passo 1–5 usando o **mesmo link de e-mail já usado uma vez** — deve falhar
    (link de recovery do Supabase é single-use; confirma que não há reuso indevido).

Qualquer falha nos passos 5, 8 ou 9 aponta para a allowlist de Redirect URLs (§2) como causa
mais provável — não para bug de código, dado que o código já foi revisado nesta SPEC.

---

## 7. Riscos

- **Allowlist mal configurada (URL errada ou wildcard largo demais):** abre a porta para
  *open redirect* via `redirect_to` manipulado — por isso D-2 propõe URL exata, não wildcard.
- **SMTP com throttling/reputação:** se o e-mail não chegar, o problema é de infraestrutura de
  envio, não desta SPEC — mas vale checar Authentication → Logs no dashboard se o passo 3 falhar.
- **Teste em produção real:** não há ambiente de staging para o `vn`; o roteiro do §6 roda contra
  dados reais. Usar e-mail de teste dedicado, não uma conta de cliente.

---

## 8. Próximos passos

1. ~~Mantenedor ratifica D-1 a D-4 (ou ajusta).~~ ✅ ratificado em 2026-08-17 — Redirect URL
   `https://vn.local.ia.br/auth/callback` cadastrada em local e produção.
2. ~~Corrigir o bug de origin (§2.1).~~ ✅ commitado (`4e98a66`) e deployado em 2026-08-17 —
   confirmado pelo teste em produção que passou a mostrar o domínio certo na URL de erro.
3. ~~Investigar a causa raiz do `auth_callback_failed` persistente (§2.1.1–2.1.2).~~ ✅ causa raiz
   confirmada e corrigida em 2026-08-17 — `middleware.ts` chamava `getUser()` em `/auth/callback`
   sem necessidade, e essa chamada apagava o cookie `code-verifier` quando havia uma sessão
   obsoleta no navegador. Commitado e deployado.
4. ~~Investigar o `otp_expired` pós-deploy (§2.1.3).~~ ✅ causa identificada (scanner de link
   consumindo o token de uso único) e correção de arquitetura implementada: página
   `/auth/confirm` + template novo + exceção no middleware. Validado (typecheck, i18n:check,
   lint, 1695 testes, format:check, build) — **falta o mantenedor revisar, commitar, fazer
   deploy, e colar o template atualizado no dashboard do Supabase (`vn` → Authentication →
   Emails → Reset Password → Source, HTML em** [`docs/templates_email_send/...md` §5](./templates_email_send/zap-crm-br_supabase_email_templates.md)**).**
5. Após deploy + template colado, mantenedor repete o roteiro de teste manual do §6 em produção,
   reportando o resultado de cada passo.
6. Se algum passo do §6 falhar (principalmente 5, 8 ou 9), revisar `query_logs` (Auth logs) do
   projeto `vn` para achar a causa (F5).
7. Ao concluir F4 com sucesso, atualizar o Status no topo desta SPEC para **Concluída** (F6).
