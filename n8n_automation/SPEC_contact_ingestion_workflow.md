# SPEC — Workflow n8n: Ingestão de Contato (contact + tags + custom fields + notes)

- **Projeto:** zap-crm-br (componente externo, automação n8n)
- **Arquivo alvo do deploy:** `n8n_automation/`
- **Versão da SPEC:** 1.1 (adiciona D7 — ramo de `contact_notes`)
- **Data:** 2026-07-22
- **Autor da SPEC:** gerado com Claude (Opus 4.8 no design inicial; Sonnet 5 na extensão D7)
- **LLM sugerido p/ deploy:** Sonnet 5 (execução) usando o MCP `bmcp-n8n` (nunca `pmcp-n8n` neste projeto)
- **Base:** expande o workflow parcial `send-whatsapp-welcome` (Webhook → setData → If → CONFIG)

---

## 1. Objetivo

Receber um contato via Webhook e persisti-lo no Supabase do zap-crm-br, resolvendo em um único fluxo:

1. Criar/atualizar o **contato** (`contacts`);
2. Vincular **tag** (`tags` + `contact_tags`), com criação opcional da tag;
3. Vincular **campos customizados** (`custom_fields` + `contact_custom_values`), apenas para chaves que já existam como campo cadastrado.

Tudo em modo **single-tenant**: `account_id` e `user_id` são constantes fixas no node `CONFIG`.

---

## 2. Contrato de entrada (Webhook POST `/contact-ingestion`)

```json
{
  "name": "",                    // OBRIGATÓRIO
  "phone": "",                   // OBRIGATÓRIO (aceita "(19) 9 99249 65-98", E.164, etc.)
  "email": "",                   // opcional
  "company": "",                 // opcional
  "tag": "",                     // opcional
  "tag_create": true,            // opcional (default: false se ausente)
  "contact_custom_values": [     // opcional
    {
      "field_1": "",             // chave = field_name em custom_fields; valor = value
      "field_2": "",
      "...": "..."
    }
  ],
  "contact_notes": []            // opcional — array de strings, uma nota por elemento (ver D7)
}
```

### Regras de validação (node `setData`, já existente — a estender)
- `email`: validado por regex; resultado em `valid_email` (não bloqueia o fluxo).
- `phone`: validado/normalizado para BR (celular/fixo, 67 DDDs Anatel); resultado em `valid_number` + `tipo`.
- **`valid_number = false` → não prossegue** (branch falso do node `If` responde erro).
- `name` e `phone` são obrigatórios: se `name` vazio → tratar como erro de validação (ver §8).

---

## 3. Modelo de dados relevante (Supabase)

| Tabela | Campos-chave | Observações |
|---|---|---|
| `contacts` | `id`, `user_id*`, `account_id*`, `phone*`, `name`, `email`, `company`, `phone_normalized` | `phone_normalized` é **GENERATED STORED** = `regexp_replace(phone,'\D','','g')`. **n8n nunca escreve nela.** |
| `tags` | `id`, `user_id*`, `account_id*`, `name*`, `color` (default `#3b82f6`) | |
| `contact_tags` | `contact_id*`, `tag_id*` | UNIQUE `(contact_id, tag_id)` |
| `custom_fields` | `id`, `user_id*`, `account_id*`, `field_name*`, `field_type` | busca por `field_name` **case-insensitive** |
| `contact_custom_values` | `contact_id*`, `custom_field_id*`, `value` | UNIQUE `(contact_id, custom_field_id)` |
| `contact_notes` | `id`, `contact_id*`, `user_id*`, `account_id*`, `note_text*` | **Sem constraint UNIQUE** — todo insert é uma linha nova, nunca upsert. |

`*` = NOT NULL. Índice único de dedup de contato: `idx_contacts_account_phone_normalized` = UNIQUE `(account_id, phone_normalized)` WHERE `phone_normalized <> ''`.

---

## 4. Decisões de design

### D1 — Formato de `phone` armazenado (DECIDIDO)
Guardar tudo em formato **internacional com DDI, sem o sinal `+`**. O node `setData` já entrega E.164 (`+5519992496598`); basta remover o `+`.

