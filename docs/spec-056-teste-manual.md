# SPEC 056 — Checklist de teste manual (F4)

Checklist executável do [§7.3 da SPEC 056](./spec-056-transferencia-entre-canais.md#73-manual-obrigatório-antes-do-merge). Não é um documento novo de decisão — é o §7.3 desdobrado em passo a passo, com o SQL de conferência pronto para colar, para rodar contra o número real antes do merge.

**Pré-requisito de código:** F1–F3 implementadas (`src/lib/channels/transfer.ts`, `src/lib/inbox/find-or-create-conversation.ts`, rota `POST /api/inbox/conversations/transfer`, diálogo de transferência). Nada commitado ainda no momento em que este checklist foi escrito — rodar contra o working tree local (`npm run dev`) ou contra o branch antes do merge.

---

## 0. Preparação

Feito uma vez, antes dos 10 itens abaixo.

- [ ] Conta de teste com **dois canais ativos**: o WhatsApp Oficial (Cloud API) já configurado, e uma instância QRCode pareada com um celular real (SPEC 048 §8.2 — `node scripts/evolution-probe.mjs --lifecycle --keep`, ou uma instância já existente na aba "WhatsApp QRCode").
- [ ] Um **contato de teste** com telefone real, que você controla (o celular que vai receber as mensagens dos testes 1–4).
- [ ] Anote o `contact_id` e os dois `channel_id` (oficial e QRCode) — vai precisar deles nas consultas SQL abaixo. Forma rápida de achar:

  ```sql
  select id, name, phone from contacts where phone like '%<seu número, só dígitos>%';
  select id, name, type, status from channels where account_id = '<sua account_id>';
  ```

- [ ] Confirme em qual projeto Supabase você está testando (`vn`, `rs` ou `jh` — AGENTS.md) antes de rodar qualquer SQL, mesmo sendo só `SELECT`.

---

## 1. O caso que motiva a SPEC — Cloud → QRCode com janela fechada

**Por quê:** é o cenário inteiro que a SPEC existe para resolver — resgatar um contato sem pagar template.

1. Abra (ou force) uma conversa no canal **Oficial** com a janela de 24h **fechada** (sem mensagem do contato nas últimas 24h).
2. Na faixa âmbar "janela expirada", clique **"Continuar por outro canal"**.
3. Escolha o canal QRCode, escreva um texto, confirme.
4. No celular do contato de teste: a mensagem chega do **número QRCode**, não do oficial.
5. No CRM: você é levado automaticamente para a thread do QRCode.

- [ ] Passou

---

## 2. 🔴 O cliente responde — o teste que valida a SPEC inteira

**Por quê:** é o achado central (§1.1) — sem isto, a SPEC não fecha. Se falhar aqui, a "conversa continua lá" (D-2) é mentira.

1. Continuando do teste 1: pelo celular do contato, **responda** a mensagem que chegou.
2. No CRM: a resposta aparece na **mesma thread do QRCode** para onde você foi levado no teste 1 — não numa terceira thread, não na do oficial.

- [ ] Passou — **se este falhar, pare e não continue os demais até investigar.**

---

## 3. QR → Oficial com a janela do oficial fechada — ação desabilitada (D-3)

**Por quê:** sem esta guarda, o sentido QR→Oficial ofereceria um botão que quase sempre leva a uma cobrança de template não pedida.

1. Estando na thread do QRCode (a que sobrou dos testes 1–2), garanta que o contato **não** tem janela aberta no canal oficial (não escreveu para o número oficial nas últimas 24h).
2. Abra o diálogo de transferência a partir dessa thread (ou pela ficha do contato).
3. O canal Oficial aparece **esmaecido, com o motivo** ("janela de 24h fechada…") — não desaparece, não é clicável como destino.

- [ ] Passou

---

## 4. QR → Oficial com a janela do oficial aberta — funciona

1. Peça ao contato de teste para escrever **para o número oficial** (abre a janela de 24h dele).
2. Repita o teste 3: agora o canal Oficial aparece **selecionável** no diálogo.
3. Confirme a transferência — a mensagem sai pelo Oficial, você é levado para aquela thread.

- [ ] Passou

---

## 5. Contato opted-out — recusa com motivo, SEM criar conversa (D-4)

**Por quê:** é a única exceção do sistema — resgatar por outro número quem pediu para sair é iniciar contato, não responder.

1. Marque o contato de teste como `opted_out` (Configurações → Contatos, ou direto no banco para teste: `update contacts set opt_in_status = 'opted_out' where id = '<contact_id>'` — **lembre de reverter depois**).
2. Tente transferir esse contato para qualquer canal.
3. A UI recusa com um motivo claro (não é um erro genérico).
4. **Confira no banco** — o ponto que a asserção automatizada já cobre, mas vale ver ao vivo:

   ```sql
   select count(*) from conversations
   where contact_id = '<contact_id>' and channel_id = '<channel_id_do_destino_tentado>';
   -- Espera-se: a MESMA contagem de antes da tentativa. Nenhuma linha nova.
   ```

- [ ] Passou — reverta o opt-out do contato de teste depois: `update contacts set opt_in_status = 'opted_in' where id = '<contact_id>'`

---

## 6. Instância QRCode desconectada — some da lista; cai no meio, erro claro

1. Com o diálogo de transferência **fechado**, desconecte a instância QRCode (aba WhatsApp QRCode → Desconectar).
2. Abra o diálogo: o canal QRCode **não aparece mais** na lista de destinos elegíveis.
3. Agora o caso mais fino — a instância cai **enquanto o diálogo já está aberto**: abra o diálogo com a instância ainda conectada, desconecte-a nesse meio-tempo (outra aba/dispositivo), e só então confirme o envio.
4. A rota recusa com um erro claro (canal não conectado) — **nenhuma thread nova** é criada.

   ```sql
   select count(*) from conversations
   where contact_id = '<contact_id>' and channel_id = '<channel_id_qrcode>';
   ```

- [ ] Passou — reconecte a instância depois.

---

## 7. Conta com um canal só — nenhuma mudança visível

**Por quê:** ruído em conta de canal único é o erro mais fácil de introduzir sem perceber.

1. Numa conta (ou visão) que só tem o WhatsApp Oficial configurado, abra uma conversa com a janela expirada.
2. A faixa âmbar mostra **só** o botão de template — sem "Continuar por outro canal".
3. Abra a ficha de um contato qualquer — a seção "Também neste contato" **não aparece** (nem vazia).

- [ ] Passou

---

## 8. Canal de destino que já tem thread — reaproveita, não duplica

1. Com o contato de teste já tendo threads nos dois canais (deve ter, dos testes 1–4), transfira de novo do Oficial para o QRCode.
2. Você deve cair na **mesma** thread do QRCode que já existia — não uma nova.
3. Confira no banco:

   ```sql
   select count(*) from conversations
   where contact_id = '<contact_id>' and channel_id = '<channel_id_qrcode>';
   -- Espera-se: 1. Nunca 2.
   ```

- [ ] Passou

---

## 9. Envio frio conta na cota (`channel_cold_sends`, `origin='human'`)

**Por quê:** esta ação é o vetor de envio frio mais provável do sistema — precisa contar, mesmo sem bloquear.

1. Transfira para um contato que está em silêncio há mais de 24h no canal QRCode (ou force isso: use um contato que nunca conversou por lá — é sempre "frio" na primeira mensagem).
2. Confira a linha nova:

   ```sql
   select * from channel_cold_sends
   where contact_id = '<contact_id>' and channel_id = '<channel_id_qrcode>'
   order by sent_at desc limit 1;
   -- Espera-se: origin = 'human'
   ```

3. Na aba "WhatsApp QRCode", o consumo da instância subiu (contador de envio frio).
4. No diálogo de transferência, ao selecionar esse canal, o aviso de risco menciona a cota — confira que o número bate com o que você acabou de ver na aba.

- [ ] Passou

---

## 10. Depois de transferido — composer completo no canal de destino

1. Na thread de destino (a que você foi levado por qualquer teste acima), envie uma **imagem** e um **áudio** pelo composer normal (não pelo diálogo de transferência — esse já fechou).
2. Ambos chegam no celular do contato de teste.
3. As capacidades exibidas no composer são as do canal de destino (ex.: sem botão de Template no QRCode — SPEC 049 §4.3, inalterado por esta SPEC).

- [ ] Passou

---

## Definição de pronto (SPEC 056 §10)

Depois dos 10 itens acima, confira:

- [ ] Teste 2 provou pergunta e resposta na **mesma** thread — é o critério que distingue esta SPEC de um simples "envio por canal alheio".
- [ ] QR→Cloud (testes 3–4) se comportou como o D-3 descreve nos dois estados da janela.
- [ ] Teste 5 confirmou **nem conversa nem mensagem** para contato opted-out (não só "não enviou").
- [ ] Teste 7 confirmou que uma conta de canal único não vê diferença nenhuma.
- [ ] `git diff` (quando for revisar o PR) não alcança `lib/channels/send.ts`, `ingest.ts`, `engine.ts` nem `supabase/migrations/` — zero migrações é o esperado desta SPEC.
- [ ] `npm run typecheck && npm run i18n:check && npm run lint && npm run test && npm run format:check && npm run build` — verde, na ordem, antes do push (já validado na F1–F3; rode de novo se algo mudou desde então).

Marcando os 10 itens + esta seção, a SPEC 056 está pronta para commit e deploy.
