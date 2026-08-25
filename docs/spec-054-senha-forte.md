# SPEC 054 — Verificador e ajudador de criação de senha forte

| Campo      | Valor                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------- |
| Status     | **Implementada (F2–F7) — D-1 a D-8 ratificadas como propostas em 2026-08-17; falta commit + deploy, e F8 (D-7) se o mantenedor quiser espelhar no dashboard do Supabase** |
| Escopo     | Validação de senha (regras + feedback visual) no cadastro e na redefinição de senha; ver §3.1 para o que fica fora |
| Migração   | Nenhuma — mudança é só de código do app. D-7 é opcional e mexe em config do dashboard do Supabase, não em schema |
| Projeto(s) | Código roda igual em qualquer deploy. D-7 (se ratificada) é config manual só do `vn`      |
| Data       | 2026-08-17                                                                                 |

---

## 1. O problema, em uma frase

Hoje só existe checagem de **tamanho mínimo**, e ela é inconsistente entre as três telas que
lidam com senha — nenhuma verifica maiúscula/minúscula/número/símbolo, e nenhuma dá feedback
visual enquanto o usuário digita.

---

## 2. Estado atual (verificado no código em 2026-08-17)

| Peça                                         | Arquivo                                                                          | Regra hoje                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Cadastro                                      | [`signup/page.tsx:62`](<../src/app/(auth)/signup/page.tsx>)                     | `password.length < 6`                          |
| Redefinição (link de e-mail)                  | [`reset-password/page.tsx:41`](<../src/app/(auth)/reset-password/page.tsx>)     | `password.length < 6`                          |
| Troca (Configurações → Perfil)                | [`password-form.tsx:21,40`](../src/components/settings/password-form.tsx)       | `next.length < MIN_PASSWORD` (`MIN_PASSWORD = 8`) |
| Medidor de força / checklist visual           | —                                                                                 | Não existe                                     |
| Biblioteca de análise de força (zxcvbn etc.)  | —                                                                                 | Não instalada                                  |
| Reação a rejeição do servidor                 | [`error-messages.ts:20`](../src/lib/auth/error-messages.ts)                     | Já mapeia `weak_password` → mensagem traduzida — ou seja, o Supabase **já pode** rejeitar senha fraca hoje; só não avisamos **antes** de tentar |

---

## 3. Objetivo

1. Regra única de senha forte, compartilhada pelas telas que criam/trocam senha: mínimo 8
   caracteres, pelo menos 1 maiúscula, 1 minúscula, 1 número e 1 caractere especial de um
   conjunto seguro (ver D-3).
2. Componente visual reutilizável que mostra, ao vivo, quais regras já foram atendidas.
3. Garantir que a exigência de "caractere especial" nunca produza uma senha que quebre no
   Supabase, no Postgres ou no próprio código do app — ver D-3 a D-5 para a análise técnica por
   trás disso.

### 3.1 Fora de escopo

- **zxcvbn / medidor de entropia real** — avaliado e descartado por trade-off (ver D-2): ~800KB
  de dicionário no bundle para um ganho que o modelo de regras já cobre na prática.
- **Bloqueio de senhas vazadas (HaveIBeenPwned)** — recurso nativo do Supabase Auth (Pro plan+),
  não é código nosso. Fica para uma SPEC própria se/quando o plano permitir.
- **MFA** — fora do escopo desta SPEC.
- **Migrar senhas de usuários existentes** — ninguém é forçado a trocar senha; a regra nova vale
  só para cadastro novo e trocas futuras, comportamento padrão do próprio Supabase (ver §7).

---

## 4. Decisões

> D-1 e D-2 foram confirmadas por você antes de eu começar a escrever esta SPEC — documento aqui
> só para registro. D-3 a D-8 são propostas, pendentes de ratificação.

### D-1 — Tamanho mínimo

**Ratificado:** 8 caracteres. (Já era o valor usado em Configurações; agora fica único nas três
telas.)

### D-2 — Classes de caractere obrigatórias

**Ratificado:** maiúscula + minúscula + número + pelo menos 1 caractere especial. Modelo de
**regras/checklist**, não medidor de entropia (zxcvbn) — mais leve, cobre o problema real (senha
óbvia/curta), evita ~800KB de dicionário no bundle só para um ganho marginal num CRM B2B.

### D-3 — Conjunto de caracteres especiais aceito

**Proposta:**

```
! @ # $ % ^ & * ( ) _ + - = [ ] { } : ; , . ? / ~
```

Por que essa lista, e não "qualquer símbolo":

