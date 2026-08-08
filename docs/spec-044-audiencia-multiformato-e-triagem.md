# SPEC 044 — Audiência multiformato, teto de tier Meta e triagem de contatos

**Status:** 🟢 Fases 1–7 implementadas · migrações 044–051 aplicadas e verificadas em `vn` e `rs` (051 em 2026-08-08) · §6.7 implementada em 2026-08-07 · §6.4, §6.2 e §6.6 implementadas em 2026-08-08
**Desvios da proposta original:** §3.2.1 (Excel via `read-excel-file`, sem `.xls`) e §3.4 (sem Web Worker — ver §3.4.1)
**Ordem de execução escolhida:** fase 6 antes da fase 4 — decisão registrada em 2026-08-07. Fase 6 (envio server-side) foi desacoplada da fase 4 (não depende de staging/`draftId`; opera direto sobre `AudienceConfig`) e é a mais barata das quatro restantes, além de ser a única que corrige uma regressão real: as fases 1–3 habilitaram audiências de milhares de contatos via planilha, mas o disparo ainda roda no browser ([use-broadcast-sending.ts:464-563](../src/hooks/use-broadcast-sending.ts#L464-L563)) — fechar a aba mata a campanha no meio.
**Módulo:** `src/components/broadcasts/`, `src/app/(dashboard)/broadcasts/`, `src/lib/audience/` (novo)
**Data:** 2026-08-06
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Referências de padrão:** [spec-043-quadro-de-atribuicao.md](spec-043-quadro-de-atribuicao.md) · [spec-042-supervisao-e-escopo-de-contatos.md](spec-042-supervisao-e-escopo-de-contatos.md) · [spec-040-media-privada.md](spec-040-media-privada.md) · [public-api.md](public-api.md)

> ⚠️ **Esta SPEC não é "adicionar upload de arquivo".** Ela reorganiza o
> estágio de audiência do wizard em torno de dois invariantes novos que hoje
> não existem em lugar nenhum do código:
>
> 1. **O tier da Meta é um teto de janela deslizante de 24 h sobre conversas
>    iniciadas pelo negócio** — não um limite por disparo. Tratá-lo como
>    "máximo de contatos no CSV" produz um sistema que _parece_ correto e
>    ainda assim estoura a cota (§4.2).
> 2. **A triagem precisa sobreviver a um reload.** Uma "área de triagem"
>    roteada exige um identificador persistido; manter a lista só em
>    `useState` transforma F5 em perda de trabalho (§3.3).
>
> Tudo o mais — parsing, dedupe, envio, contadores — reusa peças que já
> existem e estão testadas. A §1.4 lista o que é reuso e o que é código novo.

---

## 1. Análise do contexto atual (obrigatória)

Esta seção é o resultado da leitura do módulo antes de qualquer decisão de
arquitetura. Nada abaixo é suposição: cada afirmação aponta para o arquivo e a
linha correspondentes.

### 1.1 Anatomia da rota `/broadcasts`

| Rota               | Arquivo                                                              | O que faz hoje                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/broadcasts`      | [page.tsx](<../src/app/(dashboard)/broadcasts/page.tsx>)             | Lista em `<Table>`. Client component. Polling de 5 s **condicional** a existir algum broadcast `sending` ([:27](<../src/app/(dashboard)/broadcasts/page.tsx#L27>)), pausado em `visibilitychange` ([:112-120](<../src/app/(dashboard)/broadcasts/page.tsx#L112-L120>)). Gate de permissão por `useCan('send-messages')` + `<GatedButton>`. |
| `/broadcasts/new`  | [new/page.tsx](<../src/app/(dashboard)/broadcasts/new/page.tsx>)     | Orquestrador do wizard de 4 passos. **Todo o estado é `useState` local** ([:31-48](<../src/app/(dashboard)/broadcasts/new/page.tsx#L31-L48>)) — não há Zustand, Redux, Context próprio nem React Query no projeto.                                                                                                                         |
| `/broadcasts/[id]` | [\[id\]/page.tsx](<../src/app/(dashboard)/broadcasts/[id]/page.tsx>) | 6 `StatCard` + `FunnelChart` em CSS puro + tabela de destinatários com filtro por status e export CSV (`toCsv` RFC 4180 em [:129-132](<../src/app/(dashboard)/broadcasts/[id]/page.tsx#L129-L132>)).                                                                                                                                       |

**Consequência de arquitetura #1:** não existe gerenciador de estado global no
projeto além do `AuthProvider`. Introduzir um agora seria criar um padrão novo
onde o existente resolve — a §4.1 usa Context + hook, exatamente a forma do
[use-auth.tsx](../src/hooks/use-auth.tsx).

**Consequência de arquitetura #2:** o `[id]/page.tsx` carrega **todos** os
destinatários em memória e filtra com `useMemo` ([:195-201](<../src/app/(dashboard)/broadcasts/[id]/page.tsx#L195-L201>)).
Funciona para os volumes atuais; a triagem enriquecida (§5) não pode copiar
esse padrão — ver §5.3.

### 1.2 Os quatro passos do wizard

| Passo              | Arquivo                                                                             | Estado                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Template       | [step1-choose-template.tsx](../src/components/broadcasts/step1-choose-template.tsx) | ✅ Sólido. Filtra `status = 'APPROVED'` ([:41-45](../src/components/broadcasts/step1-choose-template.tsx#L41-L45)) porque qualquer outro status faz a Meta responder 400 no envio.                                                                           |
| 2 — Audiência      | [step2-select-audience.tsx](../src/components/broadcasts/step2-select-audience.tsx) | ⚠️ **Alvo desta SPEC.** Ver §1.3.                                                                                                                                                                                                                            |
| 3 — Personalização | [step3-personalize.tsx](../src/components/broadcasts/step3-personalize.tsx)         | ✅ Mapeamento de variáveis, preview ao vivo, validação de header de mídia bloqueando o "Próximo" ([:478](../src/components/broadcasts/step3-personalize.tsx#L478)).                                                                                          |
| 4 — Envio          | [step4-schedule-send.tsx](../src/components/broadcasts/step4-schedule-send.tsx)     | ⚠️ Recalcula o alcance **por conta própria** ([:54-90](../src/components/broadcasts/step4-schedule-send.tsx#L54-L90)), com lógica divergente da do passo 2 — não aplica `excludeTagIds` e ignora `custom_field`. Duas fontes de verdade para o mesmo número. |

### 1.3 O estado real do passo 2 (e por que CSV está morto)

O tipo `'csv'` existe em `AudienceType` ([:19](../src/components/broadcasts/step2-select-audience.tsx#L19)),
aparece no seletor com ícone `Upload` e a descrição `csvDesc`
(`messages/pt-BR.json:896` — _"Envie um CSV com números de telefone"_), e é
tratado no cálculo de estimativa ([:175-181](../src/components/broadcasts/step2-select-audience.tsx#L175-L181))
e na validação ([:259-261](../src/components/broadcasts/step2-select-audience.tsx#L259-L261)).

**Mas não existe nenhum bloco `audience.type === 'csv'` no JSX.** Compare:

- `'tags'` → bloco de UI em [:332-368](../src/components/broadcasts/step2-select-audience.tsx#L332-L368)
- `'custom_field'` → bloco de UI em [:370-422](../src/components/broadcasts/step2-select-audience.tsx#L370-L422)
- `'csv'` → **nada**

Como `audience.csvContacts` nunca é populado, `isValid` nunca fica `true` para
esse tipo e o botão "Próximo" fica permanentemente desabilitado. O usuário
clica em "CSV", nada acontece, e o wizard trava.

O mais relevante para o planejamento: **o backend do CSV já existe e está
correto.** `upsertCsvContacts` ([use-broadcast-sending.ts:223-292](../src/hooks/use-broadcast-sending.ts#L223-L292))
resolve `{phone, name}[]` em `contacts.id` reais, com dedupe por telefone,
lookup em uma viagem e insert em lotes de 200 — e carrega um comentário
documentando um bug de UUID já corrigido. Falta **apenas a camada de UI**.

> **Bug lateral confirmado:** o lookup em [:248-252](../src/hooks/use-broadcast-sending.ts#L248-L252)
> filtra por `.eq('user_id', user.id)`, enquanto o import de contatos
> ([import-modal.tsx:232-234](../src/components/contacts/import-modal.tsx#L232-L234))
> filtra por `account_id`. Desde a migração [017:479-484](../supabase/migrations/017_account_sharing.sql#L479-L484)
> a RLS é por conta, não por usuário. Num time, um número já cadastrado por
> outro agente não é encontrado e vira contato duplicado. **A §7 corrige isso
> no mesmo PR** — sem essa correção a triagem exibe duplicatas.

### 1.4 Inventário de reuso: o que já existe e será aproveitado

Esta é a tabela que governa o esforço da implementação.

| Peça existente                                                 | Localização                                                                                                                  | Papel nesta SPEC                                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseContactCsv` / `parseCsvLine`                             | [parse-contact-csv.ts](../src/lib/contacts/parse-contact-csv.ts) + [.test.ts](../src/lib/contacts/parse-contact-csv.test.ts) | **Parser canônico.** Já trata aspas, header case-insensitive, colunas `phone/name/email/company/tags`. Vira o alvo comum de CSV, XLSX e Sheets (§3.2).                               |
| `dedupeByPhone`, `normalizeKey`, `isUniqueViolation`           | [dedupe.ts](../src/lib/contacts/dedupe.ts)                                                                                   | Dedupe da audiência. Alinha-se à coluna gerada `contacts.phone_normalized` (migração 022), UNIQUE por conta.                                                                         |
| `sanitizePhoneForMeta`, `isValidE164`, `phoneVariants`         | [phone-utils.ts](../src/lib/whatsapp/phone-utils.ts)                                                                         | Validação de telefone na triagem — o mesmo predicado que o envio usará depois, evitando "válido na tela, rejeitado no envio".                                                        |
| `upsertCsvContacts`                                            | [use-broadcast-sending.ts:223](../src/hooks/use-broadcast-sending.ts#L223)                                                   | Materialização de linhas importadas em `contacts`. Extraído para `src/lib/audience/` e corrigido para `account_id`.                                                                  |
| `createBroadcast` + `deliverBroadcast`                         | [broadcast-core.ts](../src/lib/whatsapp/broadcast-core.ts)                                                                   | **Caminho de envio server-side já pronto**, usado pela API pública. ✅ A fase 6 migrou o wizard para o `deliverBroadcast` (o `createBroadcast` ficou de fora — ver §6.1, decisão 4). |
| `META_API_BASE`, `throwMetaError`                              | [meta-api.ts:12-58](../src/lib/whatsapp/meta-api.ts#L12-L58)                                                                 | Base do novo `fetchMessagingLimit` (§4.1). Padrão de _named params_ obrigatório ([:1-10](../src/lib/whatsapp/meta-api.ts#L1-L10)).                                                   |
| `encrypt` / `decrypt`                                          | [encryption.ts](../src/lib/whatsapp/encryption.ts)                                                                           | O token da Meta está cifrado em repouso e só é decifrado no servidor. **Invariante de segurança da §4.3.**                                                                           |
| `checkRateLimit`, `RATE_LIMITS`                                | [rate-limit.ts](../src/lib/rate-limit.ts)                                                                                    | Novas rotas entram no mesmo mapa central ([:124-178](../src/lib/rate-limit.ts#L124-L178)).                                                                                           |
| `useAuth()` → `accountId`, `canSendMessages`, `profileLoading` | [use-auth.tsx](../src/hooks/use-auth.tsx)                                                                                    | Escopo de conta e gate de permissão.                                                                                                                                                 |
| `useCan` + `<GatedButton>`                                     | [use-can.ts](../src/hooks/use-can.ts) · [gated-button.tsx](../src/components/ui/gated-button.tsx)                            | Gate visual das ações de triagem.                                                                                                                                                    |
| `<Table>`, `<Checkbox>`, `<Dialog>`, `<Tabs>`, `<ScrollArea>`  | [components/ui/](../src/components/ui/)                                                                                      | Base do dashboard e da tabela de triagem. Nada de UI kit novo.                                                                                                                       |
| `recharts`                                                     | `package.json:60`                                                                                                            | Já é dependência (usada no dashboard). Cobre o gráfico histórico da §5.2 sem instalar nada.                                                                                          |
| `toCsv` + `downloadBlob`                                       | [\[id\]/page.tsx:129-144](<../src/app/(dashboard)/broadcasts/[id]/page.tsx#L129-L144>)                                       | Export da triagem. Promover para `src/lib/csv.ts` (hoje é local à página).                                                                                                           |
| RPC `filter_contacts_by_tags`                                  | [025](../supabase/migrations/025_filter_contacts_by_tags.sql)                                                                | **Precedente arquitetural** de agregação server-side com `SECURITY INVOKER`. O cabeçalho documenta o teto de ~1000 valores do PostgREST — restrição central da §5.3.                 |
| RPCs `dashboard_*`                                             | [039](../supabase/migrations/039_conversation_assignment.sql)                                                                | Precedente de `SECURITY DEFINER` + guarda `is_account_member`.                                                                                                                       |
| Endurecimento de RPCs                                          | [042](../supabase/migrations/042_lockdown_definer_rpcs.sql)                                                                  | **Regra obrigatória**: toda função nova faz `REVOKE ALL … FROM PUBLIC` e `GRANT EXECUTE … TO authenticated`.                                                                         |

### 1.5 O que **não** existe e precisa ser criado

| Faltando                                  | Impacto                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qualquer leitura de tier/limite da Meta   | Nenhum `messaging_limit`, `business_id` ou tier em `whatsapp_config` (schema em [001:188-206](../supabase/migrations/001_initial_schema.sql#L188-L206) + [015](../supabase/migrations/015_whatsapp_config_registration.sql)). Coluna e rota novas. |
| Parser de planilha binária                | Sem `xlsx`, `exceljs` ou `papaparse` em `package.json`. **Decisão de dependência — §3.2.1.**                                                                                                                                                       |
| Qualquer Web Worker                       | `grep -rl "new Worker" src/` → zero. Esta SPEC introduz o primeiro; a §3.4 justifica.                                                                                                                                                              |
| Índice `broadcast_recipients(contact_id)` | Só existe `idx_broadcast_recipients_broadcast` ([001:334](../supabase/migrations/001_initial_schema.sql#L334)). O histórico **por contato** (§5.1) faria seq scan.                                                                                 |
| Persistência da audiência em rascunho     | `handleSaveDraft` grava só `{type, tagIds}` ([new/page.tsx:112-115](<../src/app/(dashboard)/broadcasts/new/page.tsx#L112-L115>)), descartando `customField`, `csvContacts`, `excludeTagIds` e `headerMediaUrl`.                                    |
| Agendamento                               | A coluna `broadcasts.scheduled_at` existe desde [001:302](../supabase/migrations/001_initial_schema.sql#L302) e **nunca é escrita nem lida**. Base pronta para a §6.3.                                                                             |

### 1.6 Como a arquitetura proposta se integra com segurança

Cinco compromissos explícitos, cada um amarrado a uma restrição observada:

1. **Nenhum padrão de estado novo.** `MessagingLimitProvider` é Context + hook,
   espelhando `AuthProvider`. O wizard continua com `useState` local.
2. **Nenhum breaking change no envio.** `useBroadcastSending` mantém a
   assinatura `createAndSendBroadcast(payload)`. A audiência triada entra como
   um `AudienceConfig` de tipo novo (`'staged'`), aditivo aos quatro atuais.
3. **Nenhuma RPC frouxa.** Toda função nova segue o padrão da 042 (ACL
   explícita) e prefere `SECURITY INVOKER`, como a 025.
4. **Nenhum token no browser.** O tier vem por route handler, nunca por fetch
   direto do cliente à Graph API. A §4.3 detalha.
5. **Nenhuma string sem par.** `messages/en.json` é a fonte de verdade e
   `npm run i18n:check` falha em CI se `pt-BR.json` divergir
   ([check-i18n-parity.mjs](../scripts/check-i18n-parity.mjs)). Toda chave nova
   entra nos dois arquivos no mesmo commit.

---

## 2. Visão geral do fluxo proposto

```
/broadcasts  ──► MessagingLimitProvider (layout)
                 └─ GET /api/whatsapp/messaging-limit
                    → { tier, tierCap, usedLast24h, remaining, staleAt }
                       │
/broadcasts/new        │  Passo 1 · Template
                       │  Passo 2 · Audiência
                       │           ├─ Google Sheets (padrão)
                       │           ├─ Excel .xlsx / .xls
                       │           ├─ CSV
                       │           ├─ Tags / Campo personalizado / Todos
                       │           └─ [Analisar audiência]
                       │                    │
                       │            Worker de parsing  ─► normalização + dedupe
                       │                    │
                       ▼                    ▼
          POST /api/broadcasts/audience/stage   (cria rascunho + linhas staged)
                       │
/broadcasts/new/[draftId]/triage ◄───────────┘
                       │  Dashboard histórico global (§5.2)
                       │  Tabela de triagem enriquecida (§5.1)
                       │  Medidor de cota: selecionados / remaining (§4.2)
                       │
                       ▼  Passo 3 · Personalização → Passo 4 · Envio
```

---

## 3. Componentes e fluxo de arquitetura

### 3.1 Componentes novos

| Componente               | Caminho                                                         | Responsabilidade                                                                                                              |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AudienceSourcePicker`   | `src/components/broadcasts/audience/audience-source-picker.tsx` | Substitui o grid de 4 cards do passo 2 por 6 fontes. Puramente apresentacional.                                               |
| `GoogleSheetsSource`     | `.../sources/google-sheets-source.tsx`                          | Campo de URL + validação + preview. Fonte **padrão** (§3.2.2).                                                                |
| `SpreadsheetDropzone`    | `.../sources/spreadsheet-dropzone.tsx`                          | Drop/seleção de `.xlsx`, `.xls`, `.csv`. Reusa a estética do [import-modal.tsx](../src/components/contacts/import-modal.tsx). |
| `SheetMappingDialog`     | `.../sheet-mapping-dialog.tsx`                                  | Escolha de aba + mapeamento coluna→campo quando o header não bate com o esperado.                                             |
| `AudienceTriageTable`    | `.../triage/audience-triage-table.tsx`                          | Tabela virtualizada, seleção em massa, colunas de engajamento.                                                                |
| `EngagementDashboard`    | `.../triage/engagement-dashboard.tsx`                           | Cards macro + série histórica (recharts).                                                                                     |
| `QuotaMeter`             | `.../triage/quota-meter.tsx`                                    | Barra selecionados / cota restante. Presente também no passo 4.                                                               |
| `MessagingLimitProvider` | `src/components/broadcasts/messaging-limit-provider.tsx`        | Context do tier (§4.1).                                                                                                       |

### 3.2 Ingestão: três fontes, **um** alvo

O ponto de projeto que mantém isto simples: as três fontes convergem para o
mesmo tipo antes de qualquer outra coisa acontecer.

```ts
// src/lib/audience/types.ts
export interface RawAudienceRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tagNames: string[];
  /** Índice 1-based na planilha original — usado nas mensagens de erro. */
  sourceRow: number;
}
```

`RawAudienceRow` é deliberadamente `ParsedContactRow`
([parse-contact-csv.ts:6-13](../src/lib/contacts/parse-contact-csv.ts#L6-L13))
mais `sourceRow`. Isso permite reusar o parser de CSV **sem fork** e mantém o
import de contatos e o de audiência falando a mesma língua.

#### 3.2.1 Excel — decisão de dependência (requer aprovação)

`.xlsx` é ZIP+XML; `.xls` legado é BIFF8 binário. Não há como ler `.xls` sem
uma biblioteca dedicada.

| Opção                | `.xlsx` | `.xls` | Peso    | Observação                                                                                                                                                                                                                                                                                               |
| -------------------- | ------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SheetJS (`xlsx`)** | ✅      | ✅     | ~500 kB | Única cobertura real de `.xls`. **Atenção:** o pacote publicado no npm está congelado em `0.18.5` e carrega CVEs conhecidas (prototype pollution / ReDoS); as versões corrigidas são distribuídas pelo registry próprio da SheetJS (`cdn.sheetjs.com`), o que exige configuração de registry no `npm i`. |
| `exceljs`            | ✅      | ❌     | ~900 kB | Sem `.xls` — **não atende ao requisito**.                                                                                                                                                                                                                                                                |
| `read-excel-file`    | ✅      | ❌     | ~150 kB | Sem `.xls`.                                                                                                                                                                                                                                                                                              |

**Recomendação:** SheetJS a partir do registry oficial deles, importado
**dinamicamente e apenas dentro do Worker** (`await import('xlsx')`), para que
o bundle da rota `/broadcasts` não cresça para quem só usa Sheets ou CSV.

> ❓ **Decisão pendente para o mantenedor.** Se adicionar registry customizado
> ao `npm i` for indesejável no fluxo de self-host do projeto, a alternativa é
> restringir o v1 a `.xlsx` + CSV + Sheets com `read-excel-file`, e tratar
> `.xls` legado com uma mensagem orientando "Salvar como .xlsx". Isso remove o
> maior risco de dependência da SPEC ao custo de um requisito.

#### 3.2.2 Google Sheets — link publicado, não OAuth (v1)

Dois caminhos possíveis:

|                      | (A) OAuth + Sheets API                                      | (B) Export CSV por link                    |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Setup                | Projeto no Google Cloud, tela de consentimento, verificação | Nenhum                                     |
| Novo modelo de dados | Tabela de tokens + refresh (usando `encryption.ts`)         | Nenhum                                     |
| Alcance              | Qualquer planilha do usuário                                | Planilhas com "qualquer pessoa com o link" |
| Superfície de risco  | Alta (armazenar tokens OAuth de terceiros)                  | Baixa                                      |

**Recomendação: (B) no v1.** O servidor faz `GET
https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}` e
entrega o texto ao mesmo `parseContactCsv`. Zero dependência, zero auth nova,
e o resultado é indistinguível para o usuário — que cola a URL da planilha.

Guardas obrigatórias na rota:

- Extrair `spreadsheetId`/`gid` por regex e **reconstruir** a URL do zero.
  Nunca repassar a URL colada — isso é o vetor de SSRF.
- Rejeitar host diferente de `docs.google.com`.
- `Content-Length` máximo e timeout via `AbortSignal.timeout(15_000)`.
- Se a resposta vier como HTML de login, devolver erro tipado
  `sheet_not_public` com instrução de como compartilhar.

(A) fica registrado como evolução v2 — o desenho de (B) não a impede, porque
ambas terminam no mesmo `RawAudienceRow[]`.

### 3.3 Persistência da triagem

Manter milhares de linhas em `useState` significa que um F5 apaga o trabalho —
e uma "área de triagem" **roteada** precisa de um id na URL para existir.

**Proposta:** ao concluir o parsing, o cliente chama
`POST /api/broadcasts/audience/stage`, que:

1. cria o `broadcasts` com `status = 'draft'`;
2. grava as linhas normalizadas em `broadcast_audience_staging` (§8.2);
3. devolve `{ draftId, summary }`.

A triagem então vive em `/broadcasts/new/[draftId]/triage` — recarregável,
compartilhável com um colega, e **resolve de quebra** a lacuna de rascunho da
§1.5, porque o rascunho passa a carregar a audiência de verdade.

Linhas staged são efêmeras: um `DELETE` em cascata quando o broadcast é
enviado ou descartado, mais uma limpeza de rascunhos com mais de 7 dias.

#### 3.3.1 O que foi implementado _(fase 4 — 2026-08-07)_

**Um desvio consciente do §2:** o diagrama funila as SEIS fontes — Sheets,
Excel, CSV, Tags, Campo personalizado e Todos — para o mesmo
`[Analisar audiência]`. A implementação seguiu o diagrama à risca, não a
leitura mais estreita de "triagem é só para importação": o botão "Próximo" do
passo 2 virou "Analisar audiência" para as seis fontes, não só para as duas
importadas. Uma triagem que existisse só para planilha deixaria de fora o
caso mais comum do produto — "enviar para quem tem a etiqueta X" — que se
beneficia igualmente de ver quem está prestes a receber antes de queimar
cota.

| Peça                                      | Caminho                                                                       | Papel                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stageAudience`                           | [audience/stage.ts](../src/lib/audience/stage.ts)                             | Resolve o filtro (`all`/`tags`/`custom_field`, reusando `estimate.ts`/`resolve.ts`) ou cruza linhas de planilha contra `contacts` — **leitura**, nunca materializa.                                                                                   |
| `POST /api/broadcasts/audience/stage`     | [route.ts](../src/app/api/broadcasts/audience/stage/route.ts)                 | Valida o corpo, chama `stageAudience`, devolve `{ draftId, summary }`. Rate limit próprio (`RATE_LIMITS.audienceStage`).                                                                                                                              |
| `/broadcasts/new/[draftId]/triage`        | [page.tsx](<../src/app/(dashboard)/broadcasts/new/[draftId]/triage/page.tsx>) | Rota da triagem (§5.1). Busca+filtro com debounce, scroll infinito, seleção em massa — tudo via RPC direta do cliente (`triage_audience_page`/`triage_set_selection`, migração 046), mesmo padrão de `contacts/page.tsx` (`filter_contacts_by_tags`). |
| `AudienceTriageTable` / `TriageToolbar`   | `.../audience/triage/`                                                        | Tabela (§5.1) e busca/filtro/ações em massa (§5.3, §5.4).                                                                                                                                                                                             |
| `AudienceConfig['type'] = 'staged'`       | [estimate.ts](../src/lib/audience/estimate.ts)                                | Tipo aditivo, como o §1.6 (compromisso 2) exige. Carrega só `draftId`.                                                                                                                                                                                |
| `resolveStagedAudience`                   | [resolve.ts](../src/lib/audience/resolve.ts)                                  | No envio: lê as linhas `selected` e válidas do staging, hidrata as que já são contato por id e materializa as demais — mesmo caminho do `csv`.                                                                                                        |
| Ramo `staged` de `planDashboardBroadcast` | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)            | UPDATE no rascunho existente (não INSERT) e purga as linhas staged depois de criar os destinatários — o `draftId` da triagem vira o id do disparo enviado.                                                                                            |

**Como o wizard retoma sem estado global.** A triagem é uma rota própria e
`/broadcasts/new` continua com `useState` local (§1.6, compromisso 1) — os
dois não compartilham memória. Ao clicar "Continuar" na triagem, o cliente só
navega para `/broadcasts/new?draftId=…`; é `new/page.tsx` que reidrata o
`template` a partir de `template_name`/`template_language`, já persistidos
pelo stage, e retoma o wizard direto no passo 3 (Personalização). Voltar do
passo 3 com uma audiência `staged` leva de volta à triagem, não a um passo 2
reconstruído sem a fonte original — não há como saber, só pelo `AudienceConfig`
salvo, se a audiência veio de uma planilha ou de uma etiqueta.

**Descartar um rascunho de triagem** apaga a linha de `broadcasts`
diretamente do cliente (RLS de `agent` já cobre) — o `ON DELETE CASCADE` da
045 leva as linhas staged junto, sem código de limpeza adicional.

**Fora do escopo desta fase:** o dashboard de engajamento (§5.2, fase 5) e o
`audience_engagement_summary` que o alimenta. A triagem desta fase mostra o
histórico POR LINHA (campanhas recebidas, leu, respondeu, falhas) mas não os
cards agregados nem a série temporal — ambos ficam para a fase 5.

### 3.4 Parsing sem travar a UI

> ⛔ **Esta seção descreve o plano original. Ele não sobreviveu ao contato com
> o bundler — o que foi implementado está na §3.4.1.** O texto abaixo fica
> como registro do desenho pretendido.

Uma planilha de 50 000 linhas parseada na main thread congela a aba por vários
segundos. O projeto ainda não tem Worker; este é o caso que o justifica.

```
src/workers/spreadsheet-parser.worker.ts
```

**Protocolo** (mensagens tipadas, sem `any`):

```ts
type WorkerIn =
  | { kind: 'csv'; text: string }
  | { kind: 'xlsx'; buffer: ArrayBuffer; sheetName?: string }
  | { kind: 'cancel' };

type WorkerOut =
  | { kind: 'sheets'; names: string[] } // pede escolha de aba
  | { kind: 'progress'; parsed: number; total: number }
  | { kind: 'done'; rows: RawAudienceRow[]; invalid: InvalidRow[] }
  | { kind: 'error'; code: ParseErrorCode; message: string };
```

Detalhes que definem o comportamento:

- O Worker é criado com a forma estática que o Next 16 reconhece —
  `new Worker(new URL('...', import.meta.url), { type: 'module' })` — para que
  o bundler o emita como chunk separado.
- `progress` é emitido a cada 1000 linhas; a UI mostra barra determinística.
- `ArrayBuffer` é transferido (não copiado) via segundo argumento de
  `postMessage`.
- Um hook `useSpreadsheetParser()` encapsula ciclo de vida, cancelamento no
  unmount e `kind: 'cancel'`, mantendo os componentes livres de `Worker`.
- **Fallback:** se `typeof Worker === 'undefined'`, cai para parsing síncrono
  em `requestIdleCallback` fatiado. CSVs pequenos (< 2000 linhas) nem chegam a
  usar o Worker — o custo de spawn supera o ganho.

Limites duros, validados **antes** de ler o arquivo:

| Limite             | Valor                  | Motivo                                       |
| ------------------ | ---------------------- | -------------------------------------------- |
| Tamanho do arquivo | 10 MB                  | Um `.xlsx` de 10 MB já passa de 100 k linhas |
| Linhas processadas | 50 000                 | Teto de memória do Worker                    |
| Linhas staged      | `min(50 000, tierCap)` | §4.2                                         |

#### 3.4.1 O que foi implementado: fatiamento cooperativo _(desvio)_

O Web Worker **não foi implementado**. A verificação do build de produção
mostrou que o Turbopack — bundler padrão do Next 16 e deste projeto — não
empacota `new Worker(new URL('./x.ts', import.meta.url))`: ele emite o
TypeScript **cru** como asset estático e o chunk referencia
`/_next/static/media/spreadsheet-parser.worker.<hash>.ts`. O navegador
buscaria TypeScript e quebraria com erro de sintaxe.

Verificado empiricamente, não deduzido:

- build de produção com o worker em `src/workers/` (caminho `../`) → asset `.ts`;
- build repetido com o worker ao lado do hook (caminho `./`) → asset `.ts`;
- [`node_modules/next/dist/docs/01-app/03-api-reference/08-turbopack.md`](../node_modules/next/dist/docs/01-app/03-api-reference/08-turbopack.md)
  não lista Web Workers entre os recursos suportados — só cita `new Worker()`
  na tabela de _magic comments_.

As três saídas possíveis eram:

|                                           | Custo                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Migrar o projeto para `--webpack`         | Trocar o bundler inteiro por causa de um passo de importação — a cauda balançando o cachorro |
| Worker em JS puro em `public/`            | Duplicaria as regras de validação e dedupe, exatamente a duplicação que a §1.4 evita         |
| **Fatiamento cooperativo na main thread** | Tempo total um pouco maior                                                                   |

**Implementado: fatiamento cooperativo.** `normalize.ts` expõe
`createAudienceNormalizer()` (acumulador incremental) e
`useSpreadsheetParser` processa em lotes de 2 000 linhas, cedendo o controle
ao navegador com `setTimeout(0)` entre eles — macrotask, não microtask, porque
microtask roda antes da pintura e não deixaria a barra de progresso andar.
A aba continua respondendo e o progresso é determinístico.

O acumulador incremental é o que garante que a versão fatiada e a síncrona
apliquem **as mesmas regras**: duas implementações seriam duas chances de
divergir, e a divergência apareceria como "o mesmo arquivo dá contagens
diferentes conforme o tamanho".

Permanece bloqueando por ~1–2 s num `.xlsx` grande a descompactação dentro do
`read-excel-file`, que é uma chamada única e indivisível. O spinner cobre esse
intervalo.

> Se o Turbopack passar a suportar Workers, a migração é local: o corpo de
> `normalizeCooperatively` vira o corpo do Worker e o resto do hook não muda.

### 3.5 Pipeline de normalização

Ordem fixa — cada etapa produz um contador exibido no resumo pós-parse:

1. **Extrair** → `RawAudienceRow[]` (parser específico da fonte).
2. **Sanitizar telefone** → `sanitizePhoneForMeta` ([phone-utils.ts](../src/lib/whatsapp/phone-utils.ts)).
3. **Validar E.164** → `isValidE164`; falhas viram `InvalidRow` com `sourceRow`
   e motivo (nunca são descartadas em silêncio).
4. **Dedupe no arquivo** → `dedupeByPhone` ([dedupe.ts:86](../src/lib/contacts/dedupe.ts#L86)).
5. **Cruzar com a base** (no servidor, no `stage`) → marca cada linha como
   `existing_contact_id` ou `new`, via `phone_normalized` (migração 022) — o
   mesmo caminho do [import-modal.tsx:231-241](../src/components/contacts/import-modal.tsx#L231-L241).

Resultado exibido antes da triagem:
`1 240 lidas · 1 198 válidas · 31 duplicadas · 11 inválidas · 842 já são contatos`.

---

## 4. API e gerenciamento de estado do limite Meta

### 4.1 Onde o tier mora

**Rota:** `GET /api/whatsapp/messaging-limit`
**Arquivo:** `src/app/api/whatsapp/messaging-limit/route.ts`
**Rate limit:** nova entrada `messagingLimit: { limit: 20, windowMs: 60_000 }` em
[RATE_LIMITS](../src/lib/rate-limit.ts#L124).

Fluxo do handler:

1. `supabase.auth.getUser()` → 401 se ausente (padrão de
   [broadcast/route.ts:66-72](../src/app/api/whatsapp/broadcast/route.ts#L66-L72)).
2. Resolver `account_id` via `profiles` (mesmo padrão, [:87-98](../src/app/api/whatsapp/broadcast/route.ts#L87-L98)).
3. Ler `whatsapp_config` da conta; `decrypt(config.access_token)`.
4. Se `messaging_limit_cached_at` tiver menos de 15 min, devolver o cache
   (§4.4) e pular a Graph API.
5. Chamar `fetchMessagingLimit({ phoneNumberId, accessToken })` — função nova
   em [meta-api.ts](../src/lib/whatsapp/meta-api.ts), _named params_, erros via
   `throwMetaError`.
6. Calcular `usedLast24h` (§4.2) e responder.

**Resposta (200 em todos os casos não-auth, seguindo o contrato do
[config/route.ts](../src/app/api/whatsapp/config/route.ts#L49-L61)):**

```jsonc
{
  "tier": "TIER_1K",
  "tierCap": 1000,
  "usedLast24h": 340,
  "remaining": 660,
  "windowResetsAt": "2026-08-07T14:12:00Z",
  "source": "meta" | "cache" | "fallback",
  "checkedAt": "2026-08-06T18:03:11Z"
}
```

#### 4.1.1 Sobre o campo e a versão da Graph API — ponto que precisa de validação

O pedido especifica
`GET /v26.0/{id}?fields=whatsapp_business_manager_messaging_limit`. Três
observações honestas antes de codificar:

1. **O repositório está fixado em `v21.0`**
   ([meta-api.ts:12](../src/lib/whatsapp/meta-api.ts#L12)). Subir para `v26.0`
   afeta _todas_ as chamadas (envio, templates, mídia, registro), não só esta.
   **Recomendação:** manter `META_API_VERSION` em `v21.0` e, se este campo só
   existir em versões mais novas, declarar uma constante local
   `MESSAGING_LIMIT_API_VERSION` — subir a versão global merece PR próprio,
   com o sync de templates revalidado.
2. **O nome do campo precisa ser confirmado contra a conta real.** O campo que
   documentei como estável no nó _phone number_ é `messaging_limit_tier`;
   `whatsapp_business_manager_messaging_limit` aparece associado ao nó de
   Business Manager. Não vou afirmar com falsa confiança qual dos dois a sua
   conta retorna.
   **Mitigação de projeto:** pedir os dois campos e normalizar o que voltar —
   isso remove a dúvida do caminho crítico:

   ```ts
   const FIELDS = [
     'messaging_limit_tier',
     'whatsapp_business_manager_messaging_limit',
   ].join(',');
   // parseTier() aceita qualquer um dos dois, tolera ausência do outro.
   ```

3. **Tier desconhecido ⇒ o mais restritivo.** Se a Meta devolver um valor não
   mapeado, `parseTier` retorna `TIER_250`, nunca "ilimitado". Falhar fechado é
   a única postura defensável aqui.

```ts
const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};
```

### 4.2 O invariante que muda o desenho: janela deslizante de 24 h

O tier da Meta limita **conversas de marketing iniciadas pelo negócio em uma
janela deslizante de 24 h**, contadas por cliente único — não mensagens por
disparo. Duas consequências práticas:

- Três disparos de 400 contatos no mesmo dia estouram o `TIER_1K`, ainda que
  cada um esteja individualmente "dentro do limite".
- A cota disponível **agora** depende do que já foi enviado nas últimas 24 h.

Portanto a validação correta não é `selecionados ≤ tierCap`, e sim:

```
remaining   = tierCap − usedLast24h
selecionados ≤ remaining
```

`usedLast24h` sai de uma query própria — contatos **distintos** com
`broadcast_recipients.sent_at` nas últimas 24 h, dentro da conta:

```sql
-- RPC: broadcast_quota_usage(p_account_id UUID) → BIGINT
SELECT COUNT(DISTINCT br.contact_id)
FROM broadcast_recipients br
JOIN broadcasts b ON b.id = br.broadcast_id
WHERE b.account_id = p_account_id
  AND br.sent_at >= NOW() - INTERVAL '24 hours'
  AND br.status IN ('sent','delivered','read','replied');
```

Isso é uma aproximação — a Meta conta pela própria contabilidade de conversas,
não pela nossa —, e a SPEC assume isso explicitamente. Por isso o §6.2 propõe
uma **margem de segurança configurável** (padrão 5 %): o CRM bloqueia um pouco
antes do teto real, em vez de descobrir o limite por rejeição da API.

> `SECURITY INVOKER` não serve aqui: a RLS de `broadcast_recipients`
> ([017:566-572](../supabase/migrations/017_account_sharing.sql#L566-L572)) é
> por conta e funcionaria, mas a agregação `DISTINCT` sobre a tabela inteira é
> cara sob RLS por linha. Usar `SECURITY DEFINER` **com guarda
> `is_account_member(p_account_id)` no corpo** e ACL restrita a
> `authenticated`, exatamente como as `dashboard_*` da 039 e como a 042 exige.

### 4.3 Segurança: o token nunca chega ao browser

`whatsapp_config.access_token` está cifrado em repouso e só é decifrado no
servidor ([broadcast/route.ts:154](../src/app/api/whatsapp/broadcast/route.ts#L154)).
A chamada de exemplo do pedido traz um `Bearer EAAJB…` — **essa chamada
precisa acontecer server-side**. Um `fetch` à Graph API a partir do componente
React exporia o token de sistema da conta a qualquer usuário com o DevTools
aberto, incluindo um `viewer`. Não há variante aceitável disso.

Consequência: `MessagingLimitProvider` consome a rota interna. Nunca a Meta.

### 4.4 Estado global e cache

**Persistência** — duas colunas novas em `whatsapp_config` (migração 044, §8.1):

| Coluna                       | Tipo          | Uso                   |
| ---------------------------- | ------------- | --------------------- |
| `messaging_limit_tier`       | `TEXT`        | Último tier conhecido |
| `messaging_limit_checked_at` | `TIMESTAMPTZ` | TTL do cache (15 min) |

Guardar em coluna, e não só em memória, dá dois ganhos: sobrevive a restart do
processo (relevante no self-host single-instance, como o
[rate-limit.ts](../src/lib/rate-limit.ts#L1-L21) já assume) e serve de
`fallback` quando a Graph API está fora — o medidor mostra o último tier
conhecido com um selo "desatualizado" em vez de sumir.

**Estado no cliente** — Context espelhando `AuthProvider`, montado no layout de
`/broadcasts`:

```tsx
// src/components/broadcasts/messaging-limit-provider.tsx
interface MessagingLimitValue {
  tier: string | null;
  tierCap: number;
  usedLast24h: number;
  remaining: number;
  loading: boolean;
  /** true quando a Meta falhou e estamos exibindo o último valor salvo */
  stale: boolean;
  refresh: () => Promise<void>;
}
export function useMessagingLimit(): MessagingLimitValue;
```

Montagem em `src/app/(dashboard)/broadcasts/layout.tsx` (arquivo novo) — assim
`/broadcasts`, `/broadcasts/new`, `/triage` e `/broadcasts/[id]` compartilham
**uma** busca, atendendo ao "ao navegar para a rota, buscar o limite" sem
refazer a chamada a cada passo do wizard.

### 4.5 Onde o limite é efetivamente aplicado

Um teto exibido e não aplicado é decoração. Quatro pontos de imposição:

| #   | Ponto                               | Comportamento                                                                                                      |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Pós-parse, antes do stage           | `rows.length > remaining` → aviso com opção de "importar mesmo assim e triar" (o corte pode acontecer na triagem). |
| 2   | Triagem, ao selecionar              | `QuotaMeter` fica vermelho; botão "Continuar" desabilita com motivo textual.                                       |
| 3   | Passo 4, antes de enviar            | Revalida com `refresh()` — a cota pode ter mudado se um colega disparou nesse meio-tempo.                          |
| 4   | **Servidor, no `stage` e no envio** | Revalidação autoritativa. Os itens 1–3 são UX; **este** é o controle. Um cliente adulterado não passa.             |

Estados degradados: se `source === 'fallback'` (Meta inacessível), a UI mostra
selo de desatualizado e o servidor aplica o **último tier conhecido**. Se nunca
houve leitura, aplica `TIER_250`. Nunca "sem limite".

---

## 5. Triagem e analytics histórico

### 5.1 Enriquecimento por contato

Cada linha da triagem carrega histórico. Coluna a coluna:

| Coluna              | Origem                                | Observação                                                                                        |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Seleção             | `broadcast_audience_staging.selected` | `<Checkbox>` existente                                                                            |
| Nome / Telefone     | staging + `contacts`                  | Badge "Novo" quando `existing_contact_id IS NULL`                                                 |
| Status              | derivado                              | `válido` · `inválido` · `duplicado` · `excluído por tag`                                          |
| Campanhas recebidas | `COUNT(broadcast_recipients)`         | Só status terminais                                                                               |
| Última entrega      | `MAX(delivered_at)`                   | Relativo, via `date-fns` (já é dependência)                                                       |
| Leu alguma?         | `bool_or(read_at IS NOT NULL)`        | ✅ / —                                                                                            |
| Respondeu alguma?   | `bool_or(replied_at IS NOT NULL)`     | ✅ / —                                                                                            |
| Falhas              | `COUNT(status='failed')`              | ≥ 2 → candidato a número morto (§6.4)                                                             |
| Etiquetas           | `contact_tags`                        | Reusa o chip de [step2:345-364](../src/components/broadcasts/step2-select-audience.tsx#L345-L364) |

### 5.2 Dashboard macro

Acima da tabela, dois blocos:

**(a) Cards agregados da conta** — reusa `StatCard` de
[\[id\]/page.tsx:48-66](<../src/app/(dashboard)/broadcasts/[id]/page.tsx#L48-L66>),
promovido para `src/components/broadcasts/stat-card.tsx`:

`Campanhas enviadas` · `Mensagens entregues` · `Taxa de leitura` ·
`Taxa de resposta` · `Contatos alcançados (únicos)` · `Cota 24 h usada`

**(b) Recorte da audiência atual** — o número que realmente decide a triagem:
_"desta lista de 1 198, 842 já receberam campanhas; 61 % leram; 12 % responderam;
27 nunca entregaram."_

Série temporal de 30 dias com `recharts` (`package.json:60` — nenhuma
dependência nova).

O bloco (a) e a série saem de `broadcast_account_stats` e
`broadcast_engagement_series` (migração 047, §8.4); o bloco (b) já vinha de
`audience_engagement_summary` (046). A cota de 24 h é a única que **não** entra
na 047: ela já está no `MessagingLimitProvider` da fase 2, e duplicá-la aqui
criaria duas fontes de verdade para o mesmo número — exatamente o defeito que a
§1.2 aponta no passo 4.

### 5.3 Como isso escala (e por que não pode ser feito no cliente)

Ingênuo: para cada contato staged, buscar seus `broadcast_recipients`. Com
1 198 contatos isso são 1 198 round-trips — ou um `.in()` que **estoura o teto
de ~1000 valores do PostgREST**, precisamente o problema documentado no
cabeçalho da migração [025](../supabase/migrations/025_filter_contacts_by_tags.sql#L7-L20)
e contornado por paginação em
[fetchCustomValueIndex](../src/hooks/use-broadcast-sending.ts#L131-L133).

**Solução, seguindo o precedente da 025:** uma RPC que faz join, agregação,
filtro, ordenação e paginação em uma consulta.

```sql
-- RPC: triage_audience_page(
--   p_draft_id UUID, p_search TEXT, p_filter TEXT,
--   p_limit INT DEFAULT 50, p_offset INT DEFAULT 0
-- ) RETURNS TABLE (…, total_count BIGINT)
```

- `SECURITY INVOKER` — a RLS de `broadcasts`/`broadcast_recipients`
  ([017:479-484, 566-572](../supabase/migrations/017_account_sharing.sql#L479-L484))
  já escopa por conta; sem bypass de privilégio, igual à 025.
- `count(*) OVER()` para o total antes do `LIMIT`, como na 025.
- Página de 50 linhas; scroll infinito na tabela.
- **Exige** `CREATE INDEX idx_broadcast_recipients_contact ON
broadcast_recipients(contact_id) WHERE contact_id IS NOT NULL` — hoje só há
  índice por `broadcast_id` ([001:334](../supabase/migrations/001_initial_schema.sql#L334)).
  Sem ele, cada agregação de histórico é seq scan.
- "Selecionar todos" **não** carrega todas as páginas: vira um `UPDATE`
  server-side sobre o `draftId` com o mesmo predicado de filtro. Selecionar
  50 000 linhas é um comando, não 50 000 mutações de estado.

### 5.4 Ações em massa na triagem

Aplicadas server-side sobre o rascunho, todas idempotentes: selecionar/limpar
tudo (respeitando filtro), inverter seleção, remover inválidos, remover quem
falhou ≥ 2 vezes, remover quem já recebeu nos últimos N dias (§6.2), remover
por etiqueta, manter só quem já respondeu alguma campanha.

---

## 6. Propostas de excelência

Ordenadas por relação valor/esforço. Cada uma indica o que já existe a favor.

### 6.1 ⭐ Mover o envio para o servidor ✅ _(fase 6 — implementada em 2026-08-07)_

O disparo do dashboard rodava **no browser**: `use-broadcast-sending.ts`
percorria os lotes com `await fetch(...)` + `sleep(1000)`. Fechar a aba matava
a campanha no meio, deixando destinatários em `pending` para sempre. Com
audiências de milhares vindas de planilha (fases 1–3), deixou de ser risco
teórico.

**O que foi construído**

| Peça                                         | Caminho                                                                    | Papel                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/broadcasts/send`                  | [send/route.ts](../src/app/api/broadcasts/send/route.ts)                   | Rota interna do wizard. Persiste, responde **202**, faz o fan-out em `after()`.          |
| `planDashboardBroadcast`                     | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)         | Metade "planejar": config, template, audiência, cota, telefones, linhas.                 |
| `resolveAudienceContacts`                    | [audience/resolve.ts](../src/lib/audience/resolve.ts)                      | `AudienceConfig` → `Contact[]`, paginado. Absorveu o `upsertCsvContacts` do hook (§1.4). |
| `resolveVariables` / `fetchCustomValueIndex` | [broadcast-variables.ts](../src/lib/whatsapp/broadcast-variables.ts)       | Saíram do hook sem reescrita — nada ali dependia do navegador.                           |
| `loadAccountQuota`                           | [messaging-limit-server.ts](../src/lib/whatsapp/messaging-limit-server.ts) | Cota autoritativa, compartilhada com `GET /api/whatsapp/messaging-limit`.                |
| `supabaseAdmin`                              | [supabase/admin.ts](../src/lib/supabase/admin.ts)                          | Canônico. Os três wrappers de `ai`/`flows`/`automations` passaram a reexportá-lo.        |

O fan-out continua sendo o `deliverBroadcast` de
[broadcast-core.ts](../src/lib/whatsapp/broadcast-core.ts) — o mesmo que a API
pública usa, com retry por variante de telefone, reassinatura de header de
mídia e contadores do trigger (003/005). Ganhou só um parâmetro aditivo,
`DeliverOptions { batchSize, delayMs }`, para o painel manter o ritmo de 10/s
que o laço do navegador tinha; omitido, o comportamento da API pública não
muda.

**Quatro decisões que o desenho impõe**

1. **A rota recebe o FILTRO, não a lista.** O corpo carrega etiquetas / campo
   personalizado / linhas importadas; quem resolve em contatos é o servidor.
   Aceitar a lista pronta do cliente seria deixar o navegador escolher para
   quem o servidor envia.
2. **A cota é reconferida no servidor.** É o item 4 da §4.5 — os avisos do
   wizard são UX; este é o controle. Telefones inválidos são descontados antes
   do teste: nunca viram conversa na Meta, então não devem consumir cota.
3. **O fan-out usa service-role, o planejamento usa o cliente SSR.** O cliente
   SSR carrega o access token daquele request e não o renova
   ([server.ts](../src/lib/supabase/server.ts)); um disparo de milhares roda
   por minutos depois da resposta e passaria a falhar calado quando o token
   vencesse — que é exatamente a falha que esta fase existe para eliminar. O
   planejamento continua sob RLS, então o escopo de conta é decidido pelo
   banco, não por código.
4. **`createBroadcast` NÃO foi reusado.** Ele resolve cada destinatário com
   `findOrCreateContact`, uma ida ao banco por telefone — certo para uma
   requisição de API com até 1000 números soltos, errado para uma audiência já
   resolvida em lote. O `MAX_RECIPIENTS = 1000` daquela função permanece como
   contrato da API pública; o painel tem o próprio teto
   (`MAX_DASHBOARD_RECIPIENTS = 50 000`, casando com o teto do parser da §3.4)
   e o teto de produto continua sendo a cota de 24 h.

**Efeitos colaterais corrigidos no caminho**

- A resolução da audiência agora **pagina**. A versão do navegador usava
  `select('*')` sem `.range()`, cortado em ~1000 linhas pelo PostgREST: uma
  conta com 3 000 contatos via "3 000" na confirmação e alcançava 1 000.
- `/broadcasts/[id]` ganhou **polling** enquanto o status é `sending` (mesmo
  padrão da lista, com pausa em aba oculta). Sem isso o redirect pós-envio
  mostraria uma foto congelada, já que a rota responde antes de enviar.

**Limite conhecido.** O `after()` roda dentro do `maxDuration` da rota. Em
self-host — o alvo deste projeto — o processo é longevo e isso não morde; em
plataforma serverless, uma audiência grande pode ser cortada no meio e deixar
destinatários em `pending`. A saída completa é fila durável / cron de
drenagem, registrada no item 8 da §12.

### 6.2 Cooldown / anti-fadiga ✅ _(implementada em 2026-08-08)_

Configuração por conta: "não enviar marketing ao mesmo contato mais de uma vez
a cada N dias" (padrão 7). Aplicado como filtro automático na triagem, com o
contador visível (_"213 contatos em cooldown"_) e opção de override explícito
para `admin`. Usa o mesmo índice `(contact_id)` da §5.3. É o controle que mais
protege a **qualidade do número** — que por sua vez governa o tier da §4.

O filtro `cooldown` já existia desde a fase 4 (046) como preset OPCIONAL de
engajamento, com `7 dias` cravado em SQL. O que faltava era exatamente o que
o parágrafo acima pede: um número configurável por conta, e o filtro deixar
de ser algo que o agente precisa lembrar de aplicar.

**O que foi construído**

| Peça                                                                            | Caminho                                                                                           | Papel                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_config.broadcast_cooldown_days`                                       | [050](../supabase/migrations/050_broadcast_cooldown.sql)                                          | Configuração por conta, `DEFAULT 7`, `CHECK 0–90`. `0` = cooldown desativado.                                                                                                                                                                  |
| `triage_row_matches` (+1 parâmetro)                                             | [050](../supabase/migrations/050_broadcast_cooldown.sql)                                          | O `INTERVAL '7 days'` fixo virou `make_interval(days => p_cooldown_days)`. DROP + CREATE — mesma armadilha de sobrecarga da 048.                                                                                                               |
| `triage_audience_page` / `audience_engagement_summary` / `triage_set_selection` | [050](../supabase/migrations/050_broadcast_cooldown.sql)                                          | Resolvem os dias da CONTA (via `whatsapp_config`, a partir do `account_id` do rascunho) uma vez por chamada e repassam ao predicado — assinatura externa inalterada, `CREATE OR REPLACE` sem DROP.                                             |
| Auto-deselect no stage                                                          | [stage.ts](../src/lib/audience/stage.ts)                                                          | Depois do INSERT das linhas staged, `stageAudience` chama `triage_set_selection(draftId, false, null, 'cooldown')` — a mesma RPC do §5.3, sem duplicar o predicado em TypeScript. É o "filtro automático" do parágrafo original.               |
| `removeCooldown` / `overrideCooldown`                                           | [triage-toolbar.tsx](../src/components/broadcasts/audience/triage/triage-toolbar.tsx)             | Dois botões no toolbar: remover (todo agente, espelha `removeOptedOut`) e reincluir em massa (só admin+, via `useCan('override-cooldown')`).                                                                                                   |
| Contador visível                                                                | [engagement-dashboard.tsx](../src/components/broadcasts/audience/triage/engagement-dashboard.tsx) | Frase condicional no resumo (§5.2b), mesmo padrão da linha de opt-out: _"N receberam uma campanha há pouco tempo e foram desmarcados automaticamente (cooldown)."_                                                                             |
| Configuração na UI                                                              | [whatsapp-config.tsx](../src/components/settings/whatsapp-config.tsx)                             | Card "Cooldown / anti-fadiga" em Configurações > WhatsApp. Escreve direto em `whatsapp_config` (a policy `whatsapp_config_update` da 017 já é admin+), sem passar pela rota `POST /api/whatsapp/config` que reverifica credenciais com a Meta. |
| `canOverrideCooldown`                                                           | [roles.ts](../src/lib/auth/roles.ts)                                                              | `hasMinRole(role, 'admin')` — mesmo piso de `canManageMembers`/`canEditSettings`.                                                                                                                                                              |

**Três decisões que o desenho impõe**

1. **Diferente da janela de horário (§6.3), este É configurável por conta.**
   A §6.3 deliberadamente manteve `SEND_WINDOW` como constante porque nada
   pedia o contrário; a §6.2 pede "configuração por conta" explicitamente, e
   contas diferentes toleram fadiga de forma bem diferente. `0` desativa o
   cooldown por completo — é um valor válido, não um erro de digitação, e
   por isso não vira "sem cooldown = nunca casa" por acidente (o predicado
   testa `p_cooldown_days > 0` antes de comparar datas).
2. **Não é um bloqueio rígido como o opt-out (§6.8).** Cooldown é uma
   heurística de qualidade de número, não uma restrição legal —
   `planDashboardBroadcast` continua sem tocar em cooldown, e uma linha
   reselecionada (pelo botão de override ou por um clique direto no
   checkbox da tabela) sai no disparo normalmente. Só o _padrão_ de seleção
   muda; nada no envio ganhou uma exclusão nova.
3. **O override é uma guarda de UI, não de banco.** `triage_set_selection`
   continua exigindo só `agent`+ (a mesma `bas_modify` da 045). Qualquer
   agente já podia reselecionar uma linha individual em cooldown pelo
   checkbox antes desta fase existir — uma guarda só na chamada em massa
   não fecharia superfície nenhuma, então `useCan('override-cooldown')`
   existe para tornar "trazer todo mundo de volta" uma ação deliberada de
   admin, não uma restrição de segurança.

### 6.3 Agendamento e janela de horário ✅ _(fase 7 — implementada em 2026-08-07)_

`broadcasts.scheduled_at` existia desde [001:302](../supabase/migrations/001_initial_schema.sql#L302)
e o `CHECK` de status já aceitava `'scheduled'` ([001:303](../supabase/migrations/001_initial_schema.sql#L303)).
Nunca havia sido escrito nem lido. Agora é o caminho de agendamento inteiro.

**O que foi construído**

| Peça                         | Caminho                                                                                                        | Papel                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/broadcasts/cron`   | [cron/route.ts](../src/app/api/broadcasts/cron/route.ts)                                                       | Varre o que venceu, adia o que está fora de hora, dispara o resto. Mesmo padrão de auth e claim de `/api/automations/cron`. |
| `scheduleDashboardBroadcast` | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)                                             | Grava a INTENÇÃO (`status='scheduled'`). Não resolve audiência, não cria destinatário, não toca na cota.                    |
| `send-window.ts`             | [send-window.ts](../src/lib/broadcasts/send-window.ts) + [.test.ts](../src/lib/broadcasts/send-window.test.ts) | Janela permitida, aritmética de fuso (`Intl`, duas passadas para DST) e `nextWindowOpening`.                                |
| `parse-input.ts`             | [parse-input.ts](../src/lib/broadcasts/parse-input.ts)                                                         | O validador de `AudienceConfig` saiu da rota: agora o cron valida o `audience_filter` persistido com o MESMO código.        |
| Passo 4 do wizard            | [step4-schedule-send.tsx](../src/components/broadcasts/step4-schedule-send.tsx)                                | "Enviar agora" / "Agendar", campo de data-hora, aviso de janela, botão "mover para o próximo horário" e caixa de override.  |

**Cinco decisões que o desenho impõe**

1. **A audiência é resolvida no ENVIO, não no agendamento.** O que fica
   gravado é o filtro. Congelar a lista faria quem entrou na etiqueta
   ontem ficar de fora, quem pediu opt-out de madrugada receber de manhã,
   e a cota conferida hoje não diz nada sobre a janela de 24 h que vai
   valer na hora. O cron chama o mesmo `planDashboardBroadcast` do
   disparo imediato.
2. **Fora da janela, ADIA — não dispara nem falha.** Um agendamento que
   vence às 23h (cron fora do ar, override removido depois) é empurrado
   para a próxima abertura. Disparar queima reputação; marcar como falho
   destrói a intenção do usuário. Adiar preserva as duas coisas, e o
   motivo vai para a trilha da §6.8 (`postponed_window`).
3. **`quota_exceeded` no cron também adia**, uma hora à frente
   (`blocked_quota`): a janela de 24 h é deslizante, então é uma condição
   temporária. Jogar a campanha fora por ela seria desproporcional.
4. **O fuso mora no agendamento, não no servidor.** `scheduled_timezone`
   guarda o fuso IANA de quem agendou (vindo de
   `Intl.DateTimeFormat().resolvedOptions().timeZone`, o mesmo padrão do
   gráfico da §5.2). Sem ele, "20h" seria avaliado no fuso do processo —
   e um agendamento das 19h em São Paulo pareceria 22h para o cron.
5. **`adoptBroadcastId`.** O cron trava a linha `scheduled` em `sending`
   (o claim é o lock) e passa o id para o planner ADOTAR. Sem isso o
   planner inseriria um broadcast novo e o agendamento ficaria pendurado
   em `sending` para sempre, ao lado de uma cópia enviada. O ramo
   `staged` foi generalizado para o mesmo caminho.

**Desvio deliberado: a janela é constante, não configuração por conta.**
`SEND_WINDOW` (dias úteis, 09:00–20:00) vive em
[send-window.ts](../src/lib/broadcasts/send-window.ts). Uma tabela de
configuração exigiria uma tela de configuração para não ficar imutável na
prática, e nada na §6.3 pede isso — o projeto é auto-hospedado e a janela
é política do operador. O que É por disparo é o override:
`broadcasts.window_override`, decidido no passo 4 e registrado na trilha.
Quem aceita mandar às 23h aceita naquele disparo, não para sempre.

**Efeito colateral resolvido no caminho:** `broadcasts.header_media_url`.
A ausência dessa coluna é o que o item 8 da §12 registrava como o que
"amarra esta correção a uma migração própria" — sem ela, nenhuma retomada
server-side (agendamento ou cron de drenagem) consegue preservar a mídia
de header escolhida no passo 3. Agora existe, e o disparo imediato também
a persiste.

**Limite conhecido.** O fan-out do cron roda em `after()`, com o mesmo
teto da §6.1, e cada invocação assume no máximo 5 campanhas
(`MAX_PER_RUN`). O excedente espera o próximo ping — melhor do que
assumir 50 e ser cortado no meio da décima.

### 6.4 Auto-limpeza de números mortos ✅ _(implementada em 2026-08-08)_

Contatos com ≥ 2 falhas consecutivas de entrega, ou erro Meta de "número
inválido/sem WhatsApp", recebem `contacts.whatsapp_status = 'invalid'` e são
excluídos por padrão de audiências futuras (reversível). Manter número morto na
base infla `total_recipients`, distorce todas as taxas e consome cota do tier.

**O que foi construído**

| Peça                                                                                            | Caminho                                                                                                                | Papel                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contacts.whatsapp_status` + motivo/hora                                                        | [049](../supabase/migrations/049_dead_number_cleanup.sql)                                                              | `valid` \| `invalid`. Default `valid` — número nunca testado não é "morto", é desconhecido.                                                           |
| `isInvalidWhatsappNumberError`                                                                  | [phone-utils.ts](../src/lib/whatsapp/phone-utils.ts)                                                                   | Casa o código Meta 131026 ("Message Undeliverable" — não é WhatsApp). Irmã de `isRecipientNotAllowedError` (131030, sandbox — outra coisa).           |
| `detectDeadNumberOnFailure` / `markWhatsappInvalid` / `markWhatsappValid` / `isWhatsappInvalid` | [whatsapp-status.ts](../src/lib/contacts/whatsapp-status.ts) + [.test.ts](../src/lib/contacts/whatsapp-status.test.ts) | Os dois gatilhos (erro Meta explícito, ou as 2 tentativas mais recentes falhas) num lugar só, chamado dos dois pontos que escrevem `status='failed'`. |
| Chamada em `deliverBroadcast`                                                                   | [broadcast-core.ts](../src/lib/whatsapp/broadcast-core.ts)                                                             | Envio síncrono (painel + API pública). `PlannedRecipient` ganhou `contactId` para a detecção saber quem falhou.                                       |
| Chamada em `handleStatusUpdate`                                                                 | [webhook/route.ts](../src/app/api/whatsapp/webhook/route.ts)                                                           | Callback assíncrono de status da Meta — o único lugar onde o código 131026 realmente chega, já que o `errors[]` vem só aí.                            |
| Exclusão no planejador                                                                          | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)                                                     | Etapa 3b, logo depois do opt-out (§6.8) — mesmo tratamento: sai da audiência ANTES de virar destinatário, não depois como `failed`.                   |
| Exclusão na simulação a seco                                                                    | [broadcast-test-send.ts](../src/lib/whatsapp/broadcast-test-send.ts) (§6.7)                                            | Status `whatsapp_invalid` por contato — testar de novo não prova nada que a detecção não soubesse.                                                    |
| Exclusão na estimativa                                                                          | [estimate.ts](../src/lib/audience/estimate.ts)                                                                         | `EstimateOptions.excludeInvalidWhatsapp`, sempre `true` nos chamadores reais (passo 2 e passo 4).                                                     |
| Reversão manual                                                                                 | [contact-detail-view.tsx](../src/components/contacts/contact-detail-view.tsx)                                          | Selo "Número morto" + botão "Marcar como válido de novo" na aba Detalhes — só aparece quando o status não é o default.                                |

**Três decisões que o desenho impõe**

1. **Ao contrário do opt-in (§6.8), nenhuma RPC nova e nenhuma trilha de
   eventos.** O status de WhatsApp não carrega a exigência legal que o
   consentimento carrega (LGPD) — é uma heurística operacional, reversível a
   qualquer momento, sem consequência jurídica em não ter histórico de
   mudanças. A política `contacts_update` (017) já autoriza `agent`+ a
   escrever qualquer coluna da própria conta; um `UPDATE` direto, tanto na
   detecção automática quanto na reversão manual, não abre superfície nova.
2. **Ao contrário do opt-out, a exclusão NÃO depende da categoria do
   template.** Um número morto nunca vale a pena tentar de novo, mesmo para
   Utility/Authentication — por isso `excludeInvalidWhatsapp` é sempre `true`
   nos chamadores reais, nunca calculado a partir de `template.category`.
3. **"Consecutivas" são as duas tentativas MAIS RECENTES, não a contagem
   vitalícia.** A triagem já mostra `failure_count >= 2` como preset
   "problematic" (§5.1/§6.5) — um número vitalício. Um contato que falhou
   duas vezes há seis meses e entrega normalmente desde então não é morto;
   `detectDeadNumberOnFailure` olha só para as últimas duas linhas de
   `broadcast_recipients`, ordenadas por `created_at DESC`.

**Lacuna conhecida, documentada no código.** `audience_engagement_summary`
(RPC da 048, usada pela estimativa de audiências `staged` e pela triagem)
ainda não conhece `whatsapp_status` — estender a view `broadcast_audience_triage`
e as assinaturas de `triage_row_matches`/`triage_audience_page` ficou fora
desta fase para não abrir uma segunda frente de migração SQL grande dentro do
mesmo PR. O ponto de imposição de verdade (`planDashboardBroadcast`) filtra
correto de qualquer forma, porque opera sobre `Contact[]` já materializado, e
não sobre a RPC — o único efeito da lacuna é a triagem poder mostrar um
número um pouco otimista para audiências que passaram pela triagem, até a
view ganhar a coluna.

### 6.5 Segmentação por engajamento

Presets de um clique na triagem, montados sobre os mesmos agregados da §5.1:

| Preset                 | Predicado                               |
| ---------------------- | --------------------------------------- |
| 🔥 Engajados           | respondeu ≥ 1 campanha nos últimos 30 d |
| 👀 Leem, não respondem | leu ≥ 1, respondeu 0                    |
| 😴 Adormecidos         | recebeu ≥ 3, leu 0                      |
| ✨ Nunca contatados    | 0 campanhas                             |
| ⚠️ Problemáticos       | ≥ 2 falhas                              |

Enviar para "adormecidos" com template de marketing é o caminho mais rápido
para denúncia de spam — o preset serve tanto para _mirar_ quanto para _evitar_.

### 6.6 Teste A/B de template ✅ _(implementada em 2026-08-08)_

`broadcasts.parent_broadcast_id` + `variant_label`. A audiência triada é
dividida aleatoriamente (50/50 ou configurável) entre dois templates
aprovados; o `[id]/page.tsx` ganha uma visão comparativa reusando o
`FunnelChart` existente. Significância estatística só é reportada acima de
~300 destinatários por braço — abaixo disso, exibir o dado sem o selo de
"amostra pequena" induz decisão errada.

**O que foi construído**

| Peça                                 | Caminho                                                                                                                                           | Papel                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Colunas + invariantes                | [051](../supabase/migrations/051_broadcast_ab_test.sql)                                                                                           | `parent_broadcast_id`, `variant_label`, `ab_split_percent`; CHECK de forma, índice único (um B por A) e gatilho de profundidade 1.             |
| Sorteio + estatística                | [ab-test.ts](../src/lib/broadcasts/ab-test.ts) + [.test.ts](../src/lib/broadcasts/ab-test.test.ts)                                                | `splitInTwo` (embaralha e fatia — tamanhos exatos), teste z de duas proporções e o piso de 300 por braço. Módulo puro, sem banco nem relógio.  |
| `planAbTestBroadcast`                | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)                                                                                | Uma audiência resolvida uma vez, dois braços materializados. As etapas 1–5 da §6.1 viraram funções nomeadas e são as MESMAS dos dois caminhos. |
| Ramo A/B do disparo e do agendamento | [send/route.ts](../src/app/api/broadcasts/send/route.ts)                                                                                          | Lê `abTest` do corpo (`parseAbTest`), audita o par e faz o fan-out dos dois braços em SEQUÊNCIA no mesmo `after()`.                            |
| Par no cron                          | [cron/route.ts](../src/app/api/broadcasts/cron/route.ts)                                                                                          | A varredura ignora variantes B (`parent_broadcast_id IS NULL`); o claim, o adiamento e a volta por cota valem para o par inteiro.              |
| Escolha da variante + divisão        | [step1-choose-template.tsx](../src/components/broadcasts/step1-choose-template.tsx)                                                               | Painel opcional, só com templates aprovados **da mesma categoria**, e a divisão (50/50 … 90/10).                                               |
| Mapeamento por variante              | [step3-personalize.tsx](../src/components/broadcasts/step3-personalize.tsx)                                                                       | Uma aba por braço: `{{1}}` de um template não é o `{{1}}` do outro. O "Próximo" olha os dois.                                                  |
| Comparação                           | [variant-comparison.tsx](../src/components/broadcasts/variant-comparison.tsx) + [funnel-chart.tsx](../src/components/broadcasts/funnel-chart.tsx) | Dois funis lado a lado (o `FunnelChart` saiu da página para ser reusado), tabela de taxas, selo de vencedor ou de amostra pequena.             |

**Quatro decisões que o desenho impõe**

1. **A variante A É a campanha; não existe linha "pai" vazia.** A é um
   `broadcasts` comum com `variant_label = 'A'`, e B aponta para ela.
   Assim tudo o que já existe continua valendo sem exceção — contadores
   do trigger agregador, webhooks de status, polling, export de CSV — e
   o usuário vê na lista duas campanhas, que é exatamente o que saiu.
2. **As duas variantes precisam ser da MESMA categoria.** Marketing
   exclui quem pediu opt-out (§6.8) e Utility não: um teste entre
   categorias compararia dois públicos com cara de comparar dois textos.
   A UI só oferece candidatos da mesma categoria; o planner recusa com
   `ab_category_mismatch` mesmo assim, porque a UI não é o controle.
3. **O sorteio é exato, não binomial.** Sortear contato a contato com
   `random() < 0.5` daria 487/513 num disparo e 511/489 no seguinte —
   braços desiguais gastam poder estatístico à toa e fazem o usuário
   desconfiar da tela. Embaralha-se e fatia-se. Os números inválidos são
   repartidos na mesma proporção, mas **em separado**, para que o tamanho
   dos braços não dependa de quantos números ruins caíram de cada lado.
4. **Abaixo de 300 por braço, nenhum vencedor é nomeado.** As taxas
   continuam visíveis (escondê-las seria esconder o resultado do
   disparo), mas o selo é "amostra pequena" e a frase inteira aparece no
   corpo do bloco. É a exigência literal desta seção — e o que impede
   alguém de trocar um template que estava bom por causa de 40 pessoas.

**Duas lacunas conhecidas, deliberadas.** (a) **Rascunho não guarda teste
A/B**: `broadcasts` tem UM `template_name`, então salvar um rascunho
perderia a variante B em silêncio — o botão "Salvar rascunho" some quando
o teste está ligado, e agendar (que preserva as duas linhas) continua
disponível. (b) **Não há promoção automática do vencedor** para o resto da
audiência: quem ganhou vira a escolha do próximo disparo, feito à mão. Um
"mandar o vencedor para os 80 % restantes" exigiria congelar a audiência
no primeiro disparo, que é justamente o que a §6.3 decidiu não fazer.

### 6.7 Simulação a seco (dry run) ✅ _(implementada em 2026-08-07)_

Botão "Enviar teste" que dispara para até 5 números escolhidos, usando dados
reais de personalização, **antes** de queimar cota com a audiência inteira.
Reusa `sendTemplateMessage` sem criar linhas de `broadcast_recipients`.
É a defesa mais barata contra `{{1}}` vazio chegando a 1 000 pessoas.

**O que foi construído**

| Peça                             | Caminho                                                                                                                            | Papel                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sendBroadcastTest`              | [broadcast-test-send.ts](../src/lib/whatsapp/broadcast-test-send.ts) + [.test.ts](../src/lib/whatsapp/broadcast-test-send.test.ts) | Resolve config + template, resolve variáveis por contato (`resolveVariables`/`fetchCustomValueIndex`, os MESMOS de `broadcast-dispatch.ts`) e chama `sendTemplateMessage` avulso, um por destinatário. |
| `POST /api/broadcasts/test-send` | [route.ts](../src/app/api/broadcasts/test-send/route.ts)                                                                           | Valida o corpo, chama `sendBroadcastTest`, responde sempre 200 com o resultado POR CONTATO. Rate limit próprio (`RATE_LIMITS.broadcastTestSend`).                                                      |
| `TestSendDialog`                 | [test-send-dialog.tsx](../src/components/broadcasts/test-send-dialog.tsx)                                                          | Botão "Enviar teste" no passo 3 (Personalização), ao lado da pré-visualização. Busca de contato é leitura direta sob RLS — mesmo padrão do `ContactsDirectory` do inbox, sem rota própria.             |

**Três decisões que o desenho impõe**

1. **Os destinatários são contatos reais, não números digitados à mão.**
   O mapeamento de variáveis do passo 3 aponta para `field`/`custom_field`
   de UM contato — testar com um número solto não resolveria nada nesses
   casos e o teste mentiria sobre exatamente o que ele existe para pegar.
   Escolher um contato existente é o que faz `{{1}}` resolver com dado de
   verdade, igual ao disparo real.
2. **Sem linha em `broadcasts`/`broadcast_recipients`.** Cada envio é uma
   chamada avulsa a `sendTemplateMessage` — o mesmo caminho que o composer
   do inbox já usa para um envio único. Sem linha, não há campanha para o
   cron encontrar nem contador para o trigger agregar, e por isso o teto de
   5 destinatários não precisa entrar na conta da cota de 24 h (§4): cinco
   conversas de teste são ruído perto do tier mais restritivo (`TIER_250`).
3. **Opt-out (§6.8) vale aqui também.** Um "teste" que ignorasse a
   categoria do template mandaria uma mensagem de marketing de verdade
   para quem já pediu para sair — a mesma regra (`excludesOptedOut`) do
   disparo real decide se o teste alcança um contato `opted_out`.

Resposta sempre 200 com o detalhe por contato (`sent` / `failed` /
`invalid_phone` / `opted_out` / `not_found`): um teste em que 3 de 5 números
falham não é um erro de rota, é exatamente a informação que o botão existe
para revelar.

### 6.8 Compliance BR / LGPD ✅ _(fase 7 — implementada em 2026-08-07)_

Isso não é polimento opcional no mercado brasileiro; é o que separa uma conta
que dura de uma que é banida — e, do lado jurídico, é o que a LGPD exige poder
_demonstrar_.

**O que foi construído**

| Peça                                   | Caminho                                                                                                                                                                                                                       | Papel                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `contacts.opt_in_status` + origem/hora | [048](../supabase/migrations/048_lgpd_consent_and_scheduling.sql)                                                                                                                                                             | Estado atual, barato de filtrar. Default `unknown` — ver a decisão 1 abaixo.                                        |
| `contact_consent_events`               | [048](../supabase/migrations/048_lgpd_consent_and_scheduling.sql)                                                                                                                                                             | Trilha **imutável** de declarações: quem, quando, por qual via, qual palavra-chave.                                 |
| `broadcast_audit_log`                  | [048](../supabase/migrations/048_lgpd_consent_and_scheduling.sql)                                                                                                                                                             | Trilha de disparo: quem disparou, para quantos, com qual template — e o que foi bloqueado.                          |
| `set_contact_opt_in` (RPC)             | [048](../supabase/migrations/048_lgpd_consent_and_scheduling.sql)                                                                                                                                                             | Estado + evento na MESMA transação. É o único caminho de escrita.                                                   |
| `detectOptOut`                         | [opt-out.ts](../src/lib/contacts/opt-out.ts) + [.test.ts](../src/lib/contacts/opt-out.test.ts)                                                                                                                                | "SAIR", "PARAR", "DESCADASTRAR" e variantes. Casamento EXATO — ver a decisão 3.                                     |
| `consent.ts`                           | [consent.ts](../src/lib/contacts/consent.ts)                                                                                                                                                                                  | `setContactOptIn`, `isOptedOut` e `excludesOptedOut` (a regra de produto, num lugar só).                            |
| Imposição no envio                     | [broadcast-dispatch.ts](../src/lib/whatsapp/broadcast-dispatch.ts)                                                                                                                                                            | Etapa 3 do planner: remove os `opted_out` antes de virar destinatário e antes da cota.                              |
| Triagem + wizard + contato             | view/RPCs da 048, [step2](../src/components/broadcasts/step2-select-audience.tsx) · [step4](../src/components/broadcasts/step4-schedule-send.tsx) · [contact-detail-view](../src/components/contacts/contact-detail-view.tsx) | Selo por linha, filtros `opted_out`/`optable`, ação "remover quem pediu para sair", e o estado editável no contato. |

**Cinco decisões que o desenho impõe**

1. **Default `unknown`, não `opted_in`.** A base existente veio de
   planilha e ninguém sabe o que cada pessoa consentiu; presumir
   consentimento retroativo seria gravar uma afirmação falsa no banco.
   `unknown` **não** bloqueia envio — bloquear invalidaria toda a base no
   dia da migração. Quem bloqueia é `opted_out`.
2. **A exclusão é por CATEGORIA de template.** `opted_out` nunca entra em
   audiência de _marketing_; um template Utility ("seu pedido saiu para
   entrega") continua alcançando. Bloquear tudo transformaria "pare de me
   vender coisas" em "pare de me avisar do que eu comprei". Categoria
   ausente ou desconhecida conta como marketing — o lado conservador é o
   único aceitável aqui. A regra mora em `excludesOptedOut`, e as três
   telas + o envio a consomem de lá, para o alcance não mudar de valor
   entre elas (a lição do §7, item 3).
3. **A detecção casa a mensagem INTEIRA, não substring.** "Não vou parar
   de comprar com vocês" contém "parar". Um falso positivo é um cliente
   perdido em silêncio; um falso negativo é um contato que o agente
   descadastra à mão. O caminho previsto para melhorar a cobertura é
   acrescentar frases à lista quando aparecerem nos dados, nunca afrouxar
   o predicado.
4. **Opt-out é REMOÇÃO da audiência, não destinatário `failed`.**
   Telefone inválido vira `failed` porque o usuário precisa ver que aquele
   número não presta. Opt-out não: materializá-lo como falha guardaria no
   banco o registro de uma tentativa de envio para quem pediu para não
   receber. Sai antes de existir linha; quantos saíram vai para a trilha.
5. **As duas trilhas não têm política de UPDATE nem de DELETE.** Não é
   esquecimento: trilha editável não é trilha. Só o `service_role` (o
   operador do self-host) alcança essas linhas. A asserção no fim da 048
   falha a migração se uma política dessas aparecer.

**Sobre "plugável nas automações"**: a detecção roda no webhook, **antes**
dos gatilhos, e não os suprime — o estado já está gravado quando um
`keyword_match` roda, então a confirmação de descadastro que o operador
quiser mandar é uma automação normal. A exceção é a resposta automática por
IA, que é suprimida: responder "SAIR" com um texto gerado por LLM é o
oposto do que a pessoa pediu, e consumiria uma mensagem em nome de quem
acabou de sair da lista.

**Uma correção de escopo que veio junto:** `fetchAllContacts` e
`contactsByIds` passaram a exigir `accountId`
([resolve.ts](../src/lib/audience/resolve.ts)). Sob RLS é redundante; sob
**service-role** — que é como o cron da §6.3 roda — é indispensável: um
`select('*')` em `contacts` devolveria a base de todas as contas, e uma
audiência `all` agendada disparia para o banco inteiro.

**E uma que a revisão de segurança pegou depois:** `resolveStagedAudience`
lia `broadcast_audience_staging` **só por `broadcast_id`**. Esse id vem de
`audience_filter`, um JSONB que o dono da campanha edita direto pelo
PostgREST (`broadcasts_update` da 017 libera `agent` na própria linha).
Sob RLS, apontá-lo para o rascunho de outra conta não devolve nada — mas o
cron lê com service-role: o `draftId` alheio faria o cron ler a audiência
staged daquela conta (telefone, nome, e-mail), materializá-la como contato
aqui e disparar para aquelas pessoas. Fechado com `.eq('account_id', …)` e
um teste de regressão. É a mesma travessia de conta que a política
`bas_modify` da 045 já fecha na escrita — o caminho de leitura sob
service-role era o que faltava.

---

## 7. Correções incluídas no escopo

Correções pequenas em código já lido, necessárias para a coerência do que esta
SPEC constrói:

| #   | Problema                                    | Local                                                                                                                                                                                                                                        | Correção                                                                                                     |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | UI de CSV inexistente                       | [step2](../src/components/broadcasts/step2-select-audience.tsx)                                                                                                                                                                              | Resolvido pela §3                                                                                            |
| 2   | Dedupe por `user_id` em conta compartilhada | [use-broadcast-sending.ts:248-252](../src/hooks/use-broadcast-sending.ts#L248-L252)                                                                                                                                                          | Trocar para `account_id`, alinhando ao [import-modal](../src/components/contacts/import-modal.tsx#L232-L234) |
| 3   | Duas fontes de verdade para o alcance       | [step2:140-220](../src/components/broadcasts/step2-select-audience.tsx#L140-L220) vs [step4:54-90](../src/components/broadcasts/step4-schedule-send.tsx#L54-L90)                                                                             | Extrair `estimateAudience()` para `src/lib/audience/estimate.ts`, consumido pelos dois                       |
| 4   | Strings hardcoded em inglês                 | [step2:464-486](../src/components/broadcasts/step2-select-audience.tsx#L464-L486), [step3:459-463](../src/components/broadcasts/step3-personalize.tsx#L459-L463), [step4:144,159](../src/components/broadcasts/step4-schedule-send.tsx#L144) | Mover para `messages/*.json`                                                                                 |
| 5   | Rascunho perde a configuração               | [new/page.tsx:112-115](<../src/app/(dashboard)/broadcasts/new/page.tsx#L112-L115>)                                                                                                                                                           | Resolvido pela §3.3                                                                                          |

---

## 8. Modelo de dados

### 8.1 Migração 044 — cache do tier + cota _(aplicada em `vn` e `rs` em 2026-08-07)_

Arquivo: [`044_messaging_limit_and_quota.sql`](../supabase/migrations/044_messaging_limit_and_quota.sql).

> ⚠️ **Lição da aplicação — `REVOKE ... FROM PUBLIC` não basta neste banco.**
>
> A primeira aplicação em `vn` deixou a ACL como
> `postgres=X | anon=X | authenticated=X | service_role=X`: **`anon` com
> EXECUTE numa função `SECURITY DEFINER`**, exatamente a falha que a
> [042](../supabase/migrations/042_lockdown_definer_rpcs.sql) existe para
> fechar. A causa: o Supabase mantém `ALTER DEFAULT PRIVILEGES` concedendo
> EXECUTE a `anon` e `authenticated` em toda função nova de `public`. Essa
> concessão é **nominal**, não herdada de `PUBLIC` — então o revoke de
> `PUBLIC` passa ao largo dela.
>
> Corrigido com `REVOKE ... FROM anon` explícito (o que a 042 já fazia, e eu
> não repliquei) mais um bloco de asserção que **aborta a migração** se o
> revoke não pegar. Toda RPC futura desta SPEC — 045, 046 — deve copiar esse
> par revoke+asserção, não só o `FROM PUBLIC`.
>
> Verificado após a correção, nos dois projetos:
> `anon_can_execute = false`, `authenticated_can_execute = true`, e chamada
> sem `auth.uid()` válido devolve `42501: Unauthorized`.

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS messaging_limit_tier       TEXT,
  ADD COLUMN IF NOT EXISTS messaging_limit_checked_at TIMESTAMPTZ;
```

**Desvio do plano:** a RPC `broadcast_quota_usage` e o índice
`idx_broadcast_recipients_contact` estavam na 046 (§8.3), mas a fase 2 depende
deles — sem a RPC não há `usedLast24h`, e sem o índice a agregação é seq scan
na maior tabela do módulo. Foram trazidos para a 044, que passa a ser coesa:
"tudo que o medidor de cota precisa". A 046 continua dona das RPCs de triagem.

Inclui também `idx_broadcast_recipients_sent_at` (parcial, `WHERE sent_at IS
NOT NULL`), que a janela de 24 h exige e não estava previsto.

### 8.2 Migração 045 — staging da audiência _(aplicada em `vn` e `rs` em 2026-08-07)_

Arquivo: [`045_broadcast_audience_staging.sql`](../supabase/migrations/045_broadcast_audience_staging.sql).

Tabela conforme o esboço original, com **dois desvios deliberados** e uma
adição:

1. **`phone_normalized` é coluna GERADA**, não escrita pela aplicação —
   `regexp_replace(phone, '\D', '', 'g')`, exatamente a expressão que a 022 usa
   em `contacts`. O cruzamento entre as duas tabelas depende de as duas colunas
   serem produzidas pela mesma regra; com escrita manual, um caminho que
   esquecesse de normalizar quebraria o casamento em silêncio.
2. **O índice único é PARCIAL** (`WHERE invalid_reason IS NULL AND
phone_normalized <> ''`). A §3.5 exige que linhas inválidas sobrevivam com
   `sourceRow` e motivo — mas `"abc"` e `"xyz"` normalizam ambos para `''` e
   colidiriam num índice total, fazendo o segundo insert falhar. Verificado nos
   dois bancos: duas linhas inválidas coexistem; uma duplicata **válida** em
   outra grafia (`55 11 90000-0001` vs `+5511900000001`) é barrada.
3. **`purge_stale_audience_staging(p_account_id, p_older_than_days)`** — a
   limpeza de 7 dias que a §3.3 pede. Apaga só as LINHAS STAGED, nunca o
   `broadcasts`: o rascunho é trabalho do usuário e a lista é reimportável.

RLS espelha `broadcast_recipients`
([017:566-572](../supabase/migrations/017_account_sharing.sql#L566-L572)):
`SELECT` para membro da conta, mutação a partir de `agent`. O `WITH CHECK`
carrega uma condição a mais que o esboço não previa — sem ela, um membro da
conta A poderia inserir linhas com `account_id = A` apontando para um
`broadcast_id` da conta B, passando na checagem de associação e ainda assim
poluindo o rascunho de outro.

### 8.3 Migração 046 — RPCs de triagem _(aplicada em `vn` e `rs` em 2026-08-07)_

Arquivo: [`046_triage_rpcs.sql`](../supabase/migrations/046_triage_rpcs.sql).

| Objeto                             | Papel                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `broadcast_audience_triage` (VIEW) | Definição ÚNICA de "linha de triagem enriquecida" (§5.1). `security_invoker = true` |
| `triage_assert_filter(TEXT)`       | Lista única de filtros válidos. Nome desconhecido **aborta**                        |
| `triage_row_matches(…)`            | Predicado único de filtro+busca, usado pelas três funções                           |
| `triage_audience_page(…)`          | Página + `count(*) OVER()`, padrão da 025                                           |
| `audience_engagement_summary(…)`   | Agregados da §5.2b                                                                  |
| `triage_set_selection(…)`          | Seleção em massa — **não estava no esboço**, ver abaixo                             |

**Por que uma view e dois helpers, e não três funções independentes.** Se cada
função fizesse o próprio join, "campanhas recebidas" poderia significar coisas
diferentes na tabela, no resumo e no filtro de seleção — e a divergência
apareceria como _"marquei 'nunca contatados' e vieram pessoas que já
receberam"_. Mesma lógica para o predicado.

**`triage_set_selection` entrou no escopo** porque a §5.3 é explícita — "*
selecionar todos não carrega todas as páginas: vira um UPDATE server-side*" — e
sem ela a fase 4 precisaria de outra migração. Mesmo movimento com que a 044
absorveu a RPC de cota que estava listada aqui.

**Um filtro desconhecido aborta em vez de virar "todos".** Em
`triage_set_selection`, tratar um typo como "sem filtro" marcaria a audiência
inteira. Verificado: `22023`.

> ⚠️ **Exceção consciente de `search_path`.** `triage_row_matches` é a única
> função desta SPEC **sem** `SET search_path` — uma função SQL com cláusula SET
> não é inlinável, e viraria uma chamada por linha sobre até 50 000 linhas.
> Confirmado por `EXPLAIN` nos dois bancos: o `Filter` do plano traz a
> expressão crua, não a chamada, e o `idx_broadcast_recipients_contact` da 044
> é usado no histórico. É seguro porque a função é `SECURITY INVOKER` e o corpo
> só usa `pg_catalog`. **Nenhuma outra função pode copiar esta exceção** — ela
> aparece como `function_search_path_mutable` no linter do Supabase, e é
> esperado.

Todas com o par completo — `REVOKE ALL … FROM PUBLIC`, **`REVOKE ALL … FROM
anon`** e `GRANT EXECUTE … TO authenticated` — mais o bloco de asserção que
aborta se o revoke não pegar. Ver o alerta na §8.1: só o revoke de `PUBLIC`
deixa a função aberta a `anon`. A view recebe o mesmo tratamento, porque o
default privilege do Supabase concede `SELECT` a `anon` também em views.

**Verificado empiricamente nos dois projetos**, com dados de teste dentro de
transação revertida:

| Teste                                                    | Resultado                            |
| -------------------------------------------------------- | ------------------------------------ |
| Membro da conta lê a view e a RPC                        | 1 linha / 1 linha ✅                 |
| Autenticado de **outra** conta                           | 0 / 0, e `set_selection` altera 0 ✅ |
| `anon` na view e na RPC                                  | `42501` nas duas ✅                  |
| `purge` sem `auth.uid()`                                 | `42501` ✅                           |
| Presets (`engaged`, `problematic`, `never_contacted`, …) | contagens corretas ✅                |
| `set_selection` chamado duas vezes                       | 2ª altera 0 (idempotente) ✅         |

### 8.4 Migração 047 — dashboard de engajamento _(aplicada em `vn` e `rs` em 2026-08-07)_

Arquivo: [`047_engagement_dashboard_rpcs.sql`](../supabase/migrations/047_engagement_dashboard_rpcs.sql).

A §12 (item 6) dizia que a fase 5 já tinha todo o schema de que precisava.
**Estava errado:** a 046 entrega o recorte da audiência aberta (§5.2b), não os
agregados da CONTA nem a série do gráfico (§5.2a). Sem estas duas funções, o
dashboard só teria o caminho que a §5.3 proíbe — baixar destinatários e somar
no cliente, esbarrando no teto de ~1000 linhas do PostgREST.

| Objeto                              | Papel                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `idx_broadcast_recipients_event_at` | Índice por expressão sobre `COALESCE(sent_at, created_at)` — ver abaixo |
| `broadcast_account_stats(…)`        | Os cards macro da §5.2a, em uma linha. `p_since NULL` = desde sempre    |
| `broadcast_engagement_series(…)`    | Série diária com dias vazios preenchidos e bucket no fuso informado     |

**Três decisões que o desenho impõe**

1. **`COALESCE(sent_at, created_at)`, não `sent_at`.** Um destinatário que
   falhou nunca recebe `sent_at` ([broadcast-core.ts:359](../src/lib/whatsapp/broadcast-core.ts#L359)
   grava só o status), então uma série por `sent_at` mostraria **zero falhas** —
   justamente a métrica que denuncia problema de qualidade de número. O índice
   parcial da 044 (`WHERE sent_at IS NOT NULL`) não cobre essa expressão e
   exclui exatamente o ramo que interessa, daí o índice novo.
2. **O fuso é parâmetro, não suposição.** A 039 devolve linhas cruas e bucketa
   no TS — decisão certa lá (dezenas de mensagens por dia), inviável aqui
   (dezenas de milhares de destinatários). Agrupar no SQL obriga a dizer _qual
   dia_: com UTC fixo, um disparo das 21h de Brasília cairia no dia seguinte.
   A tela passa o fuso do navegador; nome inválido cai em UTC em vez de
   derrubar o dashboard.
3. **Taxas ficam no cliente.** As RPCs devolvem numerador e denominador crus.
   Uma taxa arredondada no SQL perde a informação de que o denominador era 3 —
   e "100 % de leitura" com 3 entregas merece tratamento diferente na tela.

**A escada de status é a da 005, e isso é verificado na aplicação.**
`messages_delivered` significa "no estágio `delivered` ou além", igual ao
`broadcasts.delivered_count` mantido pelo trigger — sem isso, o card da conta e
a página da campanha mostrariam números diferentes para a mesma palavra. A
escada está escrita inline nos `FILTER` (uma função auxiliar viraria chamada por
linha sobre milhões de destinatários, e a exceção de `search_path` que a
tornaria inlinável é privativa de `triage_row_matches` — ver §8.3), e o bloco
final da migração **aborta** se ela divergir de `_bcast_cols_for_status`.

Ambas `SECURITY DEFINER` com guarda `is_account_member` na primeira instrução,
como `broadcast_quota_usage` (044) e as `dashboard_*` (039), mais o par
revoke+asserção da §8.1.

**Verificado em `vn` e `rs`**, com dados de teste dentro de transação revertida (a tabela abaixo reporta os 18 casos, idênticos nos dois projetos):

| Teste                                                          | Resultado                                      |
| -------------------------------------------------------------- | ---------------------------------------------- |
| 8 contadores dos cards contra um cenário montado à mão         | todos ✅                                       |
| Série de 5 dias: nenhuma lacuna, 2 dias zerados presentes      | ✅                                             |
| Soma da série = `messages_sent` dos cards                      | ✅                                             |
| Linha às 01h UTC: dia X em UTC, dia X−1 em `America/Sao_Paulo` | ✅                                             |
| Falha (`sent_at IS NULL`) aparece no dia da tentativa          | ✅                                             |
| `p_days = 99999` → 30 dias; fuso `Marte/Olimpo` → UTC          | ✅                                             |
| Autenticado de outra conta / `anon`                            | `42501` nas duas funções ✅                    |
| Linter do Supabase                                             | nenhum lint novo além do esperado (ver abaixo) |

> O lint `authenticated_security_definer_function_executable` aparece para as
> duas, como já aparece para `broadcast_quota_usage` e toda a família
> `dashboard_*`: é intencional — `authenticated` PRECISA do EXECUTE, e quem faz
> o escopo é a guarda no corpo. O que não pode aparecer, e não apareceu, é o
> lint equivalente para `anon`.

**UI _(2026-08-07)_.** `EngagementDashboard` renderiza na triagem
(`/broadcasts/new/[draftId]/triage`), acima do `QuotaMeter`:

| Peça                                                                                    | Caminho                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadAccountEngagementStats` / `loadEngagementSeries` / `loadAudienceEngagementSummary` | [engagement.ts](../src/lib/audience/engagement.ts) — wrappers tipados das RPCs 046/047, mesmo padrão de `src/lib/dashboard/queries.ts`                          |
| `EngagementDashboard`                                                                   | [engagement-dashboard.tsx](../src/components/broadcasts/audience/triage/engagement-dashboard.tsx) — 6 cards, série de 30 dias (`recharts`) e a frase de recorte |
| `StatCard`                                                                              | [stat-card.tsx](../src/components/broadcasts/stat-card.tsx) — promovido de `[id]/page.tsx`, ganhou `format: 'percent'` para as taxas de leitura/resposta        |

A cota de 24 h (6º card) lê `useMessagingLimit()` em vez de uma sétima RPC —
duplicar o número já calculado pelo `MessagingLimitProvider` (fase 2) teria
recriado o defeito que a §1.2 aponta no passo 4 antigo. `accountId` vem de
`useAuth()`, igual ao dashboard principal (`src/app/(dashboard)/dashboard`).

### 8.5 Migração 048 — consentimento (LGPD) e agendamento _(aplicada e verificada em `vn` e `rs` em 2026-08-07)_

Arquivo: [`048_lgpd_consent_and_scheduling.sql`](../supabase/migrations/048_lgpd_consent_and_scheduling.sql).

As duas seções da fase 7 entraram numa migração só porque compartilham as
mesmas trilhas: a §6.8 pede a trilha de disparo, e é nela que a §6.3
explica por que um agendamento das 23h não saiu às 23h.

| Bloco                                                                                                              | O que faz                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `contacts.opt_in_status/_source/_updated_at`                                                                       | Estado de consentimento + índice parcial `(account_id) WHERE opt_in_status = 'opted_out'` — o índice fica do tamanho da exceção, não da base. |
| `contact_consent_events`                                                                                           | Trilha imutável. `contact_id` com `ON DELETE SET NULL` (espelha a 004) e `phone` desnormalizado: apagar o contato não destrói a prova.        |
| `broadcast_audit_log`                                                                                              | Trilha de disparo, também imutável. `broadcast_id` com `SET NULL` — apagar a campanha não apaga o registro de que ela foi disparada.          |
| `broadcasts.scheduled_timezone`, `window_override`, `header_media_url` + índice parcial `WHERE status='scheduled'` | O que faltava para agendar (§6.3). O `header_media_url` fecha o item 8 da §12.                                                                |
| `set_contact_opt_in`                                                                                               | RPC `SECURITY INVOKER`: estado + evento na mesma transação. A RLS de `contacts` decide o escopo; a função entrega ATOMICIDADE.                |
| `broadcast_quota_usage` (da 044)                                                                                   | Guarda ampliada com uma exceção para `service_role` — sem ela o cron, que roda sem usuário, morreria com 42501 na leitura de cota.            |
| View `broadcast_audience_triage` + 4 RPCs                                                                          | `opt_in_status`/`is_opted_out` na view; filtros `opted_out`/`optable`; `opted_out_rows`, `selected_valid_rows` e `sendable_rows` no resumo.   |

> ⚠️ **Duas armadilhas de DDL que este arquivo tem que tratar, e a
> anterior não tinha.**
>
> 1. `triage_row_matches` ganhou um parâmetro. `CREATE OR REPLACE` com
>    lista de argumentos diferente cria uma **sobrecarga**, não substitui:
>    duas versões conviveriam e o planejador escolheria por tipo de
>    argumento — o filtro `opted_out` cairia silenciosamente no
>    `ELSE FALSE` da versão antiga. Daí o `DROP FUNCTION` explícito, com
>    asserção no fim conferindo que sobrou exatamente uma.
> 2. `triage_audience_page` e `audience_engagement_summary` mudaram o
>    `RETURNS TABLE`. `CREATE OR REPLACE` não altera tipo de retorno —
>    também exigem `DROP` antes.
>
> A liberação de `service_role` em `broadcast_quota_usage` **não** é
> afrouxamento: quem tem essa chave já lê `broadcast_recipients` inteiro
> sem RLS. `anon` continua sem EXECUTE (asserção no fim) e
> `authenticated` continua passando por `is_account_member`.

---

## 9. Fases de implementação

| Fase      | Entrega                                                                                                              | Dependências       | Valor isolado                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| **1** ✅  | UI de CSV no passo 2 + correção do dedupe (§7.1, §7.2)                                                               | nenhuma            | ✅ Destrava a funcionalidade que a UI já promete |
| **2** ✅  | Tier Meta: rota, migração 044, Provider, `QuotaMeter` (§4)                                                           | 044                | ✅ Proteção de cota, mesmo sem triagem           |
| **3** ✅  | XLSX + Google Sheets + fatiamento cooperativo (§3.2, §3.4.1)                                                         | `read-excel-file`  | ✅ Multiformato                                  |
| **6** ✅  | Envio server-side (§6.1)                                                                                             | ~~fase 4~~ nenhuma | ✅ Confiabilidade                                |
| **4** ✅  | Staging + rota de triagem + tabela (§3.3, §5.1, §3.3.1)                                                              | 045, 046           | ✅ Triagem + rascunho que sobrevive              |
| **5** ✅  | Dashboard histórico (§5.2) — RPCs da 047 + UI                                                                        | fase 4, **047**    | ✅ Analytics                                     |
| **7a** ✅ | LGPD (§6.8) + agendamento e janela de horário (§6.3)                                                                 | fase 6, **048**    | ✅ Compliance + campanha com hora marcada        |
| **7b** ✅ | Restante da excelência: ~~cooldown (§6.2)~~ ✅, ~~auto-limpeza (§6.4)~~ ✅, ~~A/B (§6.6)~~ ✅, ~~dry run (§6.7)~~ ✅ | 048, 050, **051**  | incremental — completa                           |

A fase 7 foi partida em duas: **§6.8 e §6.3 primeiro**, porque são as duas
que mudam o que sai do sistema (uma bloqueia quem pediu para sair, a outra
bloqueia o horário errado) — as demais são refinamento de segmentação sobre
uma base que já está correta. As peças da 7b ficaram com o caminho aberto:
o filtro `cooldown` da §6.2 e o `problematic` da §6.4 já existem nas RPCs
da 046 desde a fase 4, e a coluna de consentimento da 048 dá à §6.4 o
precedente de "estado do contato que a audiência respeita".

A fase 6 foi executada antes da 4, conforme decidido em 2026-08-07 (ver
cabeçalho): ela não depende de staging nem de `draftId` — opera direto sobre
`AudienceConfig` — e é a única das quatro restantes que corrige uma regressão
real. **Nenhuma migração nova foi necessária:** a 044 já dava a RPC de cota, e
o disparo do painel escreve nas mesmas tabelas de sempre. A fase 4, ao chegar
(§3.3.1), deu a `POST /api/broadcasts/send` o ramo que lê os destinatários do
staging em vez de resolver o filtro — o resto do caminho não mudou.

**A fase 1 é entregável sozinha e independe de todas as decisões pendentes.**

## 10. Testes

Vitest, arquivos `*.test.ts` ao lado do código (convenção do repo).

| Alvo                         | Casos                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseSpreadsheet`           | xlsx multi-aba, xls legado, header ausente, célula numérica que vira notação científica (telefone!), BOM UTF-8, CRLF                                                                                                      |
| `parseTier`                  | cada tier conhecido, valor desconhecido → `TIER_250`, campo ausente, **ambos** os nomes de campo (§4.1.1)                                                                                                                 |
| `computeQuota`               | `remaining` negativo, tier ilimitado, cache expirado, modo fallback                                                                                                                                                       |
| `normalizeAudience`          | dedupe entre fontes, E.164 inválido preserva `sourceRow`, cruzamento com base existente                                                                                                                                   |
| `extractSheetId`             | URLs de Sheets válidas, host hostil (SSRF), `gid` ausente                                                                                                                                                                 |
| RPCs                         | `triage_audience_page` com filtro+busca+paginação; isolamento entre contas; **chamada como `anon` deve falhar** (regressão da 042)                                                                                        |
| `detectOptOut`               | cada palavra-chave da lista; acento/caixa/pontuação; **palavra-chave dentro de frase maior NÃO casa**; mensagem longa; vazio/nulo                                                                                         |
| `send-window`                | abertura inclusiva e fechamento exclusivo; fim de semana; mesmo instante em dois fusos; `nextWindowOpening` sempre dentro da janela; borda de DST                                                                         |
| `planDashboardBroadcast`     | opt-out sai da audiência e **não** consome cota; template Utility alcança; categoria desconhecida é conservadora; audiência 100 % em opt-out tem código próprio; adoção por `adoptBroadcastId` não exige `status='draft'` |
| `scheduleDashboardBroadcast` | grava a intenção sem destinatário nem cota; persiste `header_media_url` e o filtro inteiro; falha AGORA sem template/config; `staged` adota o rascunho sem apagar o staging                                               |
| `estimateAudience`           | staged lê `sendable_rows` vs `selected_valid_rows`; `all` filtra no count sem ler a lista; interseção etiqueta-excluída × opt-out não conta duas vezes                                                                    |

## 11. i18n

Novo namespace `Broadcasts.audience.*` (fontes, erros de parse, triagem,
dashboard, cota, **agendamento e consentimento**) e
`Contacts.detailView.consent.*`. `en.json` é a fonte de verdade; `pt-BR.json`
no mesmo commit; `npm run i18n:check` no CI.

Terminologia PT-BR: _Audiência_ · _Triagem_ · _Cota de envio_ ·
_Contatos alcançados_ · _Taxa de leitura_ · _Em cooldown_ · _Número inválido_ ·
_Pediu para sair_ (nunca "opt-out" na interface) · _Janela permitida_ ·
_Agendar disparo_.

## 12. Riscos e decisões em aberto

| #   | Item                                                 | Situação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dependência do Excel (§3.2.1)                        | ✅ **Resolvido:** `read-excel-file@9` (npm, sem registry customizado). Cobre `.xlsx`; `.xls` legado fica de fora, com mensagem orientando "Salvar como .xlsx"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | Campo e versão da Graph API (§4.1.1)                 | 🟡 **Mitigado, não confirmado.** `fetchMessagingLimit` pede os dois campos e `parseTier` normaliza o que vier; tier desconhecido cai em `TIER_250`. **Ainda precisa ser validado contra a conta real** — ver "Próximos passos" abaixo                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | `usedLast24h` é aproximação da contabilidade da Meta | ✅ Margem de 5 % implementada (`QUOTA_SAFETY_MARGIN`), com teste                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Google Sheets exige planilha compartilhada por link  | ✅ Documentado na UI (`sheets.shareHint`) e detectado como `not_public` com instrução                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | Bundle da rota `/broadcasts` cresce                  | ✅ `read-excel-file` entra por `await import()` no ramo `.xlsx` — quem usa CSV ou Sheets não baixa o chunk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | Migrações em produção                                | ✅ **044 a 050 aplicadas e verificadas em `vn` e `rs`** (050 em 2026-08-08). A afirmação original de que a fase 5 não precisaria de migração **estava errada**: a 046 cobre só o §5.2b — a **047** (§8.4) trouxe os agregados da conta e a série. A verificação da 048 conferiu ACL (`anon` sem EXECUTE nas 7 funções), RLS e ausência de política de UPDATE/DELETE nas trilhas, uma única versão de `triage_row_matches`, e uma prova funcional de `set_contact_opt_in` desfeita por `ROLLBACK`. A 050 repetiu a mesma asserção de versão única para `triage_row_matches` (14→15 args) e confirmou `anon` sem EXECUTE nas quatro funções tocadas, em ambos os projetos. Nenhuma migração pendente |
| 7   | Web Worker (§3.4)                                    | ⛔ **Inviável no Turbopack.** Substituído por fatiamento cooperativo — ver §3.4.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | Fan-out em `after()` preso ao `maxDuration` da rota  | 🟡 **Aceito, com o bloqueio removido.** Em self-host o processo é longevo e o teto não morde; em serverless uma audiência grande pode ser cortada e deixar destinatários em `pending`. A saída continua sendo fila durável ou cron de drenagem (`status='sending'` com destinatários `pending` há mais de N minutos) — mas **o que amarrava a correção a uma migração própria caiu**: a 048 criou `broadcasts.header_media_url` e o disparo imediato já a persiste, então a retomada é implementável sem novo DDL                                                                                                                                                                                  |
| 9   | Janela de horário é constante, não configuração      | 🟡 **Deliberado (§6.3).** `SEND_WINDOW` (dias úteis, 09:00–20:00) é código. Trocá-la é editar um arquivo; o override por disparo cobre a exceção pontual. Virá uma tabela de configuração se e quando aparecer a tela para editá-la — antes disso ela seria configuração imutável na prática                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Opt-out não é subtraído da estimativa no ramo `csv`  | 🟡 **Conhecido e restrito a um ramo.** Uma linha de planilha ainda não é contato; cruzar cada número com a base é o trabalho da triagem (§3.3). Quem vai direto pelo `csv` pode ver um alcance acima do real — **o envio ainda remove os `opted_out`**, então o efeito é uma estimativa otimista, nunca uma mensagem indevida                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | Palavra-chave de opt-out casa a mensagem inteira     | 🟡 **Escolha explícita (§6.8, decisão 3).** "sair dessa lista por favor" não casa. Um falso positivo é um cliente perdido em silêncio; um falso negativo é um descadastro manual. A cobertura melhora acrescentando frases à lista conforme aparecerem nos dados — nunca afrouxando o predicado                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 13. Resumo executivo

O módulo de broadcasts está bem construído no que faz: templates, tags,
campos personalizados, resolução de variáveis sem N+1, contadores mantidos por
trigger e um caminho de envio server-side já em produção na API pública.

Três lacunas o impedem de ser um sistema de disparo de nível empresarial:

1. **Uma promessa quebrada na interface** — o CSV é oferecido e não existe
   (§1.3). Consertável isoladamente, na fase 1.
2. **Nenhuma consciência de cota** — nada no código sabe qual é o tier da
   Meta, e a validação correta não é um teto por disparo, mas uma janela
   deslizante de 24 h (§4.2).
3. **Nenhum ponto de revisão antes do disparo** — hoje se vai da seleção
   direto ao envio, sem enxergar _quem_ vai receber nem _como cada um se
   comportou_ nas campanhas anteriores (§5).

A arquitetura proposta não inventa padrão nenhum: o Context espelha o
`AuthProvider`, as RPCs espelham as migrações 025/039, a segurança das funções
espelha a 042, o parsing reusa `parseContactCsv`, o envio reusa
`broadcast-core.ts`. O único elemento genuinamente novo é o Web Worker — e
existe porque parsear 50 000 linhas na main thread congela a aba, o que
nenhuma peça existente resolve.
