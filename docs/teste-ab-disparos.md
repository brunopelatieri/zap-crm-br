# Teste A/B de templates nos disparos

> Guia de uso do recurso. Para o desenho técnico e as decisões de
> arquitetura, veja a seção §6.6 da
> [SPEC 044](./spec-044-audiencia-multiformato-e-triagem.md).

**Em uma frase:** a mesma audiência é dividida por sorteio entre dois
templates aprovados, e as duas campanhas aparecem lado a lado na tela de
resultado — para você descobrir qual texto funciona antes de gastar a
base inteira com o texto errado.

---

## 1. Quando usar (e quando não)

| Use para                                           | Não use para                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Comparar **duas redações** da mesma oferta         | Comparar públicos diferentes — isso é segmentação, não A/B                  |
| Testar chamada para ação, tom, tamanho da mensagem | Comparar **categorias** diferentes (Marketing × Utility) — o sistema recusa |
| Decidir o texto de uma campanha recorrente         | Audiências minúsculas: abaixo de ~300 por braço não há veredito confiável   |

**A regra que mais economiza tempo:** mude **uma coisa** entre A e B. Se
os dois templates diferem em texto, imagem e botão ao mesmo tempo, o
resultado diz que um venceu, mas não diz por quê — e você não consegue
repetir o acerto na próxima campanha.

---

## 2. Antes de começar

- **Dois templates aprovados pela Meta, da mesma categoria** (dois
  Marketing, ou dois Utility). Categoria diferente muda quem entra na
  audiência (opt-out só vale para marketing), o que invalidaria a
  comparação.
- **Permissão de atendente (`agent`) ou superior** — a mesma de qualquer
  disparo.
- **Cota de 24 h suficiente para os dois braços somados.** O teste
  consome exatamente a mesma cota que um disparo único da mesma
  audiência: ele divide, não duplica.

---

## 3. Como disparar — os 4 passos

| Passo                 | O que fazer                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Template**       | Escolha o template A. Abaixo da lista aparece **"Testar dois templates (A/B)"** — marque, escolha o template B e a divisão (50/50 é o padrão; até 90/10). Só aparecem candidatos da mesma categoria.                              |
| **2. Audiência**      | Igual a sempre: todos, etiquetas, campo personalizado, planilha ou triagem. O teste não muda nada aqui.                                                                                                                           |
| **3. Personalização** | Agora com **uma aba por variante**. Cada template tem os próprios `{{1}}`, `{{2}}`… e a própria imagem de header. Um ponto âmbar na aba indica variável faltando. O botão "Enviar teste" (simulação a seco) funciona em cada aba. |
| **4. Envio**          | Um bloco extra mostra a divisão prevista (ex.: `1.000 → 500 A / 500 B`). Confirme e envie, ou agende.                                                                                                                             |

Ao final você terá **duas campanhas** na lista, com o mesmo nome e um
chip `Variante A` / `Variante B`.

### Divisão desigual (90/10, 80/20)

Útil quando o template B é uma aposta arriscada: manda-se o texto
conhecido para a maioria e o experimental para uma fatia pequena. O
preço é estatístico — o braço menor demora muito mais para alcançar
significância. Para **decidir** entre dois textos, 50/50 é sempre o mais
eficiente.

---

## 4. Como ler o resultado

Abra qualquer uma das duas campanhas: a tela de detalhe mostra os dois
funis lado a lado, a tabela de taxas e um selo no topo.

| Selo                               | Significa                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 🏆 **Variante X venceu em Lidas**  | Diferença estatisticamente significativa (p < 0,05) **e** os dois braços acima de 300 mensagens enviadas |
| ⚠️ **Amostra pequena**             | Menos de 300 enviadas em algum braço. As taxas aparecem, mas **não decidem nada**                        |
| ℹ️ **Sem diferença significativa** | Amostra suficiente, mas a diferença é indistinguível de acaso                                            |

**Como as taxas são calculadas:** sobre as mensagens **enviadas** de cada
braço, não sobre os destinatários. Quem tem telefone inválido nunca
recebeu nada e não entra no denominador — assim o braço que por acaso
herdou mais números ruins não é punido por isso.