- `contacts.phone` = E.164 sem `+` → ex.: `+5519992496598 → 5519992496598`.
- `contacts.phone_normalized` é coluna **GENERATED ALWAYS ... STORED** = `regexp_replace(phone,'\D','','g')`. **O banco a calcula sozinho; n8n NUNCA escreve nela** (insert com valor explícito em coluna gerada é rejeitado pelo Postgres). Como `phone` já será só dígitos, `phone_normalized` resulta idêntico automaticamente = `5519992496598`.
- Portanto: basta inserir `phone` = E.164-sem-`+`; `phone_normalized` fica com DDI, sem `+`, sem símbolos — conforme o requisito.

Dedup por `(account_id, phone_normalized)` passa a usar a chave **com DDI** (`5519...`). O valor E.164 com `+` (`phone_e164`) permanece disponível no fluxo para a camada de envio WhatsApp (fora do escopo desta SPEC).

### D2 — Duplicata de contato (var de CONFIG)
Nova constante `update_existing_contact` (boolean) no node `CONFIG`:
- `true` → contato já existe: **PATCH** de `name`, `email`, `company` (sobrescreve).
- `false` → contato já existe: **não altera** os dados existentes.
- Em ambos os casos, o fluxo **continua** para tags e custom fields usando o `id` do contato existente.

### D3 — Tags: sempre aditivo
Independente de `update_existing_contact`, tags **nunca são removidas**. Só se **acrescenta** a relação em `contact_tags` que ainda não existir (dedup via UNIQUE `(contact_id, tag_id)`).

### D4 — Custom values em duplicata
Se a relação `(contact_id, custom_field_id)` já existir, faz **UPSERT** (atualiza `value` para o mais recente). Recomendação: manter upsert para refletir o dado mais atual. *(Opcional: gatear a sobrescrita por `update_existing_contact` — não adotado por padrão; decidir no deploy.)*

### D5 — Normalização (slug) da tag
Regra de `slugify(tag)`:
1. `trim()`.
2. Remover acentos → ASCII (`NFD` + remove diacríticos; `ç → c`, `ã → a`, `é → e`).
3. Espaços (um ou mais) → `_`.
4. Remover tudo que não for `[A-Za-z0-9_-]`.
5. Colapsar `_` repetidos e remover `_`/`-` das pontas.
6. **Case:** preservar o original (usuário não pediu lowercase). ⚠️ Risco de duplicata `VIP` vs `vip` — a busca de existência usa `ilike` (case-insensitive) para mitigar; decidir no deploy se força lowercase.

### D6 — Lookups
- Tag: busca por `name` com `ilike` (case-insensitive) filtrando por `account_id`.
- Custom field: busca por `field_name` com `ilike` filtrando por `account_id`.
- Escrita via Supabase REST (`/rest/v1/...`) com header `Authorization: Bearer <service_role>` + `apikey`. Relações usam `Prefer: resolution=ignore-duplicates` (contact_tags) e `resolution=merge-duplicates` (contact_custom_values).

### D7 — Notas de contato (`contact_notes`) — DECIDIDO 2026-07-22
Novo campo opcional no input: `contact_notes` — **array de strings**, uma nota por elemento:

```json
{ "contact_notes": ["Cliente pediu desconto", "Prefere contato por telefone"] }
```

- Cada string não-vazia (após `trim()`) vira **uma linha** em `contact_notes.note_text`. Strings vazias/só espaço são descartadas silenciosamente.
- **Sempre insere** — independente de `update_existing_contact` ser `true` ou `false`, e independente de `contact_action` ter sido `created`/`updated`/`unchanged`. O ramo de notas pendura direto do node `Contact Ready` (convergência que já unifica os 3 casos), então roda igual nos três.
- **Nunca é upsert/dedup** — `contact_notes` não tem constraint UNIQUE; reenviar a mesma nota N vezes cria N linhas. Isso é intencional (nota é um registro histórico tipo "log", não um valor único a atualizar).
- Se `contact_notes` ausente ou vazio (ou só strings em branco) → ramo não insere nada, resposta traz `notes.inserted: 0`.

---

## 5. Fluxo de nodes (n8n)

