# Falha na criação de templates do WhatsApp (Meta Graph API)

**Data:** 2026-07-24
**Área:** Configurações → Templates de mensagem (WhatsApp Business API)
**Status:** Resolvido

## Sintoma inicial

Ao tentar criar/submeter um template, o front-end quebrava com:

```
Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

Esse erro indica que o `fetch` no navegador recebeu HTML onde esperava JSON — sintoma clássico de resposta de erro de infraestrutura (gateway/404/500) sendo parseada como se fosse JSON da API.

## Investigação

Foi rastreado o circuito completo da criação de template:

1. Front-end (`template-manager.tsx`) → `POST /api/whatsapp/templates/submit`
2. Rota Next.js (`src/app/api/whatsapp/templates/submit/route.ts`)
3. Camada de integração com a Meta Graph API (`src/lib/whatsapp/meta-api.ts`)

Confirmou-se que a rota, o middleware de autenticação e a integração com a Meta já retornavam JSON em todos os caminhos de erro — não havia rota inexistente, redirect HTML nem rewrite indevido. A hipótese mais provável para o HTML era timeout de proxy/gateway na cadeia (download de imagem de cabeçalho → upload resumable → criação do template), que pode levar mais tempo do que o padrão da plataforma de hospedagem.

## Causas identificadas e correções aplicadas

### 1. `res.json()` sem checar `res.ok`/`content-type` (sintoma, não causa raiz)

- **Arquivo:** `src/components/settings/template-manager.tsx`
- Adicionado helper `parseJsonResponse` que valida o `content-type` antes de fazer o parse, evitando que uma resposta HTML de infraestrutura vire uma exceção ilegível — agora vira um erro de HTTP status legível.
- Aplicado nos três pontos de chamada: `handleSubmit`, `handleSyncFromMeta`, `confirmDelete`.

### 2. Ausência de `maxDuration` nas rotas (preventivo)

- **Arquivos:** `src/app/api/whatsapp/templates/submit/route.ts`, `src/app/api/whatsapp/templates/[id]/route.ts`
- Adicionado `export const maxDuration = 60` (mesmo padrão já usado em `webhook/route.ts`), dando margem para a cadeia de chamadas à Meta terminar antes de um timeout de gateway.

### 3. Mensagens de erro da Meta genéricas demais (bloqueador de diagnóstico) — **causa de maior impacto**

- **Arquivo:** `src/lib/whatsapp/meta-api.ts`
- `throwMetaError` só lia `error.message` da resposta da Meta, descartando `error_user_msg` e `error_subcode` — que carregam o motivo real da rejeição.
- Corrigido para compor a mensagem completa (`message: error_user_msg (subcode N)`), o que permitiu identificar os dois bugs reais abaixo em vez de ficar preso no genérico "Invalid parameter".

### 4. Botão `COPY_CODE`: campo `example` no formato errado

- **Arquivo:** `src/lib/whatsapp/template-components.ts`
- O código enviava `example: ["SUMMER20"]` (array), mas a Meta exige **string simples** (`example: "SUMMER20"`) para botões `COPY_CODE` — diferente do botão `URL`, que usa array e já estava correto.
- Confirmado contra a documentação oficial da Meta (developers.facebook.com) antes da correção.
- Erro original da Meta: `Invalid parameter: Button example provided is invalid (subcode 2593027)`.

### 5. Botão `COPY_CODE`: texto customizável indevidamente

- **Arquivos:** `src/lib/whatsapp/template-components.ts`, `src/components/settings/template-manager.tsx`
- A Meta exige que o texto do botão `COPY_CODE` seja **sempre** `"Copy offer code"` — não pode ser customizado. O formulário permitia o usuário digitar qualquer texto para esse botão.
- Corrigido em duas camadas:
  - Backend: `buildButtonPayload` agora força `text: 'Copy offer code'` para `COPY_CODE`, ignorando o que estiver salvo (inclusive templates antigos criados antes do fix).
  - Front-end: `emptyButton('COPY_CODE')` já nasce com esse texto, e o campo de label fica desabilitado na UI quando o tipo do botão é `COPY_CODE`.
- Erro original da Meta: `Invalid parameter: O texto do tipo de botão "COPY_CODE" não pode ser modificado e sempre deve ser "Copy offer code". (subcode 2388153)`.

## Análise Pareto (poucas causas, maior parte do impacto)

**Vitais poucos (≈20% das mudanças → ≈80% do problema resolvido):**

- Item 3 (mensagens de erro da Meta) — sem ele, os itens 4 e 5 ficariam invisíveis por trás de "Invalid parameter" genérico.
- Itens 4 e 5 (bugs reais no botão `COPY_CODE`) — causas determinísticas que bloqueavam 100% das tentativas de criação de template com esse botão.

**Triviais muitos (baixo impacto isolado, robustez geral):**

- Item 1 (parsing defensivo no front-end) — só melhora a mensagem de erro exibida, não era a causa raiz.
- Item 2 (`maxDuration`) — preventivo, nunca confirmado como causa raiz neste caso específico.

## Verificação

- `npx tsc --noEmit` — sem erros.
- `npx eslint` nos arquivos alterados — sem erros.
- `npx vitest run` nos testes de `template-components`, `template-validators` e `template-send-builder` — 68 testes passando (incluindo os dois testes de `COPY_CODE` atualizados para refletir o novo comportamento).

## Arquivos alterados

- `src/app/api/whatsapp/templates/[id]/route.ts`
- `src/app/api/whatsapp/templates/submit/route.ts`
- `src/components/settings/template-manager.tsx`
- `src/lib/whatsapp/meta-api.ts`
- `src/lib/whatsapp/template-components.ts`
- `src/lib/whatsapp/template-components.test.ts`

Nenhum commit foi criado — as alterações seguem no working tree, aguardando revisão do usuário.