**Diferença em "pontos"**, não em "%": sair de 40% para 45% é +5 **pontos**
(e +12,5% relativos). A tela mostra pontos porque é a leitura que não
engana.

**Por que o vencedor sai da taxa de leitura:** entrega depende do número,
não do texto (fica em ~100% nos dois braços); resposta é rara demais para
mover em 300 envios. Leitura é a métrica que o texto do template de fato
influencia. As três continuam visíveis na tabela.

### Quanta gente é preciso?

Aproximação prática (α = 5%, poder 80%, taxa base ~40%):

| Enviadas por braço | Detecta diferenças de       |
| ------------------ | --------------------------- |
| 300                | ~11 pontos (ex.: 40% → 51%) |
| 1.000              | ~6 pontos                   |
| 5.000              | ~3 pontos                   |

Se o seu teste tem 300 por braço e a diferença real é de 2 pontos, o
resultado será "sem diferença significativa" — e isso está **correto**:
o teste não tinha como enxergar algo tão pequeno.

---

## 5. O que o sistema garante (e recusa)

| Garantia                                                     | Detalhe                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Sorteio **exato**                                            | 50% de 1.000 é sempre 500/500, nunca 487/513. Embaralha e fatia, em vez de sortear pessoa a pessoa |
| Audiência resolvida **uma vez**                              | Os dois braços saem da mesma lista, no mesmo instante                                              |
| Opt-out (LGPD) e número morto aplicados **antes** do sorteio | Ninguém é excluído de um braço e mantido no outro                                                  |
| Cota conferida **na soma**                                   | Um teste que não cabe na janela de 24 h é recusado inteiro                                         |
| Envio em **sequência**                                       | Os dois braços saem pelo mesmo número, sem dobrar a taxa instantânea                               |

| Recusa                         | Mensagem                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| Mesmo template nos dois braços | "Um teste A/B precisa de dois templates diferentes"             |
| Categorias diferentes          | "As duas variantes precisam ser da mesma categoria de template" |
| Menos de 2 contatos válidos    | "Audiência pequena demais para dividir em dois braços"          |

---

## 6. Agendamento

Um teste A/B pode ser agendado normalmente no passo 4. Duas observações:

- A **divisão acontece na hora do envio**, não no agendamento — quem
  entrar na etiqueta amanhã participa; quem pedir descadastro hoje à
  noite não recebe.
- Depende do cron (`GET /api/broadcasts/cron`) estar agendado no seu
  deploy, como qualquer disparo agendado. Sem ele, as duas linhas ficam
  paradas em "Agendado".

---

## 7. Limitações conhecidas

| Limitação                                                                        | Contorno                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **"Salvar rascunho" some** com o teste ligado — o rascunho guarda um template só | Use o agendamento, que preserva as duas variantes                                        |
| **Sem promoção automática do vencedor** para o resto da base                     | Dispare uma campanha nova com o template vencedor                                        |
| **Apagar a variante A apaga o teste inteiro** (a B vai junto)                    | A tela avisa antes de confirmar; apagar só a B é permitido e degrada para campanha comum |
| Exatamente **dois** braços                                                       | Testes A/B/C precisam ser feitos em rodadas                                              |

---

## 8. Roteiro de validação (5 minutos)

1. Crie/aprove dois templates de mesma categoria.
2. Dispare para uma audiência de teste de 4 contatos com divisão 50/50.
3. Confirme: **duas** campanhas na lista com chips A e B; na tela de
   detalhe, dois funis e o selo **"Amostra pequena"** (4 contatos nunca
   decidem nada — é exatamente o comportamento esperado).
4. Opcional: agende para +6 minutos e confirme que as duas saem juntas.

---

**Referências:** [SPEC 044 §6.6](./spec-044-audiencia-multiformato-e-triagem.md) ·
migração [`051_broadcast_ab_test.sql`](../supabase/migrations/051_broadcast_ab_test.sql) ·
lógica de sorteio e estatística em [`src/lib/broadcasts/ab-test.ts`](../src/lib/broadcasts/ab-test.ts)
