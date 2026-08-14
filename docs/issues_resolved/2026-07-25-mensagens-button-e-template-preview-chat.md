# Mensagens `button`/`contacts` não reconhecidas + templates enviados sem formatação no chat

**Data:** 2026-07-25
**Área:** Caixa de entrada (Inbox) → recebimento e envio de mensagens do WhatsApp
**Status:** Resolvido — testado em produção pelo usuário

Duas falhas distintas encontradas na mesma área (renderização de mensagens no chat), resolvidas na mesma sessão.

---

## Issue 1 — `[Unsupported message type: button]` em respostas de template

### Sintoma inicial

Conversas inbound mostravam o texto literal `[Unsupported message type: button]` no lugar do clique do cliente em botões de _quick reply_ de mensagens **template**, tanto na bolha da mensagem quanto no preview da lista de conversas.

### Investigação

O sintoma sugeria o bug em `conversation-list.tsx`, mas esse componente só exibe `conversation.last_message_text` — não tem lógica por tipo de mensagem. A causa real estava em `parseMessageContent()` dentro do webhook (`src/app/api/whatsapp/webhook/route.ts`): a Cloud API da Meta envia cliques em botões de _quick reply_ de **templates** com `message.type === "button"`, um tipo distinto de `interactive` (que cobre apenas botões/listas de mensagens interativas enviadas por nós). Esse tipo não tinha `case` no switch e caía no `default`, gravando o texto de erro como conteúdo permanente da mensagem.

Auditoria adicional revelou que `contacts` (cliente compartilhando um cartão de contato) tinha o mesmo problema — nenhum tratamento.

### Correção

- Adicionado campo `button?: { text, payload }` e `contacts?: [...]` à interface `WhatsAppMessage`.
- Novo `case 'button'`: usa `button.text` como texto exibido e `button.payload` como `interactive_reply_id` (mesma semântica de `interactive.button_reply`), permitindo que Flows/automações roteiem por esse clique também.
- Mapeado `button` → `content_type: 'interactive'`, reaproveitando toda a renderização de "tap" já existente na bolha.
- Novo `case 'contacts'`: monta um texto legível com os nomes do(s) contato(s) compartilhado(s).
- Fallback para tipos futuros desconhecidos mantido como já era (grava texto de erro em vez de quebrar o insert) — comportamento defensivo correto, não alterado.

### Limitação conhecida

Mensagens já gravadas **antes** do deploy continuam com o texto de erro — o `button.text`/`button.payload` originais nunca foram persistidos em lugar nenhum (sem log do payload bruto do webhook), então não há como recuperar retroativamente o que o cliente clicou. Usuário optou por não fazer backfill cosmético.

### Arquivos alterados

- `src/app/api/whatsapp/webhook/route.ts`

### Verificação

- `npx tsc --noEmit` — sem erros.
- `npx eslint` no arquivo alterado — sem erros novos.
- Testado em produção pelo usuário após deploy — confirmado resolvido.

---

## Issue 2 — Template enviado pelo chat não mostrava cabeçalho/rodapé/botões

### Sintoma inicial

Ao enviar uma mensagem **template** pelo composer do inbox, a bolha exibia só um selo "Template" + texto puro do corpo — sem os botões `QUICK_REPLY`/`URL`/`PHONE_NUMBER`/`COPY_CODE`, sem cabeçalho de mídia e sem rodapé, mesmo a mensagem tendo chegado corretamente formatada no WhatsApp do destinatário.

### Investigação

`send-message.ts` (usado pela rota `/api/whatsapp/send`) persistia a mensagem `template` gravando apenas `content_text` e `template_name` — nenhuma informação estrutural sobre cabeçalho/rodapé/botões era salva. `message-bubble.tsx` também não tinha lógica para renderizar isso, mesmo quando disponível.

Auditoria adicional (a pedido do usuário, "garantir que todo template criado possa ser interpretado pelo chat") mapeou **todos** os caminhos de envio de template e encontrou o mesmo bug faltando em automações (`src/lib/automations/meta-send.ts`, step `send_template`), que gravava `content_text: null` e nenhum preview. Bônus: esse mesmo caminho também **falhava o envio à Meta** para templates com cabeçalho de mídia, pois não montava o componente de mídia obrigatório no payload — corrigido junto.

Broadcasts e Flows foram auditados e confirmados fora de escopo (broadcasts não gravam em `messages`; Flows não enviam templates).

### Correção

1. **Nova coluna** `messages.template_preview` (JSONB) — migração `037_template_message_preview.sql`.
2. **Novo tipo** `TemplatePreviewPayload` (`header?`, `headerMedia?: {type, url}`, `body`, `footer?`, `buttons?`) em `src/types/index.ts`.
3. **`send-message.ts`**: ao enviar `messageType === 'template'`, resolve header/body/footer/botões do `templateRow` (variáveis `{{n}}` substituídas) e grava em `template_preview`. Cobre cabeçalho de texto **e** de imagem/vídeo/documento (via `template.header_media_url`, URL pública — não precisa do proxy de autenticação usado para mídia recebida).
4. **Novo componente** `src/components/interactive/template-preview.tsx` — renderização estilo WhatsApp (mesmo padrão do `InteractivePreview` já existente), com ícone por tipo de botão (`Reply`/`ExternalLink`/`Phone`/`Copy`) e fallback para tipo de botão desconhecido (não quebra a thread se a Meta um dia mandar um tipo novo, ex. OTP/FLOW).
5. **`message-bubble.tsx`**: `case 'template'` agora renderiza `TemplatePreview` quando `template_preview` existe; mensagens antigas (pré-migração) caem no fallback de texto simples — sem quebra.
6. **`message-thread.tsx`**: mensagem otimista de `handleSendTemplate` já monta o `template_preview` no client, para os botões aparecerem instantaneamente ao enviar (mesmo padrão já usado pelo envio de mensagens interativas).
7. **`meta-send.ts` (automações)**: passou a carregar o `templateRow` local antes do envio — corrige tanto a falta de preview no chat quanto o bug latente de envio falhar para templates com cabeçalho de mídia.

### Limitações conhecidas

- Template que só existe na Meta (nunca sincronizado/editado localmente) não tem `header_media_url` — envio de cabeçalho de mídia falha com erro claro pedindo a URL.
- Mensagens de template enviadas antes da migração não ganham preview retroativo.

### Arquivos alterados

- `supabase/migrations/037_template_message_preview.sql` (novo)
- `src/types/index.ts`
- `src/lib/whatsapp/template-send-builder.ts`
- `src/lib/whatsapp/send-message.ts`
- `src/lib/automations/meta-send.ts`
- `src/components/interactive/template-preview.tsx` (novo)
- `src/components/inbox/message-bubble.tsx`
- `src/components/inbox/message-thread.tsx`

### Verificação

- `npx tsc --noEmit` — sem erros.
- `npx eslint` nos arquivos alterados — sem erros novos (só warnings pré-existentes, ex. `<img>` sem `next/image`).
- `npx vitest run` — 32 testes de automações + testes de `template-send-builder`/`send-message` passando.
- Migração `037` aplicada manualmente pelo usuário; testado em produção após deploy — confirmado resolvido.
