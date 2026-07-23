# Automações n8n do ZAP CRM BR

> Camada de automação externa do **ZAP CRM BR**, construída em [n8n](https://n8n.io) e conectada
> diretamente ao Supabase do CRM. Não faz parte do código-fonte do app (Next.js) — roda numa
> instância n8n própria e fala com o mesmo banco via REST/PostgREST.

Esta pasta documenta e versiona os workflows n8n que **alimentam o CRM de fora para dentro**:
qualquer sistema capaz de disparar um webhook HTTP passa a poder criar e enriquecer contatos no
ZAP CRM BR, sem precisar tocar no código do app.

---

## Por que isso importa: o CRM deixa de ser uma ilha

Ter contatos, tags e campos customizados acessíveis por um webhook n8n **muda o tipo de produto**
que o ZAP CRM BR pode ser. Em vez de um CRM que só recebe dados digitados manualmente ou importados
por CSV, ele passa a ser o destino natural de qualquer fluxo de captura ou automação que já exista
no negócio. Alguns exemplos concretos do que dá para plugar **sem alterar uma linha do app**:

| Cenário | Como o n8n resolve |
|---|---|
| **Formulário do site / landing page** | Typeform, Google Forms, ou um `<form>` próprio → webhook n8n → contato criado com tag `origem_site` e campos customizados (UTM, produto de interesse). |
| **E-commerce / checkout** | Novo pedido na Shopify/Nuvemshop/WooCommerce → contato criado com tag `cliente`, custom field `ultimo_pedido`, `ticket_medio`. |
| **Eventos e webinars** | Inscrição em Eventbrite/Sympla → contato com tag do evento (`webinar_marco_2026`) — depois vira campanha de disparo segmentada no próprio CRM. |
| **Enriquecimento de dados** | Antes ou depois do insert, um node HTTP no mesmo workflow consulta uma API de CNPJ/CPF, CEP ou score de crédito e grava o resultado num custom field. |
| **Importação em massa / migração** | Planilha Google Sheets ou CSV lido por um node `Schedule Trigger` + loop, chamando este mesmo webhook por linha — dedup automático por telefone já embutido (§ **Duplicatas** abaixo). |
| **Sincronização com outro CRM/ESP** | RD Station, Mailchimp, ActiveCampaign, HubSpot → n8n replica o lead como contato do ZAP CRM BR, mantendo os dois sistemas em paralelo sem integração nativa. |
| **Múltiplos canais convergindo num contato só** | WhatsApp, formulário, planilha e e-commerce podem todos apontar para o mesmo webhook (ou para variações dele) — o dedup por `phone_normalized` garante que é **um único contato**, não quatro duplicados. |
| **Automação interna disparando automação** | Um workflow n8n de "lead scoring" pode chamar este webhook como etapa final para *carimbar* o contato com o resultado, sem que o app precise expor essa lógica. |
| **Histórico de atendimento centralizado** | Central telefônica, chatbot ou script de atendimento gera uma nota por interação (`contact_notes`) — o histórico completo do cliente fica no CRM, mesmo vindo de sistemas que nunca foram integrados ao app. |

O padrão usado aqui (webhook → validação → upsert no Supabase via REST) é **replicável**: dá para
copiar este workflow como ponto de partida para qualquer nova integração que precise conversar com
as tabelas `contacts` / `tags` / `custom_fields` / `contact_notes` do CRM.

---

## O que existe nesta pasta

| Arquivo | Conteúdo |
|---|---|
| [`SPEC_contact_ingestion_workflow.md`](./SPEC_contact_ingestion_workflow.md) | Especificação técnica completa: contrato de dados, decisões de design (D1–D7), fluxo node a node, critérios de aceite e **bugs de n8n encontrados/corrigidos** (leitura recomendada antes de alterar o workflow). |
| [`workflow_contact_ingestion.json`](./workflow_contact_ingestion.json) | Export fiel do workflow ativo no n8n — 49 nodes, pronto para reimportar via `n8n import:workflow` ou colar na UI. ⚠️ **O valor de `supabase_anon_service_role` no node `CONFIG` está como `<REDACTED>` de propósito** — troque pelo valor real da sua service_role key **antes** de importar, senão o workflow importado fica sem credencial válida e todas as chamadas ao Supabase falham. |
| [`supabase_schema_contatos.txt`](./supabase_schema_contatos.txt) | DDL das tabelas envolvidas (`contacts`, `tags`, `contact_tags`, `custom_fields`, `contact_custom_values`, `contact_notes`). |
| `README.md` (este arquivo) | Visão de produto, casos de uso e guia rápido de utilização do endpoint. |

---

## O workflow ativo: Contact Ingestion

**Endpoint:** `POST https://n8n.bru.ia.br/webhook/contact-ingestion`
**Workflow n8n:** `Contact Ingestion (contacts + tags + custom fields)` — ID `5YAnUZyLQ9r4vncy` (ativo)

### O que ele faz, em uma frase

Recebe um contato (nome + telefone, obrigatórios) e resolve em uma única chamada: cria ou atualiza
o contato, vincula uma tag (criando-a se necessário), grava campos customizados e registra notas de
histórico — tudo já normalizado e deduplicado.

### Payload de entrada

```json
{
  "name": "Maria Souza",
  "phone": "(19) 9 9924-9658",
  "email": "maria@empresa.com.br",
  "company": "Empresa LTDA",
  "tag": "Cliente VIP",
  "tag_create": true,
  "contact_custom_values": [
    { "cpf": "123.456.789-00", "origem": "landing_page_black_friday" }
  ],
  "contact_notes": [
    "Cliente pediu desconto na renovação",
    "Prefere contato por telefone à tarde"
  ]
}
```

- **Obrigatórios:** `name`, `phone`.
- **`phone`** aceita qualquer formato BR (com DDD, com ou sem `9`, com máscara, com ou sem `+55`) —
  a normalização e validação de DDD/celular/fixo já está embutida.
- **`tag`** é opcional; se ausente, nada acontece nesse ramo.
- **`tag_create`**: `true` cria a tag (normalizada — sem acento, espaços viram `_`) caso não exista;
  `false` só vincula tags que já existem.
- **`contact_custom_values`**: array com **um objeto** `{ chave: valor }`; cada chave é comparada
  (case-insensitive) com `custom_fields.field_name` da conta. Chave sem campo correspondente é
  **ignorada silenciosamente** (nunca cria campo novo).
- **`contact_notes`**: array simples de strings — cada string vira uma linha em `contact_notes`.
  Sempre insere (nunca substitui uma nota anterior), **independente** do contato ter sido criado,
  atualizado ou deixado intocado nessa mesma chamada. Ideal para ir empilhando histórico de
  interação (ligações, observações de atendimento) vindo de qualquer canal.

### Exemplo de chamada

```bash
curl -X POST https://n8n.bru.ia.br/webhook/contact-ingestion \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maria Souza",
    "phone": "(19) 9 9924-9658",
    "tag": "Cliente VIP",
    "tag_create": true
  }'
```

### Resposta

```json
{
  "ok": true,
  "contact_id": "b630a43f-94ca-46db-8274-ec0cc31c810f",
  "contact_action": "created",
  "tag": { "slug": "Cliente_VIP", "action": "created_and_linked" },
  "custom_values": { "matched": 0, "ignored_keys": [] },
  "notes": { "inserted": 2 }
}
```

`contact_action` informa exatamente o que aconteceu (`created` / `updated` / `unchanged`);
`tag.action` idem (`linked_existing` / `created_and_linked` / `skipped_not_created` / `none`).
Em erro de validação, a resposta vem com HTTP 422: `{ "ok": false, "reason": "invalid_number" | "missing_name" }`.

### Regras de negócio que valem lembrar

- **Duplicata de contato** (mesmo telefone na mesma conta): controlado pela variável fixa
  `update_existing_contact` no node `CONFIG` — hoje `true` (sobrescreve nome/e-mail/empresa em
  contato repetido). Trocar para `false` preserva os dados existentes.
- **Tags nunca são removidas.** O fluxo só *acrescenta* — mandar um contato sem uma tag que ele já
  tinha não apaga a tag antiga. Ideal para ir enriquecendo o mesmo contato por canais diferentes ao
  longo do tempo.
- **Telefone é sempre normalizado com DDI, sem `+`** (ex.: `5519992496598`), tanto em `phone` quanto
  no `phone_normalized` gerado pelo Postgres — é essa combinação que garante o dedup automático.
- **Notas nunca são deduplicadas nem sobrescritas.** Cada string em `contact_notes` vira uma linha
  nova em `contact_notes`, mesmo que o texto já tenha sido enviado antes — funciona como um log de
  interações, não como um campo único.

Detalhes completos de cada decisão estão na [SPEC](./SPEC_contact_ingestion_workflow.md) §4.

---

## Arquitetura em uma imagem

```
Origem qualquer (form, e-commerce, planilha, outro CRM, WhatsApp...)
        │  POST JSON
        ▼
  Webhook n8n (/contact-ingestion)
        │
        ▼
  Validação (telefone BR + nome obrigatório)
        │
        ▼
  Upsert em `contacts` (dedup por telefone)
        │
        ├──► Ramo TAG ──────────► `tags` + `contact_tags`
        │
        └──► Ramo CUSTOM FIELDS ─► `contact_custom_values`
                        │
                        ▼
              Resposta JSON consolidada
```

Toda a escrita usa a API REST do Supabase (PostgREST) diretamente — sem passar pelo Next.js do CRM,
o que mantém a automação desacoplada do deploy do app.

---

## Segurança — leia antes de reusar isso em outro lugar

O node `CONFIG` do workflow contém a **service_role key** do Supabase em texto plano (necessária
para gravar direto nas tabelas ignorando RLS). Isso é aceitável dentro do próprio n8n (ambiente
controlado), mas:

- ⚠️ **`workflow_contact_ingestion.json` neste repositório NÃO tem a chave real** — o campo
  `supabase_anon_service_role` está com o placeholder `<REDACTED>` de propósito, para o arquivo
  poder ser versionado/compartilhado sem vazar segredo. **Antes de importar este JSON em qualquer
  instância n8n**, abra o node `CONFIG` depois de importar e cole ali o valor real da sua
  `service_role key` (Supabase → Project Settings → API) — sem isso, todas as chamadas a
  `/rest/v1/...` retornam 401/403.
- **Nunca** exponha essa chave fora do n8n (não cole em outro sistema, não logue a resposta bruta).
- Se este JSON for reaproveitado em outra instância n8n, **rotacione a service_role** no painel
  Supabase antes, e prefira migrar o segredo para uma **credencial nativa do n8n** em vez de um
  valor fixo no node `Set`.
- `account_id` e `user_id` também estão fixos no `CONFIG` (modo single-tenant) — se este padrão for
  reaproveitado para múltiplas contas do CRM, essa parte precisa virar um lookup dinâmico (por API
  key do chamador, por exemplo) em vez de constante.

---

## Relação com o restante do n8n desta conta

Existe um outro workflow de produção, **`WhatsApp - Send Welcome`**, que já usa o path
`send-whatsapp-welcome` para enviar templates de boas-vindas via WhatsApp. Por decisão de projeto,
**os dois workflows são independentes** — este não chama aquele, e vice-versa. Quem dispara a
ingestão de contato (`/contact-ingestion`) é responsabilidade de quem captura o lead; se um fluxo
de boas-vindas via WhatsApp for necessário depois da criação do contato, o jeito n8n-nativo de
plugar isso é encadear os dois workflows com um node **"Execute Workflow"**, mantendo cada um com
sua responsabilidade única.

---

## Para ir além (ideias de expansão)

- **Novo endpoint por canal**: duplicar o padrão deste workflow (webhook → validação → Supabase)
  para receber leads já formatados de uma fonte específica (ex.: `/contact-ingestion/shopify`),
  cada um com sua própria transformação antes de cair na mesma lógica de upsert.
- **Fan-out de tags múltiplas**: hoje o contrato aceita 1 tag por chamada; um `Split In Batches`
  antes do ramo de tag permitiria um array `tags: [...]`.
- **Fila com retry**: para fontes de alto volume (importação em massa), colocar um `Queue`/`Wait`
  entre a origem e o webhook evita rate-limit no Supabase.
- **Webhook de saída (outbound)**: o mesmo Supabase pode disparar um `pg_notify`/trigger que chama
  de volta um workflow n8n sempre que um contato for criado pela UI do CRM — fechando o ciclo
  bidirecional.

Cada uma dessas extensões segue o mesmo esqueleto documentado na
[SPEC](./SPEC_contact_ingestion_workflow.md) — é questão de adicionar nodes, não reinventar o fluxo.
