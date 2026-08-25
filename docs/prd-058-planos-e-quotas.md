# PRD 058 — Modelo de planos com quotas

> **Status:** proposta · aguardando ratificação das decisões D-1 a D-9
> **Data:** 2026-08-24
> **Depende de:** 017 (contas/papéis), 047+048 (canais e Evolution), 055–062 (canais)
> **Especificação técnica:** [SPEC 059](./spec-059-motor-de-quotas.md)

---

## 1. Por que agora

A análise "É SaaS ou Self-Hosted?" listou seis lacunas entre o ZAP CRM BR de
hoje e um SaaS: pagamento, **planos com quotas**, suporte comercial, updates
centralizados, LGPD e SLA de uptime. Cinco delas dependem de decisões
comerciais, jurídicas ou de infraestrutura. **Só uma é código e pode ser feita
agora sem depender das outras: o modelo de planos com quotas.**

A ordem não é arbitrária. Sem quota, cobrar não faz sentido — todos os planos
entregariam a mesma coisa e o cliente pagaria pela promessa, não pelo produto.
Com quota, o pagamento pode continuar acontecendo **fora** do sistema (PIX,
boleto, contrato) enquanto o produto já sabe o que cada conta pode fazer. É a
única das seis lacunas que entrega valor sozinha.

Há também um custo real correndo hoje: a Evolution Go roda numa VPS
compartilhada onde cada instância pareada é uma sessão `whatsmeow` viva. Sem
noção de plano, **quem paga R$ 0 consome o mesmo recurso de quem paga**, e o
teto por conta é uma variável de ambiente igual para todo mundo
(`EVOLUTION_MAX_INSTANCES_PER_ACCOUNT`, padrão 3).

---

## 2. O que já existe (e por que isso encurta muito o trabalho)

O repositório não parte do zero. Levantamento do código atual:

| Peça pronta | Onde | O que reaproveitamos |
| --- | --- | --- |
| Multi-tenancy real | `accounts` + `profiles.account_id` + `is_account_member()` + RLS | A conta **já é** a unidade de cobrança. Nenhuma tabela precisa de coluna nova de tenancy. |
| Papéis hierárquicos | `account_role_enum` (owner > admin > agent > viewer), `src/lib/auth/roles.ts` | Quota por papel é contagem sobre `profiles`, não um modelo novo. |
| Teto por conta com *override* | `accounts.evolution_instance_limit` + `src/lib/evolution/limits.ts` | **Já é uma quota**, no formato certo (`COALESCE(override, padrão)`). Vira o primeiro caso do motor genérico. |
| Teto de deployment | `EVOLUTION_MAX_INSTANCES_TOTAL` | Continua existindo — protege a VPS, não é assunto de plano (§6). |
| Cota deslizante com uso medido | `channel_cold_sends` + `src/lib/channels/cold-send-limit.ts` | O padrão "módulo puro decide, banco grava o julgamento" é exatamente o que o motor de quotas precisa. |
| Um canal oficial por conta | `whatsapp_config UNIQUE(account_id)` + índice parcial em `channels` | O limite "1 número Cloud" já é do banco. Falta poder dizer **0** (plano sem oficial). |
| Rate limit por chave de API | `src/lib/rate-limit.ts` | Vira valor de plano quando a API pública virar diferencial pago. |
| Segredo de operação | `x-cron-secret` nas rotas de cron | O mesmo formato serve para as rotas de operador (D-9). |

Conclusão prática: **o que falta não é arquitetura de multi-tenant — é uma
camada de política sobre uma que já isola dados corretamente.**

---

## 3. Objetivo

Permitir que o ZAP CRM BR seja vendido como serviço, com contas em planos
diferentes e limites aplicados de verdade, **sem** introduzir gateway de
pagamento, sem quebrar quem auto-hospeda o projeto e sem tornar o fork
open-source uma versão limitada.

### 3.1. Fora de escopo (explicitamente)

| Não entra | Por quê |
| --- | --- |
| Stripe / Paddle / PIX automatizado | Cobrança segue externa. O schema já guarda `status` e `current_period_end` para quando entrar. |
| Emissão de nota fiscal / faturamento | Assunto contábil, fora do produto. |
| Trial automático com downgrade | Campo existe (`trial_ends_at`), enforcement fica para depois (SPEC 059 §11). |
| White-label / múltiplas marcas | Opção C da análise. Depende deste PRD, não o contrário. |
| Suporte comercial, LGPD, SLA | As outras lacunas da análise. |
| Página pública de preços (site de marketing) | O app não tem rotas públicas hoje — só `(auth)` e `(dashboard)`. O catálogo é servido por endpoint e pode alimentar um site depois. |

