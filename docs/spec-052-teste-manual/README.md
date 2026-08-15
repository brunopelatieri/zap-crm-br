# Material de teste manual — SPEC 052 (§9.2)

Arquivos para rodar os testes manuais 1-7 do [§9.2 da SPEC 052](../spec-052-importacao-de-contatos-multiformato.md#92-manuais-antes-do-merge).
Teste tanto em **Contatos → Importar** quanto no **passo 2 de um disparo**
(fonte "Arquivo CSV ou Excel" / "Google Planilhas"), quando o arquivo se
aplicar aos dois.

Gerados por script (Python + `openpyxl`), não por um Excel de verdade —
aproximam o comportamento real, mas não são garantia de bit-a-bit idêntico
a um arquivo exportado pelo seu Excel/Google Sheets. O item 2 (Google
Planilhas) eu não consigo gerar de jeito nenhum — é um serviço externo que
exige sua conta; instruções abaixo para você montar em 1 minuto.

---

## 1. `01-csv-ponto-e-virgula-excel-ptbr.csv`

**Testa:** manual 1 (CSV `;` do Excel em pt-BR) + manual 6 (apóstrofo).

CSV separado por `;`, com BOM UTF-8, cabeçalho em português
(`telefone;nome;email;empresa;etiquetas`), acentos, e 20 linhas de contatos
fictícios — incluindo dois nomes com apóstrofo (`Maria D'Ávila`,
`O'Brien Consultoria`).

**Esperado:**

- As 20 linhas são reconhecidas (delimitador `;` farejado certo).
- `Maria D'Ávila` e `O'Brien Consultoria` aparecem com o apóstrofo intacto
  no preview e depois de importado — **não** `DÁvila` / `OBrien`.
- Linhas com `vip;atacado`, `lead;novo`, `vip;prioritario`, `lead;juridico`
  na coluna de etiquetas (dentro de uma célula só) viram **duas** etiquetas
  cada, não uma.
- Nenhuma linha rejeitada.

---

## 2. `02-csv-etiquetas-virgula-entre-aspas.csv`

**Testa:** manual 4 (etiquetas, os três jeitos) + o caso documentado como
limitação conhecida (achado A/D da SPEC, §2.2).

CSV separado por `,` (o padrão), 4 linhas:

| Linha | Célula de etiquetas    | O que testa                                                                                                                                                                                                                            |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `"vip, prioritario"`   | Vírgula **entre aspas** — duas etiquetas (achado B)                                                                                                                                                                                    |
| 2     | `vip;lead`             | Ponto e vírgula **sem aspas** — funciona mesmo num CSV `,` (achado C)                                                                                                                                                                  |
| 3     | `cliente`              | Uma etiqueta só, controle                                                                                                                                                                                                              |
| 4     | `vip,lead` (sem aspas) | **Limitação conhecida, documentada — não é bug.** Vírgula sem aspas num CSV `,` é lida como separador de coluna: só `vip` vira etiqueta, `lead` some. É exatamente o que a nota "separe por `;`" do card de modelo existe para evitar. |

**Esperado:** linhas 1-3 com duas/uma etiqueta corretas; linha 4 com
**só uma** etiqueta (`vip`) — se a linha 4 trouxer as duas, alguma coisa
mudou no parser e vale investigar (o comportamento é rastreado por teste
automatizado em `src/lib/contacts/parse-contact-csv.test.ts` e
`src/lib/spreadsheet/parse-csv.test.ts`, casos A e D).

---

## 3. `03-planilha-duas-abas.xlsx`

**Testa:** manual 3 (`.xlsx` com duas abas, capa sem telefone) + a parte de
achado H/I que dá para simular sem um Excel de verdade.

Duas abas:

- **"Leia-me"** — só texto de instrução, sem coluna de telefone. Vem
  **primeiro** no arquivo de propósito.
- **"Contatos"** — 4 linhas: telefone guardado como **número** (linhas 2
  e 4) e como **texto com zero de tronco** (`011977776666`/`031988776655`,
  linhas 3 e 5); uma célula de etiquetas com vírgula sem aspas
  (`vip, prioritario`) — numa planilha de verdade isso não precisa de
  aspas, ao contrário do CSV.

**Esperado:**

- O seletor de aba aparece (a pasta tem mais de uma aba) e a aba
  **"Contatos"** é escolhida sozinha, sem você precisar trocar manualmente.
- As 4 linhas entram — os telefones como número **e** como texto viram o
  mesmo formato depois de normalizados.
- A célula `vip, prioritario` vira **duas** etiquetas, sem exigir aspas
  (diferente do CSV).

---

## 4. `04-linhas-rejeitadas.csv`

**Testa:** manual 5 — o alerta pós-importação (D-3): a lista de rejeitadas
precisa **continuar na tela** depois de "Importação concluída", não sumir.

3 telefones bons + 3 ruins:

| Telefone      | Motivo esperado da rejeição  |
| ------------- | ---------------------------- |
| (3 primeiros) | —, válidos                   |
| `1099999999`  | DDD inválido (10 não existe) |
| `123456`      | Comprimento inválido         |
| _(vazio)_     | Sem telefone                 |

**Esperado:**

- Antes de importar: chips mostram 3 válidas / 3 inválidas, e a lista de
  rejeitadas mostra as 3 linhas ruins com o motivo certo, cada um
  traduzido (não uma chave crua tipo `invalid_ddd`).
- Depois de clicar em importar: os 3 bons entram, e a **mesma lista de
  rejeitadas continua visível**, ao lado do resumo "3 importados" — este é
  o comportamento que a F5 corrigiu (antes a lista sumia nesse momento).

---

## 5. `05-validacao-spec-050.csv`

**Testa:** manual 7 — a validação da SPEC 050 preservada depois da
unificação da F2 (D-2).

| Telefone        | Esperado                                                |
| --------------- | ------------------------------------------------------- |
| `11 9876-5432`  | Entra **sem aviso** — celular legado de 8 dígitos (D-6) |
| `10 98765-4321` | Rejeitado como **DDD inválido** — DDD 10 não existe     |

**Esperado:** repita este teste com o idioma da conta em **pt-BR e em
inglês** — a mensagem de rejeição precisa traduzir nos dois (chave
`Import.reason.invalid_ddd`).

---

## 6. Google Planilhas (manual 2) — sem arquivo, só instruções

Não dá para gerar um link do Google Sheets por aqui — é um documento na
sua conta Google. Passo a passo rápido:

1. Abra [sheets.google.com](https://sheets.google.com) → planilha em
   branco.
2. Cole o conteúdo do arquivo **`01-csv-ponto-e-virgula-excel-ptbr.csv`**
   (abra-o num editor de texto, copie tudo, cole na célula A1 da
   planilha — o Google Sheets separa em colunas sozinho).
3. **Arquivo → Compartilhar → Alterar para "Qualquer pessoa com o link"**
   → função **Leitor**. Sem isso a importação falha com "planilha não
   está pública" — que é o próprio teste manual 2 pedindo para você
   confirmar essa mensagem antes de liberar o acesso.
4. Copie o link e cole no campo "Google Planilhas" do importador.
5. Depois do teste, tire o compartilhamento e tente importar de novo — a
   mensagem de erro deve dizer que a planilha não está pública, não um
   erro genérico.

**Confirme também** (só isso depende do seu ambiente, não dá para testar
daqui): a instalação consegue sair para `docs.google.com`. Se a
Hostinger bloquear egress, esse caminho falha em produção mesmo com o
código certo — melhor descobrir agora do que depois do deploy.

---

## Não coberto por estes arquivos

- **Teste manual 8** (disparo não regrediu): reuse o arquivo `03` ou o
  link do Google Sheets do item 6 no **passo 2 do disparo**, não só em
  Contatos — os dois consomem o mesmo parser, mas vale confirmar que a
  tela não mudou visualmente além das 2 notas novas (SPEC 052 F5).
- **Teste manual 9** (tema/viewport): não depende de arquivo — abra o
  modal em claro/escuro e em 375px de largura.