```
Webhook (POST /contact-ingestion)       [existe]
  → setData (Code)                       [existe — ESTENDER: emitir phone_e164 e phone_local]
  → If (valid_number == true)            [existe]
        false → Respond (erro validação)
        true  ↓
  → CONFIG (Set)                         [existe — ADICIONAR: account_id, user_id, update_existing_contact]
  → Lookup Contact (HTTP GET)
        GET /contacts?account_id=eq.{account_id}&phone_normalized=eq.{phone_ddi}&select=id
  → If (contato existe?)
        NÃO → Insert Contact (POST /contacts) → contact_id
        SIM → If (update_existing_contact == true?)
                  SIM → Update Contact (PATCH /contacts?id=eq.{id})
                  NÃO → (segue sem alterar)
              → contact_id (existente)
  ── merge → contact_id disponível ──
  → [Ramo TAG]  (só se input.tag preenchida)
        Slugify (Code) → Lookup Tag (GET ilike)
        → If (tag existe?)
              SIM → tag_id
              NÃO → If (tag_create == true?)
                        SIM → Insert Tag (POST /tags: name=slug, user_id, account_id, color default) → tag_id
                        NÃO → encerra ramo (sem relação)
        → Link Tag (POST /contact_tags, Prefer: ignore-duplicates)  // aditivo
  → [Ramo CUSTOM FIELDS]  (só se contact_custom_values[0] tiver chaves)
        Split em pares {key, value} (Code)  → loop por item:
          Lookup custom_field (GET /custom_fields?field_name=ilike.{key}&account_id=eq...)
          → If (campo existe?)
                SIM → Upsert value (POST /contact_custom_values, Prefer: merge-duplicates)
                NÃO → ignora (nenhuma relação)
  → [Ramo NOTES]  (só se contact_notes tiver alguma string não-vazia — D7)
        Split notas não-vazias (Code) → loop por item:
          Insert Note (POST /contact_notes)  // sempre insere, sem dedup, sem on_conflict
  → Respond to Webhook (resumo)
```

> Os três ramos (TAG, CUSTOM FIELDS, NOTES) rodam em paralelo a partir de `Contact Ready` e convergem via dois nodes `Merge` encadeados (`mode: append`) antes do `Build Response`.

> **Ordem obrigatória:** o `contact_id` precisa existir **antes** dos ramos de tag e custom fields (FKs). Os dois ramos podem rodar em sequência (tag → custom) para simplicidade, ou em paralelo se o node de resposta agregar ambos.

---

## 6. Alterações no node `setData` (Code)

Além dos campos atuais (`valid_email`, `valid_number`, `tipo`, `phone` E.164), acrescentar:

```js
// após montar telefoneResult.e164 = "+55DDDNUMERO"
const e164 = telefoneResult.e164;                       // "+5519992496598"
const phone_ddi = e164 ? e164.replace(/^\+/, '') : null; // "5519992496598" (DDI sem +)

return {
  json: {
    ...item,
    valid_email: emailValido,
    valid_number: telefoneResult.valido,
    tipo: telefoneResult.tipo,
    phone_e164: e164,      // com +, para camada WhatsApp (futuro)
    phone_ddi: phone_ddi   // sem +, vai para contacts.phone (D1)
  }
};
```

`contacts.phone` recebe `phone_ddi`. **Não escrever `phone_normalized`** — é coluna gerada; o banco produz `5519992496598` automaticamente a partir de `phone`.

---

## 7. Alterações no node `CONFIG` (Set)

Adicionar às assignments existentes (`supabase_url`, `supabase_anon_service_role`):

| name | type | valor |
|---|---|---|
| `account_id` | string | `<UUID fixo da conta>` |
| `user_id` | string | `<UUID fixo do usuário owner>` |
| `update_existing_contact` | boolean | `true` \| `false` |

> Reposicionar `CONFIG` **antes** do Lookup Contact (hoje está no fim). Os segredos permanecem no node — considerar migrar `service_role` para credencial/variável n8n em iteração futura (ver §10).

> ⚠️ **`workflow_contact_ingestion.json` versionado neste repositório tem `supabase_anon_service_role` = `<REDACTED>`.** Ao reimportar o JSON em qualquer instância n8n, é **obrigatório** editar o node `CONFIG` e colar o valor real da service_role key antes de usar — o placeholder existe só para permitir versionar o arquivo sem vazar o segredo (ver §11).

---

## 8. Tratamento de erros e resposta

- **Validação falha** (`valid_number=false` ou `name` vazio): `Respond to Webhook` HTTP 422 `{ ok:false, reason:"invalid_number" | "missing_name" }`.
- **Erro Supabase** (status ≥ 400 em insert de contato): abortar e responder 500 com corpo do erro; **não** prosseguir para tags/custom.
- **Erro em ramo tag/custom**: logar mas não derrubar o contato já criado (contato é o núcleo; relações são best-effort). Definir no deploy se falha de relação vira 207/parcial.
- **Resposta de sucesso** (200):
```json
{
  "ok": true,
  "contact_id": "uuid",
  "contact_action": "created" | "updated" | "unchanged",
  "tag": { "slug": "…", "action": "linked" | "created_and_linked" | "skipped_not_created" | "none" },
  "custom_values": { "matched": 2, "ignored_keys": ["field_x"] },
  "notes": { "inserted": 2 }
}
```