---

## 4. Decisões de produto

### D-1 — Quota é opt-in do deployment, desligada por padrão

Existe um interruptor único (`platform_settings.quotas_enforced`, padrão
`FALSE`). Desligado, **toda quota é ilimitada** e a aba de plano some da
interface. Ligado, os limites do plano de cada conta valem.

*Por quê:* o projeto é um fork open-source público. Se a migração chegasse
limitando quem já roda o CRM em casa, o `git pull` viraria uma degradação de
produto — exatamente o "perder a comunidade open source" que a análise alerta.
Com o padrão desligado, a migração é inerte para terceiros e o mesmo código
serve o SaaS do mantenedor.

*Consequência:* o interruptor mora no **banco**, não no `.env` — os pontos de
enforcement mais importantes são triggers SQL, e trigger não lê `process.env`.

### D-2 — O catálogo comercial não entra em migração

A migração 067 cria o schema e semeia **um** plano: `unlimited` (todos os
limites nulos), ao qual toda conta existente e toda conta nova são atribuídas.
Os planos comerciais com preço em BRL ficam em
`supabase/setup/plans-seed.sql`.

*Por quê:* mesma regra que já vale no `AGENTS.md` para `cron-jobs.sql` — o que
carrega decisão de um deployment específico não é migração, senão o fork de
terceiros herda a tabela de preços do mantenedor.

### D-3 — Limite ausente (`NULL`) é ilimitado; `0` é bloqueado

Segue a semântica já usada em `cold-send-limit.ts`, onde `0` desliga o eixo.
Um plano sem a chave `channels_whatsapp_cloud` dá acesso ilimitado a ela; com
a chave em `0`, o plano não tem WhatsApp oficial.

*Por quê:* faz o comportamento "esqueci de definir" ser permissivo, não
restritivo. Numa quota, falhar fechado quebra o app de quem não pediu nada; a
falha aberta é visível e corrigível.

### D-4 — Estourar a quota bloqueia criação, nunca destrói dado

Rebaixar um plano de 10.000 para 2.000 contatos **não apaga 8.000 contatos**.
A conta fica em *overage*: tudo continua legível, exportável e respondível; só
a criação de contato novo é recusada, com aviso na interface dizendo quanto
excede.

Idem para instâncias QRCode acima do teto (seguem conectadas; criar outra é
que falha) e membros (ninguém é expulso).

*Por quê:* apagar dado de cliente por decisão de billing é o pior desfecho
possível, inclusive juridicamente. E é irreversível — enquanto o bloqueio de
criação se desfaz sozinho quando o plano sobe.

### D-5 — Mensagem RECEBIDA nunca é bloqueada por quota

Quando alguém escreve para a empresa e o telefone ainda não existe em
`contacts`, o contato é criado pela ingestão. Se a quota bloqueasse esse
caminho, **a mensagem do cliente final se perderia** — quem paga a conta
puniria quem tenta falar com ela.

Portanto: contato criado por mensagem recebida é sempre aceito, **conta** para
o uso e empurra a conta para overage visível. Só os caminhos que o operador
inicia (formulário, importação, audiência de disparo, API pública) são
recusados.

*Consequência técnica:* o motivo de criação precisa estar na linha
(`contacts.created_via`), porque a trigger não tem como saber de onde veio o
`INSERT` — os dois caminhos passam pelo mesmo PostgREST.

### D-6 — Quota de usuários é por total **e** por papel

Um plano define `members_total` e, opcionalmente, `members_admin`,
`members_agent`, `members_viewer`. O `owner` conta em `members_total` e nunca
pode ser bloqueado (senão a conta fica sem dono).

*Por quê:* foi pedido explicitamente, e o custo real difere por papel — um
`viewer` não envia mensagem nem ocupa fila de atendimento; um `agent` sim.
Vender "5 usuários" sem dizer quantos podem atender esconde a única parte que
importa para o custo.

### D-7 — WhatsApp oficial (Cloud) permanece 1 por conta neste PRD

`whatsapp_config` tem `UNIQUE(account_id)` desde a 017 e `channels` tem índice
parcial de um canal Cloud por conta. A quota `channels_whatsapp_cloud` só
assume os valores **0** (plano sem oficial) ou **1**. Suportar N números
oficiais é outro projeto — derruba dois índices e mexe em templates, webhook e
inbox.

### D-8 — Escolha de plano é uma **solicitação**, não uma troca automática

A página de planos mostra catálogo, preços e quotas e tem botão de escolha. O
clique grava uma solicitação (`plan_change_requests`) e, opcionalmente, dispara
um webhook de saída (n8n) para avisar o mantenedor. **Quem efetiva a troca é o
operador**, depois de confirmar o pagamento fora do sistema.