- É um **subconjunto exato** do conjunto que o próprio Supabase usa quando a política "Symbols"
  está ligada no dashboard (`!@#$%^&*()_+-=[]{};'\:"|<>?,./`~`) — ou seja, toda senha aprovada
  aqui também seria aprovada lá, sem surpresa se D-7 for ratificada.
- Excluí de propósito 6 símbolos que o Supabase aceita mas que tiram mais do que dão aqui: aspas
  simples e dupla (`'` `"`), barra invertida (`\`), pipe (`|`), crase (`` ` ``) e os sinais de
  maior/menor (`<` `>`). São os que mais se digita errado no teclado ABNT2, os que apps de texto
  às vezes "corrigem" sozinhos para aspas tipográficas (nunca dentro de `<input
  type="password">`, mas o hábito confunde o usuário), e os que — mesmo não sendo risco real
  aqui, já que senha nunca é interpolada em HTML ou SQL cru neste projeto — não têm motivo pra
  entrar num formulário cujo objetivo é reduzir fricção, não é uma auditoria de pentest.
- Não inclui espaço — ver D-6.

### D-4 — Tamanho máximo e o limite de 72 bytes do bcrypt

**Proposta:** limitar a senha a **72 bytes UTF-8** (calculado com
`new TextEncoder().encode(password).length`, **não** `password.length` — string JS conta
unidades UTF-16, não bytes) e rejeitar acima disso com mensagem clara.

Por que isso importa: o Supabase Auth guarda a senha como hash **bcrypt**
(`auth.users.encrypted_password`, confirmado na documentação oficial), e bcrypt **trunca
silenciosamente em 72 bytes** — limitação conhecida do algoritmo, não um bug do Supabase. Sem
esse limite do nosso lado:

- Um usuário pode digitar uma senha de 100 caracteres achando que é "super forte", mas só os
  primeiros ~72 bytes entram no hash — o resto é decorativo e não aumenta a segurança real.
- Pior: duas senhas diferentes que coincidem nos primeiros 72 bytes (ex.: mesma base + sufixo
  diferente) autenticam com qualquer uma das duas. Improvável na prática, mas é exatamente o
  tipo de coisa que uma SPEC de "senha forte" deveria prevenir, não ignorar.

Calcular em **bytes UTF-8**, não em caracteres, porque acento/ç é comum em senha em português —
cada um ocupa 2 bytes em UTF-8, então 72 caracteres acentuados já passam do limite em bytes antes
de bater 72 caracteres.

### D-5 — Caracteres proibidos (controle) e normalização Unicode

**Proposta:**

- Proibir caracteres de controle (`U+0000`–`U+001F`, `U+007F`), incluindo o byte nulo. O Postgres
  rejeita `U+0000` em colunas de texto (`invalid byte sequence`) — mesmo não sendo nós que
  gravamos a senha diretamente (isso é interno ao Supabase Auth), vale bloquear do nosso lado
  para nunca depender do servidor pegar esse caso.
- Aplicar `password.normalize('NFC')` antes de validar **e** antes de enviar ao Supabase — evita
  que o "mesmo" acento representado de duas formas Unicode diferentes (ex.: `é` como um único
  code point vs. `e` + acento combinante, algo que varia por teclado/SO) produza hashes
  diferentes para o que o usuário via como a mesma senha digitada.

### D-6 — Espaços e "frase-senha"

**Proposta:** permitir espaço no meio da senha (frases como `Cafe Quente 123!` são mais fáceis de
lembrar e mais fortes que senhas curtas com símbolo forçado no fim), mas cortar espaço no
início/fim antes de validar e enviar (`.trim()`) — evita erro de digitação invisível por espaço
colado sem querer (comum ao copiar de um gerenciador de senhas).

### D-7 — Espelhar a política também no dashboard do Supabase (`vn`)

**Proposta:** sim, mas como passo manual e separado do código (Authentication → Providers →
Email → Password Requirements) — igual fizemos com a Redirect URL na SPEC 053. Nenhuma
ferramenta MCP disponível expõe essa config. Sem isso, nossa validação do lado do cliente é só
UX: em teoria dá pra contornar o front chamando a API do Supabase diretamente e cadastrar uma
senha fraca, porque a fronteira de segurança real é o servidor, não a nossa tela. **Fica
pendente** confirmar se o mantenedor quer ativar agora ou depois.

### D-8 — Estender também para Configurações → Trocar senha?

**Proposta:** sim — essa tela hoje usa `MIN_PASSWORD = 8` sem checar complexidade, exatamente a
mesma inconsistência que motivou esta SPEC. Deixar de fora recriaria o problema num terceiro
lugar. O pedido original citou só cadastro e redefinição, então marco isso como decisão explícita
em vez de assumir.

---

## 5. Desenho técnico

### 5.1 `src/lib/auth/password-policy.ts` (novo)

Módulo puro e testável — fonte única da regra, usada pelas três telas:

```ts
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72; // bcrypt trunca acima disso — ver SPEC 054 D-4
export const PASSWORD_SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}:;,.?/~';

export interface PasswordRuleResult {
  minLength: boolean;
  maxBytes: boolean;
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasNumber: boolean;
  hasSpecialChar: boolean;
  noControlChars: boolean;
}

export function evaluatePassword(password: string): PasswordRuleResult { /* ... */ }
export function isPasswordValid(result: PasswordRuleResult): boolean { /* ... */ }

// .trim() (D-6) + .normalize('NFC') (D-5) — chamar antes de validar E antes
// de mandar pro Supabase, nos dois lugares, com o mesmo valor.
export function normalizePassword(password: string): string {
  return password.trim().normalize('NFC');
}
```

Teste co-locado (`password-policy.test.ts`) cobrindo: cada regra isolada, string vazia, exatamente
8 caracteres / 72 bytes (limites), acentos empurrando bytes além de chars, byte nulo rejeitado,
idempotência de `trim`/NFC.

### 5.2 `src/components/auth/password-strength-meter.tsx` (novo)

Client component. Recebe `password: string`, usa `evaluatePassword` e renderiza:

- Checklist (✓/✗ por regra, mesmos ícones já usados no resto do app — `CheckCircle`/`lucide-react`).
- Barra de progresso simples (regras atendidas / total) — sem cálculo de entropia (D-2).

Não decide se o botão de submit fica desabilitado — isso continua responsabilidade de cada
página, mesmo padrão de erro que já existe hoje em cada uma.

### 5.3 Integração nas páginas

- [`signup/page.tsx`](<../src/app/(auth)/signup/page.tsx>),
  [`reset-password/page.tsx`](<../src/app/(auth)/reset-password/page.tsx>) — trocar
  `password.length < 6` por `!isPasswordValid(evaluatePassword(password))`; renderizar
  `<PasswordStrengthMeter password={password} />` abaixo do campo.
- [`password-form.tsx`](../src/components/settings/password-form.tsx) (se D-8 ratificada) —
  mesma troca, remove o `MIN_PASSWORD` local.
- `resetPasswordForEmail` / `updateUser` / `signUp` passam a receber `normalizePassword(password)`,
  nunca o valor cru do input.

### 5.4 i18n

Namespace novo compartilhado `PasswordPolicy` (evita duplicar a mesma checklist em
`SignupPage`/`ResetPasswordPage`/`Settings.profile`):

```json
"PasswordPolicy": {
  "ruleMinLength": "At least {min} characters",
  "ruleUppercase": "One uppercase letter",
  "ruleLowercase": "One lowercase letter",
  "ruleNumber": "One number",
  "ruleSpecialChar": "One special character ({chars})",
  "ruleTooLong": "Password is too long"
}
```

(+ espelho em `pt-BR.json`, paridade confirmada por `npm run i18n:check`.)

---

## 6. Plano

| Fase | O quê                                                                            | Quem       | Status |
| ---- | ---------------------------------------------------------------------------------- | ---------- | ------ |
| F1   | Mantenedor ratifica D-3 a D-8 (ajustando o que quiser)                            | Mantenedor | ✅ ratificadas como propostas (2026-08-17) |
| F2   | `src/lib/auth/password-policy.ts` + teste                                         | Agente     | ✅ 19 testes, cobrindo cada regra + limites de byte/NFC |
| F3   | `src/components/auth/password-strength-meter.tsx`                                 | Agente     | ✅ |
| F4   | Integrar em cadastro + redefinição (+ Configurações, D-8 ratificada)              | Agente     | ✅ 3 telas |
| F5   | i18n (`PasswordPolicy`, en+pt-BR)                                                  | Agente     | ✅ paridade confirmada |
| F6   | `npm run typecheck && i18n:check && lint && test && format:check && build`        | Agente     | ✅ todos limpos (1714 testes) |
| F7   | Teste manual no navegador (preview) das telas afetadas                           | Agente     | ✅ ver §9 |
| F8   | (se D-7) mantenedor espelha a política no dashboard `vn`                          | Mantenedor | ❓ pendente, opcional |

---

## 7. Riscos

- **Usuários existentes com senha fraca continuam logando** — o Supabase só aplica a regra nova
  em cadastro/troca, não retroativamente. Comportamento documentado e esperado do próprio
  Supabase (usuário só esbarra na regra nova se tentar trocar a senha).
- **Divergência cliente/servidor se D-7 for ratificada com valores diferentes dos daqui** — por
  isso a recomendação é espelhar exatamente o mesmo conjunto (D-3) e mínimo (D-1), não "quase".
- **Fricção de cadastro** — exigir 4 classes de caractere pode aumentar abandono no formulário de
  cadastro. Mitigado pelo próprio objetivo desta SPEC (feedback visual ao vivo reduz tentativa às
  cegas), mas vale observar depois do deploy.

---

## 8. Próximos passos

1. ~~Mantenedor ratifica D-3 a D-8.~~ ✅ ratificadas como propostas (2026-08-17).
2. ~~Agente implementa F2–F7.~~ ✅ concluído — ver §9.
3. Mantenedor revisa e commita o código (git é sempre manual), faz deploy.
4. Mantenedor decide e executa F8 (espelhar no dashboard `vn`), se aplicável.

---

## 9. Implementação (2026-08-17)

**Arquivos novos:**

- [`src/lib/auth/password-policy.ts`](../src/lib/auth/password-policy.ts) — `evaluatePassword`,
  `isPasswordValid`, `normalizePassword`, constantes `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_BYTES`/
  `PASSWORD_SPECIAL_CHARS`.
- [`src/lib/auth/password-policy.test.ts`](../src/lib/auth/password-policy.test.ts) — 19 testes:
  cada regra isolada, limite de 8 caracteres e 72 bytes (incluindo acentos empurrando bytes além
  de chars), byte nulo/controle no meio da senha, trim de tab no fim, NFC de acento decomposto,
  `isPasswordValid` falhando se qualquer regra falhar.
- [`src/components/auth/password-strength-meter.tsx`](../src/components/auth/password-strength-meter.tsx)
  — barra de progresso + checklist ao vivo, usa `text-emerald-*` (convenção de "sucesso" já usada
  em `broadcasts`/`flows`/`settings-chip` neste projeto, independente do accent color do tema).

**Arquivos alterados:**

- [`signup/page.tsx`](<../src/app/(auth)/signup/page.tsx>),
  [`reset-password/page.tsx`](<../src/app/(auth)/reset-password/page.tsx>) — trocaram
  `password.length < 6` por `isPasswordValid(evaluatePassword(password))`; renderizam o medidor
  abaixo do campo de senha; botão de submit desabilitado até a senha ser válida e coincidir com a
  confirmação; `normalizePassword()` aplicado antes de `signUp`/`updateUser`.
- [`password-form.tsx`](../src/components/settings/password-form.tsx) (D-8) — removido
  `MIN_PASSWORD = 8` local, agora usa `PASSWORD_MIN_LENGTH` do módulo compartilhado; mesmo padrão
  de medidor + botão desabilitado.
- `messages/en.json` / `messages/pt-BR.json` — novo namespace `PasswordPolicy`; `errorPasswordPolicy`
  substituindo `passwordTooShort` em `SignupPage`/`ResetPasswordPage`; `passwordPolicyNotMet`
  substituindo `passwordTooShort` em `Settings.profile`. Paridade confirmada por `npm run i18n:check`
  (que agora também audita `CODE_TO_MESSAGE_KEY` — ver SPEC 053 §2.1.3 — sem regressão aqui).

**Validado:** `npx tsc --noEmit`, `npm run i18n:check`, `npm run lint`, `npx vitest run`
(1714/1714), `npm run format:check`, `npm run build` — todos limpos.

**Teste manual (preview local, `/signup`):**

1. Senha `abc` → checklist mostra 1/5 regras (minúscula), botão de submit desabilitado.
   Confirmado via `aria-valuenow` da barra de progresso e `button.disabled`.
2. Senha `Cafe Quente 123!` (frase-senha com espaço, D-6) → 5/5 regras, botão habilitado assim
   que a confirmação bate. Confirma que espaço no meio não quebra a validação.
3. Console do navegador sem erros.
4. `/reset-password` sem sessão de recovery redireciona para `/login` (comportamento do
   middleware, não relacionado a esta SPEC) — o medidor ali usa o mesmo componente já validado em
   `/signup`, não testado end-to-end por exigir uma sessão de recuperação real.

**Nota de infraestrutura, fora do escopo desta SPEC:** `.claude/launch.json` foi ajustado para
rodar o dev server na porta 3100 em vez de 3000 — porta 3000 está reservada pelo Windows neste
ambiente e o preview não conseguia abrir. Mudança local, não afeta produção.