---

## 9. Critérios de aceite

1. **Contato novo mínimo** (`name`+`phone`) → 1 linha em `contacts`; `phone` = E.164 sem `+` (ex.: `5519992496598`); `phone_normalized` gerada automaticamente = mesmos dígitos com DDI; resposta `contact_action:"created"`.
2. **Contato duplicado + `update_existing_contact=true`** → `name/email/company` atualizados; `contact_action:"updated"`; sem duplicar linha.
3. **Contato duplicado + `update_existing_contact=false`** → dados originais intactos; `contact_action:"unchanged"`; fluxo segue para tags/custom.
4. **Tag existente** → relação criada em `contact_tags`; rodar 2×  não duplica (UNIQUE respeitada); nenhuma tag pré-existente do contato é removida.
5. **Tag inexistente + `tag_create=true`** → tag criada com slug normalizado (sem acento/ç, espaços→`_`, só `[A-Za-z0-9_-]`) + relação criada.
6. **Tag inexistente + `tag_create=false`** → nada criado, `action:"skipped_not_created"`.
7. **Custom field existente (case-insensitive)** → valor gravado em `contact_custom_values`; re-run atualiza `value`.
8. **Custom field inexistente** → chave ignorada, sem relação; listada em `ignored_keys`.
9. **`valid_number=false`** → 422, nada gravado.
10. **`contact_notes` com strings válidas** → 1 linha por string não-vazia em `contact_notes`; strings em branco/vazias são descartadas; resposta `notes.inserted` bate com a contagem.
11. **`contact_notes` ausente/vazio** → nenhuma linha inserida, `notes.inserted: 0`.
12. **`contact_notes` em contato já existente** → nota inserida **independente** de `contact_action` ser `created`, `updated` ou `unchanged`; reenviar a mesma nota N vezes cria N linhas (sem dedup).

---

## 10. Fora de escopo / próximos passos

- Disparo de mensagem de boas-vindas WhatsApp após a ingestão (hoje é responsabilidade do workflow separado `WhatsApp - Send Welcome`, ver §13; se quiser encadear, use `phone_e164` disponível no fluxo).
- Migração de `service_role` para credencial segura do n8n (evitar segredo em texto no node).
- Suporte a múltiplas tags por payload (hoje: 1 tag).
- Rotação/anulação da service_role atualmente exposta no JSON de origem (ver §11).

---

## 11. Segurança — pendência imediata

O JSON do workflow de origem contém a **`service_role` key** do Supabase em texto plano (node `CONFIG`). A service_role ignora RLS. Recomendação: **rotacionar essa chave** no painel Supabase e passar a injetá-la via credencial/variável do n8n, nunca versionada. Sinalizar ao usuário antes do deploy.

**Decisão (2026-07-22):** manter a chave real só dentro do node `CONFIG` do n8n (ambiente controlado, só o mantenedor mexe). Mas o export local `workflow_contact_ingestion.json`, por ser um arquivo versionável neste repositório, **não pode conter o valor real** — nele o campo vem como `<REDACTED>`. Sempre que este JSON for reimportado (nova instância n8n, restauração, etc.), é preciso colar a chave real de volta no node `CONFIG` manualmente antes de usar.

---

## 12. Plano de deploy (fase seguinte, Sonnet 5)

1. Confirmar D1 (formato de phone) e valores fixos de `account_id`/`user_id`.
2. Montar/patchar o workflow via MCP `bmcp-n8n`/`pmcp-n8n` (`create_workflow` / `update_workflow_partial`), validando cada node com `validate_node_config`.
3. Testar com `execute_workflow_via_webhook` nos 9 casos de aceite (§9).
4. Salvar o export final em `n8n_automation/` (`workflow_contact_ingestion.json`).

**Status: DEPLOYADO, TESTADO e ATIVO em produção.** Workflow atual ID `YwZ2Md3aZddb0F5c` ("Contact Ingestion (contacts + tags + custom fields + notes)"), path definitivo `contact-ingestion` (não `send-whatsapp-welcome` — ver §13). Os 12 critérios de aceite passaram em 2026-07-22, incluindo o ramo de notas (D7) adicionado depois do primeiro deploy.