*Por quê:* sem gateway, um botão que trocasse o plano na hora seria
autoatendimento para upgrade grátis. Downgrade solicitado também merece
conversa (é churn), não um clique.

### D-9 — O operador age por rota autenticada por segredo, não por UI

Trocar plano de conta, conceder *override* e ler solicitações acontecem em
`/api/admin/**`, protegido por `x-admin-secret` (`PLATFORM_ADMIN_SECRET`), no
mesmo formato das rotas de cron: **sem a variável no servidor, responde 503**.
Um painel de super-admin com login é uma SPEC futura.

*Por quê:* não existe conceito de "usuário da plataforma" no schema hoje —
todo usuário pertence a exatamente uma conta. Criar esse conceito é um projeto
com superfície de segurança própria (um bug ali vaza dados entre clientes).
Segredo de servidor entrega a mesma capacidade operacional hoje, com risco
conhecido.

---

## 5. Quotas do escopo inicial

| Chave | O que limita | Onde é aplicada | Já existe hoje? |
| --- | --- | --- | --- |
| `contacts` | Contatos na conta | Trigger no banco (único caminho seguro — o navegador insere direto) | Não |
| `members_total` | Usuários na conta, todos os papéis | Criação de convite + `redeem_invitation` | Não |
| `members_admin` | Usuários `admin` (+`owner`) | Convite + `redeem_invitation` + `set_member_role` | Não |
| `members_agent` | Usuários `agent` | idem | Não |
| `members_viewer` | Usuários `viewer` | idem | Não |
| `channels_whatsapp_qr` | Instâncias Evolution (QRCode) | `POST /api/channels/evolution/instances` | **Sim** — vira fonte do limite em `limits.ts` |
| `channels_whatsapp_cloud` | Números oficiais (0 ou 1 — D-7) | `POST /api/whatsapp/config` | Parcial (`UNIQUE`) |

### 5.1. Chaves de recurso (booleanas) que vêm junto

Mesmo mecanismo, valor booleano — é o que distingue plano barato de plano caro
sem precisar de número:

`ai_enabled` · `api_v1_enabled` · `flows_enabled` · `broadcasts_enabled` ·
`webhooks_out_enabled`

### 5.2. Candidatas mapeadas, fora do MVP

Ficam registradas porque o motor as suporta sem mudança de schema — é só
adicionar chave ao plano e um ponto de enforcement:

`messages_per_month` (medir antes de limitar), `broadcasts_per_month`,
`automations_active`, `api_requests_per_minute` (hoje fixo em
`rate-limit.ts`), `storage_mb`, `contacts_export_per_month`,
`ai_tokens_per_month`, `cold_sends_per_day` (hoje `.env` global — o plano é o
lugar natural dele).

---

## 6. Teto de deployment ≠ quota de plano

O `EVOLUTION_MAX_INSTANCES_TOTAL` (padrão 20) **continua existindo e continua
sendo checado primeiro**. Ele protege a VPS: 10 contas × 3 instâncias = 30
sessões `whatsmeow`, e nenhum plano pode comprar o que a máquina não tem.

Isso tem consequência comercial direta, que precisa estar clara antes de
publicar preços: **a capacidade de instâncias QRCode vendáveis é finita e
conhecida**. Com o teto padrão de 20, um plano que promete 3 instâncias cabe
em ~6 clientes por VPS. Vender além disso exige mais Evolution Go, não mais
banco.

---

## 7. Catálogo proposto (valores para o mantenedor ratificar)

Preços em BRL/mês. Vão para `supabase/setup/plans-seed.sql` (D-2), então mudar
qualquer número é editar um arquivo e reexecutar — não é migração, não é
deploy.

| | **Grátis** | **Essencial** | **Profissional** | **Empresarial** | **Sob medida** |
| --- | --- | --- | --- | --- | --- |
| Preço | R$ 0 | R$ 149 | R$ 349 | R$ 799 | negociado |
| Contatos | 250 | 2.000 | 10.000 | 50.000 | ilimitado |
| Usuários (total) | 2 | 5 | 12 | 30 | negociado |
| — admins | 1 | 2 | 4 | 10 | — |
| — agentes | 1 | 3 | 8 | 20 | — |
| — visualizadores | 0 | 1 | 4 | 10 | — |
| WhatsApp QRCode | 1 | 1 | 2 | 3 | 3 (teto da VPS) |
| WhatsApp oficial | 0 | 1 | 1 | 1 | 1 |
| Disparos em massa | não | sim | sim | sim | sim |
| Automações / Flows | automações | automações | + flows | + flows | + flows |
| IA (rascunho / auto-resposta) | não | não | sim | sim | sim |
| API pública v1 | não | sim | sim | sim | sim |
| Webhooks de saída | não | sim | sim | sim | sim |

Notas de precificação, à luz do alerta da análise ("mínimo R$ 99–299 para ser
sustentável"):

- O **Grátis** não dá WhatsApp oficial nem disparo. É demonstração, não
  operação — quem opera de graça consome VPS e não converte.
- O salto Essencial → Profissional é IA + segunda instância QRCode: os dois
  itens de custo variável real (tokens de LLM e sessão `whatsmeow`).
- O **Empresarial** encosta no teto físico da VPS (§6). Acima dele, o preço
  precisa incluir infraestrutura dedicada — daí "Sob medida".

---

## 8. Experiência do usuário

**Nova aba em Configurações: "Plano e uso"** (`?tab=plan`), visível apenas
quando o interruptor de D-1 está ligado.

1. **Plano atual** — nome, preço, status, período. Se `suspended`, um aviso
   dizendo o que está bloqueado.
2. **Uso** — uma barra por quota: `1.847 / 2.000 contatos`, `4 / 5 usuários
   (2 admins, 2 agentes, 0 visualizadores)`, `1 / 1 instância QRCode`. Amarelo
   em 80%, vermelho ao estourar, com o excedente explícito em caso de overage
   (D-4).
3. **Catálogo** — cartões com preço, quotas e recursos; o plano atual marcado;
   botão "Escolher este plano" nos demais (owner/admin apenas).
4. **Solicitação enviada** — o botão vira estado ("solicitação de 12/03 em
   análise"), com instrução de pagamento configurável pelo deployment.

**Nos pontos de bloqueio**, a mensagem nunca é um erro genérico: "Limite do
plano Essencial atingido: 2.000 de 2.000 contatos. Remova contatos ou mude de
plano." com link direto para a aba.

---

## 9. Riscos

| Risco | Mitigação |
| --- | --- |
| Trigger de contatos derruba importação de 10 mil linhas no meio | Pré-checagem de espaço na UI de importação antes de inserir; erro por linha já é tratado como "pulado" (`import-modal.tsx`) — a SPEC exige mensagem específica, não silêncio |
| Contador de uso desincroniza do real | Contador mantido por trigger + função `recount_account_usage()` + recontagem noturna opcional no `cron-jobs.sql` |
| Fork de terceiro se vê limitado após `git pull` | D-1 (padrão desligado) + asserção na migração |
| Quota vira gate de segurança sem ser | Quota **não** substitui RLS. Falha aberta por design (D-3) — quem depende dela para isolar dado está usando a peça errada |
| Preço abaixo do custo | §6 torna explícito o custo por instância; catálogo fora de migração permite corrigir sem deploy |
| Mensagem de cliente perdida por quota | D-5 |

---

## 10. Critérios de aceite

1. Com `quotas_enforced = FALSE`, o comportamento do app é o de hoje, e a aba
   "Plano e uso" não aparece.
2. Com o interruptor ligado e uma conta no plano Essencial: contato 2.001 pelo
   formulário, importação, audiência e API v1 é recusado com mensagem que
   nomeia o limite; contato 2.001 vindo de **mensagem recebida** é criado e a
   conta aparece em overage.
3. Convidar o 6º usuário falha; convidar o 3º admin falha mesmo com vaga
   total; promover agente a admin acima do teto falha.
4. Criar a 2ª instância QRCode falha por limite de plano, e a 21ª do
   deployment falha por limite de VPS — com mensagens distintas.
5. Conectar WhatsApp oficial no plano Grátis falha.
6. Rebaixar Profissional → Essencial com 5.000 contatos não apaga nada, mostra
   overage e recusa criação nova.
7. "Escolher este plano" grava solicitação e não altera nada do plano.
8. `/api/admin/accounts/{id}/plan` com o segredo troca o plano; sem o segredo
   responde 401; sem a variável no servidor, 503.

---

## 11. Sequência sugerida

| Etapa | Entrega | Depende de |
| --- | --- | --- |
| **1. Este PRD** | decisões D-1…D-9 ratificadas | mantenedor |
| **2. [SPEC 059](./spec-059-motor-de-quotas.md)** | schema, motor, pontos de enforcement, UI | etapa 1 |
| **3. Catálogo real** | `plans-seed.sql` com os preços definitivos | etapa 1 |
| **4. Ligar em produção** | interruptor ligado só no deployment do mantenedor | etapas 2 e 3 |
| **5. Depois** | suspensão por inadimplência, trial, medição de mensagens, painel de super-admin, e só então gateway de pagamento | etapa 4 |