**Endpoint final:** `POST https://n8n.bru.ia.br/webhook/contact-ingestion`

### Histórico de versões do workflow

| Workflow ID | Status | Observação |
|---|---|---|
| `MLytVzkcOjzxkRUJ` | apagado | Primeira versão de teste, path `contact-ingestion-test`. |
| `5YAnUZyLQ9r4vncy` | **desativado, pendente de exclusão** | Versão sem o ramo de notas. Recriada como `YwZ2Md3aZddb0F5c` ao adicionar D7 (ver §14 item 4 — não dá pra editar workflow já ativado uma vez). Apagar assim que a conexão MCP `bmcp-n8n` estiver disponível de novo. |
| `YwZ2Md3aZddb0F5c` | **ativo (atual)** | Versão completa: contact + tags + custom fields + notes. |

## 13. Conflito com workflow de produção existente

O path `send-whatsapp-welcome` já pertence a um workflow ATIVO em produção (`WhatsApp - Send Welcome`, ID `26FAVqwEJp4Y9aVA`), que evoluiu além do JSON parcial mostrado inicialmente — hoje inclui envio de template WhatsApp (`List Templates` → `Loop Over Templates` → `Send Template`). Por isso o workflow desta SPEC foi deployado num path **separado** (`contact-ingestion-test`) para não colidir.

**DECISÃO FINAL (2026-07-22): os dois workflows permanecem separados e não integrados.** Este workflow de ingestão de contato não chama nem é chamado pelo "WhatsApp - Send Welcome" — são dois endpoints independentes, cada um com seu próprio path/webhook. Quem dispara este webhook de ingestão é responsabilidade de quem cadastra o contato (CRM, outro sistema, ou automação externa), não o fluxo de boas-vindas do WhatsApp.

## 14. Bugs encontrados e corrigidos durante os testes

1. **Valor `null` em campo tipado `string` no node Set trava o workflow.** Nodes "Tag Result (None)" (`tag_slug`) e "Tag Skipped" (`tag_id`) usavam `null` literal — Set v3.4 não aceita `null` bruto num assignment de tipo `string`/`array`, causa erro 500 genérico sem detalhe. Corrigido para `""`.
2. **`Merge` node com `combinationMode` inválido.** `"mode":"combine","combinationMode":"mergeByPosition"` não é um valor válido no n8n v3 (passa na validação estática do MCP mas quebra em runtime, com erro genérico). Corrigido trocando para `"mode":"append"` (mais simples e sempre válido) + reescrita do node "Build Response" para localizar os dois itens resultantes via `$input.all()` em vez de esperar um único item mesclado.
3. **`Prefer: resolution=ignore-duplicates` / `merge-duplicates` sem `on_conflict` no PostgREST.** Sem o parâmetro de query `on_conflict`, o PostgREST usa a chave primária (sempre um UUID novo) para detectar conflito — nunca colide — e a query tenta o INSERT de verdade, batendo na constraint `UNIQUE` real e retornando 409 (que o node HTTP propaga como erro, derrubando a execução). Corrigido adicionando `on_conflict=contact_id,tag_id` em `Link Tag (Existing/Created)` e `on_conflict=contact_id,custom_field_id` em `Upsert Custom Value`. **Isso é uma pegadinha geral de Supabase/PostgREST + n8n a lembrar em qualquer upsert futuro.**

O arquivo `workflow_contact_ingestion.json` já reflete todas essas correções.

4. **Bug de plataforma no rename via API (`update_workflow`/`update_workflow_partial`).** Ao tentar apenas renomear o path do webhook num workflow já ativado uma vez, toda tentativa de PATCH/PUT passou a falhar com `request/body/settings must NOT have additional properties` — o GET da API retorna `settings.binaryMode` mas o schema de validação do PUT não aceita esse campo de volta (incompatibilidade da própria API do n8n, não do conteúdo do workflow). **Contorno:** recriar o workflow do zero via `create_workflow` com o path já correto (settings limpos por padrão) em vez de tentar editar o existente. O workflow antigo (`MLytVzkcOjzxkRUJ`) foi apagado após o novo (`5YAnUZyLQ9r4vncy`) ser validado com smoke test. **Lição:** evitar múltiplas idas de ativar/desativar/editar no mesmo workflow via essas ferramentas; se precisar mudar `path`/`webhookId` depois de ativar uma vez, considerar recriar em vez de editar.
```
