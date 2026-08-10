# SPEC 046 — Construtor visual de agendamento (`VisualCronBuilder`) e execução do gatilho `time_based`

**Status:** 🟢 Implementada (5 fases, 2026-08-10) · **1ª revisão de arquitetura em 2026-08-10 (Opus 5)**: checkpoints S2 e S3 da §12 executados — os dois passaram; seis achados em outro lugar, todos corrigidos. Sumário em §0
**Módulo:** `src/components/automations/automation-builder.tsx` (novo: `visual-cron-builder.tsx`), `src/lib/automations/` (novos: `schedule.ts`, `schedule-scan.ts`), `src/app/api/automations/cron/route.ts`, `supabase/migrations/` (nova migração — próximo número livre: **054**; a última aplicada é `053_session_window_metrics.sql`)
**Data:** 2026-08-10
**Autor:** Especificação técnica gerada para o ZAP CRM BR
**Referências de padrão:** [spec-045-reengajamento-janela-24h.md](spec-045-reengajamento-janela-24h.md) (mesmo formato; a varredura de §6 é modelada na dela) · [src/lib/broadcasts/send-window.ts](../src/lib/broadcasts/send-window.ts) (precedente de tempo/fuso como função pura testável — e fornecedor de quase toda a aritmética de fuso desta SPEC) · [src/components/broadcasts/step4-schedule-send.tsx](../src/components/broadcasts/step4-schedule-send.tsx) (precedente de UI de agendamento com fuso)

> ⚠️ **Esta SPEC não é "trocar um input por uns dropdowns".** O campo de
> texto que ela remove alimenta um gatilho que **nenhuma linha do backend
> executa hoje**. Substituir o campo cru por uma interface visual bonita, sem
> mais nada, transforma um recurso obscuro num convite explícito a um recurso
> quebrado: hoje quem digita `0 9 * * 1-5` provavelmente sabe o que está
> fazendo e percebe que nada acontece; depois da mudança, qualquer usuário
> vai clicar em "Toda segunda às 9h", ativar, e esperar. A §2 documenta essa
> lacuna com precisão de arquivo/linha antes de propor qualquer solução, e é
> por isso que o escopo inclui o runtime.

---

## 0. Sumário da revisão de arquitetura (2026-08-10, Opus 5)

Os dois checkpoints que a §12 exige foram executados com a leitura
obrigatória da coluna correspondente. **Os dois passaram**:

- **S2 — o laço parse↔serialize (§4.4).** `commit()` grava o último cron
  emitido **antes** de chamar `onChange`, então o `props.value` que
  volta é reconhecido e não re-semeia. Verificado também nos três
  caminhos que costumam escapar da guarda: modo avançado com cron
  inválido (não emite, texto parcial sobrevive), re-render do pai por
  outro campo (`config` é objeto novo, `schedule` é a mesma string) e o
  `TagSelect` da audiência (não passa por `commit`).
- **S3 — N² e duplicação sob ticks sobrepostos.** `runSingleAutomation`
  por contato, travado por teste. A chave do claim é a ocorrência
  truncada ao minuto, e a truncagem é estável entre ticks com segundos
  diferentes (09:31:12 e 09:36:47 produzem a mesma chave).

O que a revisão pegou está **fora** desses dois pontos — e dois achados
são a reencenação exata do modo de falha que esta SPEC existe para
eliminar: a UI prometendo o que o runtime recusa em silêncio.

| #   | Achado                                                                                                                                                                                                                                                                                            | Gravidade                             | Onde |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- |
| 1   | **A janela de horário barra, sem aviso, agendamentos que o construtor oferece.** `SEND_WINDOW` é dias úteis 09h–20h; a UI tem preset "Todos os dias", caso especial de "fim de semana" no resumo e aceita `22:00`. Sábado às 10h **nunca** dispara — e a pré-visualização listava a data concreta | 🔴 Produto — promessa falsa           | §5.4 |
| 2   | **O teto de 50 contatos truncava a entrega para sempre.** A ocorrência só vive 2 ticks; a query relia os mesmos contatos, achava todos reivindicados e despachava zero. Etiqueta de 200 contatos = 150 nunca recebiam, todo dia, sem nada no log                                                  | 🔴 Corretude — não-entrega silenciosa | §6.2 |
| 3   | `contact_tags` sem `ORDER BY` — _quais_ mil linhas voltam é indefinido; agrava o nº 2                                                                                                                                                                                                             | 🟠 Fidelidade de dados                | §6.2 |
| 4   | A janela era testada em `now`, não na ocorrência: 19:58 morria com tick às 20:01; 08:58 passava com tick às 09:01                                                                                                                                                                                 | 🟡 Corretude nas bordas               | §6.4 |
| 5   | Semanal com zero dias: `scheduleToCron` mapeava `[]` para `*` e a pré-visualização mostrava disparos **diários** contradizendo o aviso na tela                                                                                                                                                    | 🟡 UI                                 | §5.2 |
| 6   | Rascunho com `schedule` vazio exibia "Todo dia às 09:00" e falhava ao ativar com "schedule is required"                                                                                                                                                                                           | 🟡 UI                                 | §5.5 |

**Como cada um foi resolvido**

1. `nextOccurrences` ganhou `deliverableOnly`, e `scheduleCoverage()`
   devolve `deliverable` / `someBlocked` / `neverFires`. O construtor
   pré-visualiza só o que dispara de verdade e mostra dois avisos novos
   (`sendWindowNever` em vermelho, `sendWindowPartial` em âmbar).
   `validate.ts` **recusa a ativação** de um agendamento cujas
   ocorrências caem todas fora da janela. Decisão de produto do
   mantenedor: manter o guardrail (reputação do número) e tornar a
   restrição visível, em vez de removê-la.
2. A query de contatos passou a excluir quem já tem claim **desta**
   ocorrência antes de aplicar o teto, então o segundo tick entrega o
   lote seguinte em vez de zero. Teto por ocorrência de 50 → 100
   (≈30 s a 300 ms/contato, dentro do `maxDuration` compartilhado), e
   `ScheduleScanResult.truncated` + `console.warn` tornam a truncagem
   visível. Teto efetivo: 200 contatos por disparo agendado; acima
   disso é campanha, e campanha é o módulo de disparos (§10).
3. `ORDER BY contact_id` em `contact_tags` e `ORDER BY id` em
   `contacts`.
4. `isWithinSendWindow` passou a filtrar **cada ocorrência**. Continua
   saindo antes de qualquer query quando nada sobra — o cálculo é puro.
5. Modo semanal sem dias é tratado como estado incompleto: não
   pré-visualiza.
6. `normalizeInitial()` semeia o `schedule` padrão na montagem do
   construtor (sem `useEffect`), preservando um `audience_tag_id` já
   escolhido.

**Nota (não corrigido, deliberado):** a §6.4 lista
`excludesOptedOut(category)`; o código usa só `isOptedOut`, que é
**mais restritivo** — bloqueia opted-out inclusive para template
utility. Divergência a favor da segurança, mantida.

---

## 1. Contexto e problema

O construtor de automações oferece o gatilho **"Baseado em horário"**
(`time_based`). Ao selecioná-lo, o usuário recebe um campo de texto livre com
o placeholder _"Expressão cron ou HH:mm"_ e a dica _"Expressão cron (ex.:
`0 9 * * 1-5`)"_
([automation-builder.tsx:1010-1027](../src/components/automations/automation-builder.tsx#L1010-L1027)).

Isso é uma barreira dura para o público do produto. O ZAP CRM BR é vendido
para operações comerciais brasileiras — gente que quer dizer _"toda segunda e
quarta às 9h"_ e não tem obrigação nenhuma de saber que o quinto campo de uma
expressão cron é o dia da semana, que domingo é `0`, ou por que `*/15` no
primeiro campo significa uma coisa e no segundo significa outra. O campo
também não valida nada: qualquer string não vazia é aceita, salva e ativada
([validate.ts:241-247](../src/lib/automations/validate.ts#L241-L247)).

O pedido de produto é uma interface visual: pílulas, seletores e um horário,
com a expressão cron gerada nos bastidores.

**Mas a análise do estado atual (§2) encontrou algo mais grave por baixo do
pedido:** `time_based` é configuração morta. O usuário pode configurar,
salvar, ativar — e nada dispara, nunca, sem nenhum erro em lugar nenhum. Essa
lacuna já estava registrada como débito técnico pré-existente na
[SPEC 045 §4](spec-045-reengajamento-janela-24h.md) ("Implementar o trigger
genérico `time_based` … fica registrado como débito técnico pré-existente") e
na §2.3 dela ("existem no tipo e no dropdown do builder, mas **nenhum call
site os dispara hoje**").

Esta SPEC fecha esse débito junto com a UI, porque as duas metades não se
sustentam separadas: a UI sem o runtime é uma promessa falsa, e o runtime sem
a UI continua inutilizável por quem o produto atende.

---

## 2. Análise do estado atual (obrigatória)

### 2.1 Onde o campo vive

`TriggerCard`
([automation-builder.tsx:919](../src/components/automations/automation-builder.tsx#L919))
é o card azul de gatilho do construtor. Ele renderiza um `<select>` cru de
tipo de gatilho (`:967-979`, sobre `TRIGGER_OPTIONS` em `:178-188`) seguido de
uma cadeia de condicionais `&&` — não um `switch` — com a configuração
específica de cada tipo. O bloco de `time_based` é o menor deles:

```tsx
{type === 'time_based' && (
  <div>
    <label …>{t('schedule')}</label>
    <Input
      placeholder={t('schedulePlaceholder')}
      value={(config.schedule as string) ?? ''}
      onChange={(e) => onConfigChange({ ...config, schedule: e.target.value })}
      className="bg-muted text-foreground"
    />
    <p …>{t('scheduleHint')}</p>
  </div>
)}
```

Restrições de layout que qualquer substituto herda: o card é
`max-w-[320px] sm:w-80` (`:936`). É uma coluna estreita, não um formulário
de página inteira — **nada de grade horizontal de cinco campos cron**.

### 2.2 O formato armazenado

[types/index.ts:586-590](../src/types/index.ts#L586-L590):

```ts
export interface TimeBasedTriggerConfig {
  /** Cron expression or simple HH:mm string; engine can accept either. */
  schedule: string;
  timezone?: string;
}
```

Dois fatos que importam:

1. O comentário promete que _"o motor aceita os dois"_. O motor não aceita
   nenhum dos dois, porque não lê o campo (§2.3).
2. `timezone` **nunca é escrito pela UI e nunca é lido por nada**. Um grep no
   `src/` inteiro não devolve um único leitor. É um campo que existe só no
   tipo.

O builder, por sua vez, nem usa esse tipo: `BuilderState.trigger_config` é
`Record<string, unknown>` e o valor é lido com cast no ponto de uso
(`config.schedule as string`). A união `AutomationTriggerConfig`
([types/index.ts:607-614](../src/types/index.ts#L607-L614)) termina em
`Record<string, unknown>`, o que na prática desliga a checagem.

### 2.3 O gatilho não é executado por nada

O caminho de despacho do motor é `runAutomationsForTrigger()`
([engine.ts:72](../src/lib/automations/engine.ts#L72)), que filtra por
`trigger_type` (`:109`). Ele tem exatamente **dois** call sites:

| Call site                                                                            | Gatilhos que passa                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| [webhook/route.ts:899](../src/app/api/whatsapp/webhook/route.ts#L899)                | os reativos a evento da Meta                       |
| [api/automations/engine/route.ts:32](../src/app/api/automations/engine/route.ts#L32) | o que vier no corpo da requisição (entrada manual) |

Nenhum dos dois passa `'time_based'` — e não teria como: não existe evento da
Meta chamado "deu 9h".

A rota de cron ([api/automations/cron/route.ts](../src/app/api/automations/cron/route.ts))
é o único lugar do sistema onde o tempo acorda o motor, e ela faz duas coisas:
drena `automation_pending_executions` vencidas (o step `wait`) e, dentro de
`after()`, chama `scanSessionWindows()`. Nunca consulta
`trigger_type = 'time_based'` e nunca lê `trigger_config.schedule`.

O agendamento em si não é código: vive em
[supabase/setup/cron-jobs.sql:150-163](../supabase/setup/cron-jobs.sql#L150-L163),
um `cron.schedule('zapcrm-automations-cron', '*/5 * * * *', …)` que faz um
`net.http_get` autenticado por `x-cron-secret`. **O tick é de 5 minutos** —
esse número é a restrição física de toda a §3.

### 2.4 O que já existe e deve ser reusado (não reimplementar)

Esta é a parte boa do estado atual: quase toda a matemática difícil já está
escrita e testada, no módulo dos disparos.

[send-window.ts](../src/lib/broadcasts/send-window.ts) exporta:

| Símbolo                               | O que resolve                                                                                                                                                                                                                        | Linha         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `DEFAULT_TIME_ZONE`                   | `'America/Sao_Paulo'`                                                                                                                                                                                                                | `:65`         |
| `isValidTimeZone` / `resolveTimeZone` | saneia um fuso vindo da rede                                                                                                                                                                                                         | `:71`, `:82`  |
| `ZonedParts` / `zonedParts(date, tz)` | quebra um instante em ano/mês/dia/hora/minuto/**dia da semana** naquele fuso, com `hourCycle: 'h23'` e o dia da semana calculado da data local (o comentário em `:135-137` explica por que `getUTCDay()` do instante estaria errado) | `:86`, `:119` |
| `zonedWallTimeToUtc(wall, tz)`        | instante UTC de uma hora de parede, com duas passadas para acertar bordas de DST                                                                                                                                                     | `:150`        |
| `isWithinSendWindow(date, tz)`        | guardrail de horário comercial                                                                                                                                                                                                       | `:182`        |
| `nextWindowOpening(date, tz)`         | próxima abertura da janela                                                                                                                                                                                                           | `:200`        |

`zonedParts` sozinho é **a metade difícil** de avaliar um cron num fuso: dado
um instante, ele entrega exatamente os cinco números que os cinco campos cron
comparam. E `zonedWallTimeToUtc` é a metade difícil da pré-visualização de
"próximos disparos".

Outros reusos obrigatórios:

- [consent.ts](../src/lib/contacts/consent.ts): `isOptedOut` (`:48`) e
  `excludesOptedOut` (`:42`) — guardrail de LGPD.
- [engine.ts:156](../src/lib/automations/engine.ts#L156): `runSingleAutomation`,
  extraído pela SPEC 045 §5.5.3 exatamente para o caso "eu já sei qual
  automação quero rodar".
- [window-scan.ts](../src/lib/automations/window-scan.ts): a estrutura inteira
  da varredura (fase A automações → fase B trabalho), o teto por tick
  (`MAX_CONVERSATIONS_PER_AUTOMATION = 50`, `:74`) e a retenção de claims
  (`:77`).
- [automation-builder.tsx:371](../src/components/automations/automation-builder.tsx#L371):
  `TagSelect`, já no arquivo, alimentado pelo `ResourcesProvider` (`:298`).

### 2.5 Não existe nenhuma biblioteca de cron no projeto

`package.json` não tem `cron-parser`, `cronstrue`, `croner` nem equivalente.
Todo hit de "cron" em `src/` e `lib/` é sobre os endpoints de ping do pg_cron
ou prosa sobre o tick de 5 minutos.

Isso é uma decisão a tomar, não um acidente — ver §3.4.

### 2.6 Primitivas de UI disponíveis

O projeto é **shadcn no estilo `base-nova` sobre [`@base-ui/react`](https://base-ui.com) ^1.6.0 — não Radix**
(`components.json` na raiz). `src/components/ui/` contém: `accordion`,
`alert`, `avatar`, `badge`, `button`, `card`, `checkbox`, `dialog`,
`dropdown-menu`, `gated-button`, `input`, `label`, `popover`, `radio-group`,
`scroll-area`, `select`, `separator`, `sheet`, `switch`, `table`, `tabs`,
`textarea`, `tooltip`.

**`toggle-group` e `slider` não existem.** É a primeira coisa que um desenho
de "pílulas segmentadas" tropeça. O precedente da casa para esse padrão é
[step4-schedule-send.tsx:340](../src/components/broadcasts/step4-schedule-send.tsx#L340),
que alterna `variant` num `Button` comum. §5.1 adota isso.

### 2.7 i18n

`next-intl` v4, dicionários planos em `messages/pt-BR.json` e `messages/en.json`,
mantidos em paridade por `npm run i18n:check`
([scripts/check-i18n-parity.mjs](../scripts/check-i18n-parity.mjs)) — uma chave
em um só dos dois quebra a verificação.

O construtor escopa o namespace `Automations.builder` e **passa o `t` como
prop** para os subcomponentes, com o tipo `ReturnType<typeof useTranslations>`
(ver `TriggerCard` em `:930` e `SessionWindowMarginConfig` em `:1060`), em vez
de re-chamar `useTranslations` em cada um. Qualquer componente novo segue esse
padrão.

As chaves atuais: `schedule` (pt-BR.json:1502), `scheduleHint` (`:1503`),
`schedulePlaceholder` (`:1504`).

### 2.8 Bug lateral: `trigger_config` acumula lixo

`onConfigChange({ ...config, schedule: … })` espalha o config anterior, e
trocar o tipo de gatilho não limpa nada. Uma automação que já foi
`keyword_match` e virou `time_based` carrega `keywords` e `match_type` para
sempre no JSONB. Hoje é inofensivo (cada leitor lê só o que conhece), mas
esta SPEC introduz um leitor novo que enumera automações por tipo, e config
órfã em produção é o tipo de coisa que estraga uma depuração meses depois.
§5.5 corrige de passagem.

---

## 3. Objetivo e decisões de escopo

Entregar um construtor visual de agendamento que qualquer usuário comercial
opere sem saber o que é cron — **e** fazer o gatilho realmente disparar.

### 3.1 Escopo: UI + runtime

Decidido com o mantenedor. As duas metades entram, em fases commitáveis
separadamente (§9), com a ordem escolhida para que **nenhuma fase deixe a UI
prometendo o que o runtime ainda não faz**.

### 3.2 Gramática: modelo restrito + escape para cron cru

A UI oferece cinco modos que cobrem o que o motor honra de verdade. Quem
precisa de mais tem um modo avançado com o campo cru — o mesmo campo de hoje,
que assim deixa de ser removido e passa a ser o último recurso, não o
primeiro.

Alternativa descartada: expor toda a gramática cron visualmente (listas,
faixas e passos por campo, meses). Multiplicaria a superfície de UI num card
de 320 px e daria ao usuário mais maneiras de montar um agendamento que o tick
de 5 minutos não consegue honrar — mais poder e menos confiabilidade, que é a
troca errada aqui.

### 3.3 Piso de granularidade: 15 minutos

Consequência direta de §2.3: o tick é de 5 min. Um item "a cada 1 minuto" no
seletor seria uma mentira — a automação dispararia a cada 5, no melhor caso.
Mesmo `*/5` é frágil: qualquer atraso de fila do `pg_net` (que é beta) desloca
o tick e faz o disparo pular.

15 minutos é o menor intervalo que sobrevive a um tick atrasado com folga de
três ciclos. É o mesmo raciocínio, e o mesmo número, do piso de
`margin_minutes` do gatilho de janela
([window-trigger.ts](../src/lib/automations/window-trigger.ts) e o comentário
em [validate.ts:252-256](../src/lib/automations/validate.ts#L252-L256): "uma
margem menor que 3 ticks de cron produz uma automação que dispara 'às vezes',
sem o autor descobrir por quê").

Intervalos oferecidos: **15 e 30 minutos; 1, 2, 3, 4, 6, 8 e 12 horas.**

> O modo avançado **não** contorna esse piso: a validação de §5.4 rejeita
> `* * * * *` e `*/5 * * * *` com a mesma mensagem. Um escape que aceita o
> impossível não é um escape, é uma armadilha.

### 3.4 Sem dependência nova de cron

Três funções são necessárias: gerar, interpretar e descrever. Nenhuma
biblioteca existente entrega as três para este projeto:

- **Descrever** é o problema real: `cronstrue` fala inglês (e o pacote de
  locales não cobre a fraseologia que a §5.3 quer, do tipo _"todo dia útil às
  9h"_). Um produto PT-BR/EN precisa das duas línguas passando pelo mesmo
  `messages/*.json` que `npm run i18n:check` fiscaliza.
- **Interpretar** vira ~60 linhas quando a gramática é a restrita (§4.1) — e
  precisa ser a gramática restrita de qualquer jeito, porque é o que o runtime
  sabe rodar.
- **Gerar** é trivial.

Então: módulo próprio, `src/lib/automations/schedule.ts`, puro e testável sem
React (§4).

### 3.5 Fuso: capturado do navegador, gravado na config

Adota o padrão já validado dos disparos:
`broadcasts.scheduled_timezone`, IANA, capturado com
`Intl.DateTimeFormat().resolvedOptions().timeZone`, saneado por
`resolveTimeZone` na leitura. O campo `timezone` de `TimeBasedTriggerConfig`
finalmente passa a ser escrito e lido.

Por que não `DEFAULT_TIME_ZONE` fixo (o que a varredura de janela faz): lá não
existe "quem agendou" — a varredura reage a uma condição de tempo sobre
conversas alheias. Aqui existe: uma pessoa escolheu "9h", e "9h" não significa
nada sem o fuso de quem escolheu. É exatamente a situação do agendamento de
disparo, e a resposta deve ser a mesma.

### 3.6 Audiência: segmento por etiqueta

Decidido com o mantenedor, e é a decisão que dá utilidade ao gatilho.

O problema: todo step de ação do motor recebe um `contactId`
([engine.ts:52-62](../src/lib/automations/engine.ts#L52-L62), `DispatchInput`).
Num gatilho reativo, o contato vem do evento. Num agendamento não existe
evento — logo, não existe contato, e `send_message` não tem para quem mandar.

A resposta: o card do gatilho ganha um seletor de audiência (etiqueta), e no
horário a automação roda **uma vez por contato do segmento**, via
`runSingleAutomation`, com todos os guardrails de §6.4.

Alternativa descartada: disparar uma vez com `contactId = null`. Só steps sem
contato funcionariam (`send_webhook`), e a UI teria de explicar por que metade
dos steps aparece como "pulado" no log. Runtime menor, produto sem uso.

### 3.7 Critérios de sucesso

1. Um usuário que nunca ouviu falar de cron configura _"toda segunda e quarta
   às 9h para quem tem a etiqueta X"_ sem digitar nada além do horário.
2. Toda automação `time_based` existente hoje continua abrindo no construtor
   sem perder um caractere do que foi salvo (§4.3, invariante 2).
3. Uma automação agendada e ativa dispara, e dispara **uma vez só** por
   ocorrência, mesmo com dois ticks de cron sobrepostos.
4. Um agendamento que cai fora da janela de horário permitido não dispara —
   e o log diz por quê.
5. `npm run i18n:check`, `npm test`, `npm run typecheck` e `npm run lint`
   passam.

---

## 4. Modelo de agendamento e estado bidirecional

Esta é a seção central. O resto da SPEC depende de as três funções aqui
estarem certas.

### 4.1 O formato armazenado não muda

`trigger_config.schedule` continua sendo **uma string cron de cinco campos**.

Isso não é conservadorismo: é o que mantém compatibilidade com as linhas já no
banco, com `validate.ts`, com a API pública e com qualquer automação criada
por integração. Um formato novo (`{mode:'weekly', days:[1,3], time:'09:00'}`)
exigiria migração de dados, um caminho de leitura duplo e uma decisão sobre o
que fazer com linhas que não migram — tudo para expressar a mesma informação.

Os cinco modos são **projeções** sobre esse formato, não substitutos dele:

| Modo       | Controles na UI                  | Cron gerado                    |
| ---------- | -------------------------------- | ------------------------------ |
| `interval` | a cada N min / N horas           | `*/15 * * * *` · `0 */2 * * *` |
| `daily`    | horário                          | `30 9 * * *`                   |
| `weekly`   | dias da semana (multi) + horário | `0 9 * * 1,3`                  |
| `monthly`  | dia do mês + horário             | `0 9 15 * *`                   |
| `advanced` | expressão crua                   | passa direto                   |

Gramática que o modelo restrito e o avaliador reconhecem, por campo:
`*`, um número, uma lista `a,b,c`, uma faixa `a-b`, e um passo `*/n`. **Não**
entram `L`, `W`, `#`, `?`, nomes de mês/dia (`MON`, `JAN`) nem o sexto campo
de segundos — §10.

### 4.2 `src/lib/automations/schedule.ts` (novo)

Módulo puro. Nada de React, nada de Supabase — como
[session-window.ts](../src/lib/whatsapp/session-window.ts) e
[send-window.ts](../src/lib/broadcasts/send-window.ts), pelos mesmos motivos: é
o que permite testar as bordas sem subir nada.

```ts
export type ScheduleMode =
  'interval' | 'daily' | 'weekly' | 'monthly' | 'advanced';

export type ScheduleState =
  | { mode: 'interval'; unit: 'minute' | 'hour'; every: number }
  | { mode: 'daily'; hour: number; minute: number }
  | { mode: 'weekly'; hour: number; minute: number; weekdays: Weekday[] }
  | { mode: 'monthly'; hour: number; minute: number; monthDays: number[] }
  | { mode: 'advanced'; raw: string };
```

Superfície pública:

| Função                                              | Contrato                                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduleToCron(state): string`                     | Serializa. Para `advanced`, devolve `state.raw` **sem tocar** (nem `trim` que altere semântica — só normalização de espaços entre campos).                                                                                         |
| `parseSchedule(raw): ScheduleState`                 | **Nunca lança.** O que não couber num preset volta como `{ mode: 'advanced', raw }`. Aceita o legado `HH:mm` (o placeholder de hoje promete isso) normalizando para `daily`. `''` → o padrão `{ mode:'daily', hour:9, minute:0 }`. |
| `describeSchedule(state, t): string`                | Resumo em linguagem natural, montado de fragmentos i18n.                                                                                                                                                                           |
| `validateSchedule(cron): ScheduleIssue \| null`     | Uma só porta de validação, usada pela UI **e** por `validate.ts`. Cobre: número de campos, gramática por campo, faixas por campo, e o piso de 15 min de §3.3.                                                                      |
| `cronMatches(cron, date, timeZone): boolean`        | O avaliador. Usado pelo runtime e por `nextOccurrences`.                                                                                                                                                                           |
| `nextOccurrences(cron, timeZone, n, from?): Date[]` | Pré-visualização. Varre minuto a minuto para frente com teto de busca (ver abaixo).                                                                                                                                                |

**`cronMatches` — por que é curto:** `zonedParts(date, tz)`
([send-window.ts:119](../src/lib/broadcasts/send-window.ts#L119)) já devolve
`{minute, hour, day, month, weekday}` naquele fuso. A função vira: quebrar a
expressão em cinco campos, e para cada um perguntar se o número correspondente
está no conjunto que o campo descreve. A única sutileza é a regra clássica de
cron para dia-do-mês × dia-da-semana: quando **os dois** são restritos (nenhum
é `*`), casa quem satisfizer **qualquer um dos dois** (OU, não E). O modelo
restrito nunca produz esse caso — só o modo avançado — mas o avaliador precisa
acertá-lo para não divergir de qualquer outra ferramenta cron que o usuário
conheça.

**`nextOccurrences` — teto de busca:** varredura minuto a minuto até 366 dias
à frente, abortando ao completar `n`. Um cron válido mas raríssimo (`0 0 29 2 *`
— 29 de fevereiro) precisa dos 366; um impossível (`0 0 30 2 *`) precisa do
teto para não rodar para sempre. A UI mostra "nenhum disparo previsto" quando
o retorno vem vazio, o que é o aviso certo para o caso impossível.

### 4.3 Invariantes (e os testes que os garantem)

`src/lib/automations/schedule.test.ts`, no molde de
[window-trigger.test.ts](../src/lib/automations/window-trigger.test.ts).

1. **Round-trip.** `parseSchedule(scheduleToCron(s))` ≡ `s` para todo `s`
   representável. Testado por enumeração sobre os modos restritos (todos os
   intervalos permitidos, os 60×24 horários não — uma amostra de bordas:
   `00:00`, `09:30`, `23:59`).
2. **Preservação.** Um cron que não casa com preset nenhum entra em
   `parseSchedule` e sai de `scheduleToCron` **byte a byte idêntico**.
   _É o invariante que impede o pior desfecho possível desta SPEC:_ uma
   automação em produção, agendada por alguém que sabia o que estava fazendo,
   ser silenciosamente reescrita porque a UI nova "não entendeu" a expressão e
   caiu num padrão. Casos de teste obrigatórios: `0 9 * * 1-5`,
   `15,45 * * * *`, `0 0 1 1,7 *`, `0 8 * * 1#2` (gramática não suportada — a
   UI mostra o erro, mas o valor é preservado).
3. **Totalidade.** `parseSchedule` nunca lança, para nenhuma entrada —
   `''`, `'abc'`, `'* * *'`, 10 kB de lixo, `null` coagido a string.
4. **Fuso.** `cronMatches('0 9 * * *', T, 'America/Sao_Paulo')` é verdadeiro
   exatamente para o `T` que é 12:00 UTC (com o Brasil em UTC−3) — e falso
   para o 09:00 UTC. Um teste equivalente para um fuso com DST
   (`America/New_York`) atravessando a virada, porque o fuso vem do navegador
   e pode ser qualquer um (o próprio `zonedWallTimeToUtc` documenta isso em
   `:143-149`).
5. **Piso.** `validateSchedule` rejeita `* * * * *`, `*/1 * * * *`,
   `*/5 * * * *`, `*/14 * * * *`; aceita `*/15 * * * *`.

### 4.4 Fonte da verdade e a guarda contra laço

**A string cron é a fonte da verdade.** O `ScheduleState` é derivado e vive
apenas no estado local do componente.

Não gravar o estado visual no banco, mesmo que "seria mais fácil de reabrir".
Seria uma segunda fonte da verdade, e ela diverge no primeiro dia: basta uma
linha escrita pelo modo avançado, pela API pública ou por um seed de template
para existir um `schedule` sem `ScheduleState` correspondente — e aí o
construtor tem de decidir em quem acreditar, com o runtime lendo um dos dois.

Daí decorrem duas regras de implementação que a §5.6 detalha e que precisam
estar escritas aqui porque são o modo de falha clássico de um componente
controlado com transformação bidirecional:

- **Só cron válido sobe.** Estado incompleto — modo `weekly` selecionado sem
  nenhum dia marcado — fica local e **não** é emitido para `onConfigChange`.
  Emitir produziria um `schedule` inválido no `trigger_config` a cada clique
  intermediário do usuário.
- **Re-semear só quando o valor externo for de fato outro.** O componente
  guarda o último cron que ele mesmo emitiu; ao receber `props.value`, só
  reinterpreta se for diferente desse último. Sem essa guarda,
  `parse → render → serialize → onChange → props.value` fecha um laço que, na
  melhor hipótese, faz o cursor pular; na pior, normaliza a expressão do
  usuário a cada tecla — violando o invariante 2 na prática, com os testes
  todos passando.

---

## 5. Interface: `VisualCronBuilder`

### 5.1 Arquitetura do componente

Novo arquivo `src/components/automations/visual-cron-builder.tsx`, client
component.

Contrato, no molde de `SessionWindowMarginConfig`
([automation-builder.tsx:1053](../src/components/automations/automation-builder.tsx#L1053)) —
que é o precedente da casa para "sub-componente de configuração de gatilho com
conversão de unidade":

```tsx
function VisualCronBuilder({
  config,      // Record<string, unknown> — o trigger_config inteiro
  onChange,    // (c: Record<string, unknown>) => void
  t,           // ReturnType<typeof useTranslations>, prop-drillado
}: …)
```

Recebe o `config` inteiro (e não só `schedule`) porque também escreve
`timezone` e `audience_tag_id` — e escrever os três num `onChange` só evita
três renders e três estados intermediários inconsistentes.

**Não** chama `useTranslations` internamente: o `t` desce por prop, como todo
o resto do arquivo faz (§2.7).

Integração: o bloco `{type === 'time_based' && (…)}` em `TriggerCard`
(`:1010-1027`) passa a renderizar `<VisualCronBuilder />`. Fora isso e a
limpeza de §5.5, `automation-builder.tsx` não muda.

Por que um arquivo novo em vez de mais uma função dentro do builder: o arquivo
já tem ~1.700 linhas e este componente traz cinco modos, pré-visualização e
validação. `visual-cron-builder.tsx` é a primeira quebra natural desse
arquivo, e o `TriggerCard` continua legível.

### 5.2 Layout (coluna de 320 px)

```
┌──────────────────────────────────────┐
│ Programação                          │
│ ┌──────┬───────┬────────┬─────────┐  │   ← pílulas de frequência
│ │Inter.│Diário │Semanal │ Mensal  │  │
│ └──────┴───────┴────────┴─────────┘  │
│                          Avançado ⚙  │   ← link discreto, 5º modo
│                                      │
│ ┌── controles do modo ────────────┐  │
│ │  D  S  T  Q  Q  S  S            │  │   ← 7 pílulas (modo semanal)
│ │  ○  ●  ○  ●  ○  ○  ○            │  │
│ │  às  [ 09:00 ]                  │  │
│ └─────────────────────────────────┘  │
│                                      │
│ ┌── resumo ───────────────────────┐  │
│ │ 🕘 Toda segunda e quarta às 09:00│ │   ← describeSchedule()
│ │    Próximos: seg 11/08 09:00 ·   │  │   ← nextOccurrences()
│ │              qua 13/08 09:00     │  │
│ │    Horário de São Paulo · alterar│  │
│ └─────────────────────────────────┘  │
│                                      │
│ Enviar para                          │
│ [ Etiqueta: Clientes VIP        ▾ ]  │   ← TagSelect existente
└──────────────────────────────────────┘
```

**1. Pílulas de frequência.** Quatro modos visíveis; `advanced` é um link
discreto, não uma quinta pílula — é escape, não escolha de igual peso. Como
não existe `toggle-group` (§2.6), usar `Button` com `variant` alternado, como
[step4-schedule-send.tsx:340](../src/components/broadcasts/step4-schedule-send.tsx#L340).
Nenhuma dependência nova, nenhum componente `ui/` novo.

**2. Controles por modo.**

- `interval` — um `Select` único com os nove intervalos de §3.3, rotulados por
  extenso ("a cada 15 minutos"). Um só controle, sem número + unidade
  separados: com nove opções, a lista fechada é mais rápida e não deixa
  digitar "1".
- `daily` — `<input type="time">` nativo. Traz teclado numérico no celular,
  formatação por locale e acessibilidade de graça; nenhum seletor customizado
  ganha dele aqui.
- `weekly` — 7 pílulas `D S T Q Q S S` (rótulos do i18n, não derivados do
  código: em inglês são `S M T W T F S`), multi-seleção, mais o mesmo
  `<input type="time">`. Atalhos "Dias úteis" e "Todos os dias" ao lado —
  cobrem a maioria dos casos com um clique e ensinam o que as pílulas fazem.
- `monthly` — `Select` de dia do mês (1–31) mais o horário.
- `advanced` — o `Input` de hoje, com `schedulePlaceholder`/`scheduleHint`
  como estão, mais validação ao vivo por `validateSchedule` (§5.4).

**3. Resumo.** É a peça que justifica a feature inteira: uma frase em
português mais os próximos disparos concretos. É onde o usuário confere que
entendeu o que configurou, e é o que torna o modo avançado seguro para quem
não domina cron — cola uma expressão, lê a frase, confirma.

**4. Fuso.** Linha discreta com o fuso resolvido em nome legível e uma ação
"alterar" que abre um `Select` (fusos brasileiros primeiro, depois a lista
`Intl.supportedValuesOf('timeZone')`). Escondido por padrão porque, no caso
comum, o fuso do navegador está certo e um seletor obrigatório num card de
320 px é atrito puro.

**5. Audiência.** `TagSelect`
([automation-builder.tsx:371](../src/components/automations/automation-builder.tsx#L371)),
que já resolve carregamento e estado das etiquetas via `ResourcesProvider`.

### 5.3 Resumo em linguagem natural

`describeSchedule(state, t)` monta a frase de fragmentos i18n em vez de
concatenar strings — porque a ordem dos elementos muda entre pt-BR e en, e
porque plural e conectivo ("segunda **e** quarta" vs. "Monday **and**
Wednesday", "segunda, quarta **e** sexta") não sobrevivem a concatenação.

Casos especiais que valem regra própria, por serem os mais frequentes:

| Estado                            | pt-BR                                    |
| --------------------------------- | ---------------------------------------- |
| `weekly` com 1,2,3,4,5            | "Todo dia útil às 09:00"                 |
| `weekly` com 0,6                  | "Todo fim de semana às 09:00"            |
| `weekly` com os 7                 | "Todo dia às 09:00" (idêntico a `daily`) |
| `monthly` dia 1                   | "Todo dia 1º do mês às 09:00"            |
| `advanced` que casa com um preset | descreve o preset                        |
| `advanced` fora do modelo         | "Agendamento personalizado: `<cron>`"    |

### 5.4 Validação e avisos

`validateSchedule` é a única porta — a mesma função valida a digitação no modo
avançado e a ativação em `validate.ts` (§6.5). Duas portas divergem, e a
divergência aparece como "salvou mas não ativa", que é o pior lugar para
descobrir.

Avisos (não bloqueiam o salvamento):

- **Dia 29, 30 ou 31** — "Meses mais curtos serão pulados." Fevereiro não tem
  30, e o usuário que escolheu 31 quase sempre queria "todo fim de mês".
- **Intervalo curto com audiência grande** — "Este agendamento pode enviar
  N mensagens por dia para cada contato da etiqueta." O produto envia mensagens
  pagas para clientes reais; a conta precisa estar na tela antes do clique, não
  na fatura.
- **Fuso diferente do padrão** — quando o navegador reporta algo fora do
  Brasil, mostrar o fuso resolvido por extenso em vez de escondê-lo.

### 5.5 Limpeza de config órfã (§2.8)

`onTypeChange` em `TriggerCard` passa a resetar `trigger_config` para o padrão
do tipo novo, em vez de manter o anterior. Um mapa
`DEFAULT_TRIGGER_CONFIG: Record<AutomationTriggerType, Record<string, unknown>>`
ao lado de `TRIGGER_OPTIONS` (`:178`) resolve, e serve de documentação do que
cada gatilho espera.

Comportamento na edição de automação existente: o reset só dispara na **troca
de tipo pelo usuário**, nunca na carga inicial — trocar de tipo é uma decisão
explícita de descartar a configuração anterior; abrir para editar não é.

### 5.6 Estado do componente

```
props.value (cron)  ──parseSchedule──►  ScheduleState local
                                              │
                                    usuário interage
                                              │
                                              ▼
                                    scheduleToCron ──► válido? ──► onChange
                                                          │
                                                          └─ não ─► só estado local
```

Um `useRef` guarda o último cron emitido; o efeito que re-semeia a partir de
`props.value` compara contra ele e não faz nada quando são iguais (§4.4).

---

## 6. Runtime: execução do gatilho

### 6.1 Onde a varredura mora

Dentro de `/api/automations/cron`, como **fase 3**, em `after()`, ao lado da
varredura de janela.

O argumento é o da SPEC 045 §5.5.1 e vale aqui sem alteração: o agendamento
não é código, é configuração de ambiente em
[cron-jobs.sql](../supabase/setup/cron-jobs.sql), que o operador preenche, roda
e descarta. Uma rota nova significaria um quarto `cron.schedule` e, portanto,
uma **ação manual de todo operador já em produção, incluindo forks**. Quem não
fizesse essa ação teria a feature aparecendo na UI, salvando, ativando — e
nunca disparando, sem erro em lugar nenhum. É exatamente o modo de falha que
esta SPEC existe para corrigir; reintroduzi-lo pela porta dos fundos seria
irônico e caro.

A rota já declara `maxDuration = 300` (`:45`), pelo trabalho pesado que a
fase 2 pendurou nela. A fase 3 divide esse mesmo teto — o que reforça o teto
por tick de §6.4.

### 6.2 `src/lib/automations/schedule-scan.ts` (novo)

Espelha [window-scan.ts](../src/lib/automations/window-scan.ts) em estrutura e
em espírito.

**Fase A — automações primeiro.** Uma query: `automations` com
`trigger_type = 'time_based'` e `is_active = true`, global por tipo (o índice
`idx_automations_active_trigger` já existe). Uma instância sem nenhuma
automação agendada faz **uma** query por tick e vai embora. A ordem inversa
(varrer contatos e depois perguntar quem se importa) cresce com o total de
contatos de todas as contas do deploy.

**Fase B — devidas.** Para cada automação: resolver o fuso
(`resolveTimeZone(config.timezone)`, caindo em `DEFAULT_TIME_ZONE`) e
determinar as ocorrências de `schedule` que caem na janela do tick.

**Determinação de ocorrência devida** — a decisão de design mais delicada
aqui. Não usar "cronMatches(now)": `now` é o instante em que a requisição
chegou, e o `pg_net` não garante pontualidade; `cronMatches` num único
instante erra o alvo sempre que o tick atrasa alguns segundos.

Em vez disso, **enumerar os minutos da janela** `(now − TICK_WINDOW, now]` e
testar cada um com `cronMatches`. Com `TICK_WINDOW = 10 min` (dois ticks,
para tolerar um tick perdido) são no máximo 10 avaliações por automação —
irrelevante em custo. Cada minuto que casa é uma **ocorrência**, identificada
pelo seu instante truncado ao minuto em UTC. É esse instante que vai para a
chave de idempotência, e é ele — não `now` — que torna a coisa correta: dois
ticks sobrepostos enxergam a **mesma** ocorrência e disputam o mesmo claim,
em vez de criarem dois.

Ocorrências antigas demais (fora da janela) são simplesmente perdidas. É a
escolha certa: disparar às 11h um agendamento das 9h porque o cron ficou fora
do ar é pior que não disparar — o conteúdo de "bom dia" chega errado e o
usuário não pediu recuperação.

**Fase C — audiência.** Contatos da conta com a etiqueta configurada, com os
guardrails de §6.4 e o teto por tick.

### 6.3 Idempotência: migração `054_automation_schedule_claims.sql`

Modelada em `automation_window_claims`
([052:68-83](../supabase/migrations/052_session_window_reengagement.sql#L68-L83)) —
mesmo desenho, mesmo motivo, mesmas colunas de desfecho.

```sql
CREATE TABLE IF NOT EXISTS automation_schedule_claims (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id)    ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id)    ON DELETE CASCADE,
  -- Instante da ocorrência agendada, truncado ao minuto, em UTC.
  -- É o análogo do window_anchor: a chave que distingue "esta execução
  -- das 9h de hoje" de "a das 9h de amanhã".
  occurrence_at TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_schedule_claims_unique_claim
    UNIQUE (automation_id, contact_id, occurrence_at)
);

CREATE INDEX IF NOT EXISTS idx_automation_schedule_claims_purge
  ON automation_schedule_claims(created_at);

ALTER TABLE automation_schedule_claims ENABLE ROW LEVEL SECURITY;
```

O `ENABLE ROW LEVEL SECURITY` **sem policy nenhuma** não é descuido: é o que
nega acesso a `anon`/`authenticated` por padrão e deixa passar só o
service-role. Mesmo par (`ENABLE` + zero policy + índice de purga) da
[052:85-89](../supabase/migrations/052_session_window_reengagement.sql#L85-L89).

O `INSERT … ON CONFLICT DO NOTHING RETURNING id` **é** o lock: `RETURNING`
vazio significa "outro tick já pegou". Um `SELECT` seguido de `INSERT` não é
atômico e dois pings sobrepostos leriam "ainda não disparou" antes de qualquer
um gravar — o cliente receberia a mensagem duas vezes.

Sem policy: acesso exclusivamente por service-role, mesmo padrão de
`automation_pending_executions` e de `automation_window_claims`. Idempotente
(`IF NOT EXISTS`), como todas as migrações do repo. Limpeza pela mesma
retenção de 30 dias já usada na varredura de janela.

### 6.4 Guardrails obrigatórios

Nenhum é novo — todos existem e só precisam ser chamados.

| #   | Guardrail                 | Como                                                                                                 | Por quê                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Janela de horário**     | `isWithinSendWindow(now, tz)` antes da fase B                                                        | Um agendamento mal configurado às 4h da manhã queima reputação, e reputação governa o tier da Meta. Diferente do disparo, aqui **não** há "adiar": a próxima ocorrência vem sozinha.                                                                                                                                                                       |
| 2   | **Opt-out (LGPD)**        | `isOptedOut(contact)` por contato; `excludesOptedOut(category)` para o que for template de marketing | Já é o guardrail da varredura de janela e dos disparos.                                                                                                                                                                                                                                                                                                    |
| 3   | **Teto por tick**         | `MAX_CONTACTS_PER_AUTOMATION = 50`, no espírito do teto de `window-scan.ts:74`                       | O excedente entra no tick seguinte. Sem teto, uma etiqueta com 5.000 contatos prende o cron e estoura o `maxDuration` no meio de um envio.                                                                                                                                                                                                                 |
| 4   | **Uma automação por vez** | `runSingleAutomation(automation, {accountId, contactId, context})`                                   | **Nunca `runAutomationsForTrigger`.** O aviso em [engine.ts:140-155](../src/lib/automations/engine.ts#L140-L155) se aplica literalmente: aquela função roda **todas** as automações do tipo na conta, e o loop aqui é por automação — a combinação produz N² execuções e mensagens duplicadas, **com a tabela de claims registrando que está tudo certo**. |
| 5   | **Isolamento de tenant**  | contatos vêm de query já escopada por `account_id`                                                   | `runSingleAutomation` não checa posse (o comentário em `:147-151` diz que é responsabilidade do chamador).                                                                                                                                                                                                                                                 |

### 6.5 Validação na ativação

[validate.ts:241-247](../src/lib/automations/validate.ts#L241-L247) sobe de
"não vazio" para:

```
- schedule presente E validateSchedule(schedule) === null
- audience_tag_id presente
```

Mensagens no mesmo formato `{ path, message }` das demais.

**Compatibilidade com linhas existentes:** `validate.ts` roda na ativação, não
na leitura. Uma automação já ativa com `schedule` que não passa na validação
nova continua no banco e **não dispara** (o `cronMatches` não casa com lixo);
ela só é barrada na próxima vez que o autor mexer nela — que é quando ele vê a
mensagem e conserta. Nenhum deploy desativa automação de ninguém em silêncio.

Como hoje **nada** dispara `time_based`, não existe automação agendada
funcionando em produção para quebrar. É a janela mais barata possível para
apertar essa validação.

---

## 7. Fluxo end-to-end

1. Usuário abre uma automação, escolhe o gatilho "Baseado em horário".
2. Vê o padrão já preenchido — "Todo dia às 09:00" — em vez de um campo vazio
   com jargão. `trigger_config.schedule = '0 9 * * *'`.
3. Clica em **Semanal**, marca **Seg** e **Qua**, ajusta para `09:30`. O
   resumo vira "Toda segunda e quarta às 09:30" e lista os próximos dois
   disparos com data. Bastidores: `schedule = '30 9 * * 1,3'`,
   `timezone = 'America/Sao_Paulo'`.
4. Escolhe a etiqueta **Clientes VIP** na audiência.
5. Adiciona um step `send_template`, salva e ativa. `validate.ts` aprova.
6. Segunda-feira, 09:30. O tick das 09:30 chega às 09:31:12. A fase 3 enumera
   os minutos de 09:21 a 09:31, encontra que 09:30 casa, e materializa a
   ocorrência `2026-08-10T12:30:00Z`.
7. `isWithinSendWindow` aprova (09:30 é dia útil dentro de 09:00–20:00).
8. Para cada um dos 34 contatos com a etiqueta, não optados-out: um
   `INSERT … ON CONFLICT DO NOTHING`. Todos os 34 ganham o claim.
9. `runSingleAutomation` por contato. Sucesso marca `sent_at`; falha marca
   `failed_at` e o log de automação registra o erro.
10. O tick das 09:35 chega e enumera 09:25–09:35 — encontra 09:30 de novo, a
    mesma ocorrência. Os 34 `INSERT` voltam com `RETURNING` vazio. **Nada é
    enviado duas vezes.**

---

## 8. Riscos e mitigação

| Risco                                                               | Mitigação                                                                                                                                                 |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A UI reescreve um cron que o usuário sabia o que estava fazendo** | Invariante 2 de §4.3, com teste dedicado. É o risco mais grave da metade de UI: falha em silêncio e só aparece quando a automação dispara na hora errada. |
| **Laço parse↔serialize**                                            | Guarda de `useRef` em §4.4/§5.6. Sintoma clássico: cursor pulando no modo avançado.                                                                       |
| **Fuso errado → disparo na hora errada**                            | Toda a aritmética passa por `zonedParts`/`zonedWallTimeToUtc`, já testados no módulo de disparos. Testes de §4.3 item 4 cobrem um fuso com DST.           |
| **Envio duplicado**                                                 | O claim é o lock (§6.3), e a chave é a **ocorrência**, não `now`. Gate de runtime em §11.2.                                                               |
| **N² de execuções**                                                 | Guardrail 4 de §6.4. Já aconteceu neste repositório (SPEC 045, achado nº 1) — o modo de falha é uma tabela de claims que mostra tudo certo.               |
| **Um agendamento vira um disparo em massa não intencional**         | Teto por tick, opt-out, janela de horário, e o aviso de volume em §5.4 antes do salvamento. Ver §10.                                                      |
| **`maxDuration` estourado com três fases na mesma rota**            | Teto de 50 contatos por automação por tick; o excedente entra no tick seguinte, sem perder ocorrência (o claim já está criado).                           |

---

## 9. Plano de implementação em fases

| Fase | Entrega                                                                                                                        | Depende de  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1    | `schedule.ts` + `schedule.test.ts` (puro, sem UI, sem banco) — as seis funções de §4.2 e os cinco invariantes de §4.3          | —           |
| 2    | `visual-cron-builder.tsx` + chaves i18n nos dois dicionários + troca do bloco em `TriggerCard` + limpeza de config órfã (§5.5) | Fase 1      |
| 3    | Audiência por etiqueta na UI + `validate.ts` (§6.5)                                                                            | Fase 2      |
| 4    | Migração 054 + `schedule-scan.ts` + fase 3 em `/api/automations/cron`                                                          | Fases 1 e 3 |
| 5    | Nota no README + fechamento do débito técnico registrado na SPEC 045 §4                                                        | Fase 4      |

**Ordem de risco.** As fases 2 e 3 entregam UI para um gatilho que ainda não
dispara — o mesmo estado de hoje, mas com uma interface que convida ao uso.
Duas saídas aceitáveis, à escolha na hora do merge:

- Mergear 2 e 3 atrás de um aviso na UI ("este agendamento passa a valer
  no próximo deploy"), removido pela fase 4; **ou**
- segurar 2–3 e mergear 2, 3 e 4 juntas.

O que **não** é aceitável é mergear 2 sem uma das duas. A fase 1 pode ir
sozinha a qualquer momento: é código puro, sem nenhum leitor ainda.

---

## 10. Fora de escopo (explicitamente)

- **Granularidade por segundo** e o sexto campo cron. O tick é de 5 min (§3.3).
- **Extensões não-padrão**: `L` (último dia do mês), `W`, `#` (n-ésima
  ocorrência do dia da semana), `?`. Nomes textuais (`MON`, `JAN`) também
  não — `describeSchedule` os traduz, mas `cronMatches` não os aceita.
- **Calendário de feriados** e exceções por data ("todo dia útil, exceto
  feriados nacionais"). Pedido legítimo e recorrente; exige uma fonte de
  feriados brasileiros e um modelo de exceções — SPEC própria.
- **Migrar `broadcasts` para este construtor.** O agendamento de disparo é
  pontual (uma data), não recorrente; compartilham o fuso, não a UI.
- **Fuso por conta em `whatsapp_config`.** Continua sendo o lugar certo se um
  dia for preciso (como o comentário de
  [window-scan.ts:126-130](../src/lib/automations/window-scan.ts#L126-L130) já
  registra), mas o fuso desta SPEC é o de quem agendou.

---

## 11. Testes e rollout

### 11.1 Testes

**Unitários** (`schedule.test.ts`, vitest — os cinco invariantes de §4.3 são a
espinha dorsal). Acrescentar:

- `cronMatches` com dia-do-mês **e** dia-da-semana restritos → regra do OU.
- `nextOccurrences` com `0 0 29 2 *` (acha, dentro de 366 dias) e
  `0 0 30 2 *` (devolve vazio, não trava).
- `describeSchedule` cobrindo os seis casos especiais da §5.3, nas duas
  línguas.

**De componente**, se o projeto adotar testes de render (não há precedente
hoje em `src/components/`): o laço de §4.4 — montar com um cron do modo
avançado, não interagir, e afirmar que `onChange` **não** foi chamado.

**Da varredura** (`schedule-scan.test.ts`, no molde de
`window-trigger.test.ts`): a determinação de ocorrência devida com tick
pontual, tick atrasado 4 min e tick perdido.

**Manual**, com `npm run dev`:

1. Abrir uma automação `time_based` existente, se houver, e confirmar que o
   valor salvo aparece intacto.
2. Colar `0 8 * * 1#2` no modo avançado, salvar, reabrir — a expressão volta
   idêntica, com o aviso de gramática não suportada.
3. Percorrer os quatro modos e conferir resumo e próximos disparos contra o
   relógio.
4. Trocar o gatilho para `keyword_match` e voltar — confirmar que
   `trigger_config` não carrega chaves órfãs (§5.5).

**Portões de build:** `npm run typecheck`, `npm test`, `npm run i18n:check`,
`npm run lint`.

### 11.2 Rollout

- Fase 4 exige a migração 054 aplicada **antes** do deploy do código — o
  `INSERT` do claim referencia a tabela.
- **Gate de runtime**, depois do merge da fase 4 e antes de considerar a
  feature entregue: criar uma automação agendada para dali a 2 minutos, com
  uma etiqueta de dois contatos de teste, e disparar **dois `curl` simultâneos**
  contra `/api/automations/cron` com o `x-cron-secret`. Confirmar em `messages`
  que saíram exatamente dois envios, não quatro. É o mesmo gate da SPEC 045
  §11.2, e pela mesma razão: é o único teste que exercita o claim sob
  concorrência real.
- Não há flag de feature. O gatilho já aparece no dropdown; o que muda é ele
  passar a funcionar.

---

## 12. Modelo (LLM) e estratégia de sessões

| #   | Unidade                                                   | Escreve        | Revisa                                                    | Leitura obrigatória antes de começar                                                                                                        |
| --- | --------------------------------------------------------- | -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Esta SPEC                                                 | Opus 5 (feito) | —                                                         | —                                                                                                                                           |
| 1   | `schedule.ts` + testes                                    | Sonnet 5       | —                                                         | `send-window.ts` inteiro (é de onde vem `zonedParts`/`zonedWallTimeToUtc`, e reimplementá-los seria o erro mais provável desta unidade)     |
| 2   | `visual-cron-builder.tsx` + i18n + troca no `TriggerCard` | Sonnet 5       | Opus 5 — **checkpoint no laço de §4.4**                   | `TriggerCard` e `SessionWindowMarginConfig` inteiros; `step4-schedule-send.tsx` (molde das pílulas)                                         |
| 3   | Audiência + `validate.ts`                                 | Sonnet 5       | —                                                         | `TagSelect` + `ResourcesProvider`; `validate.ts` inteiro                                                                                    |
| 4   | Migração 054 + `schedule-scan.ts` + fase 3 na rota        | Sonnet 5       | **Opus 5 — obrigatório, antes de qualquer ambiente real** | `window-scan.ts` **inteiro**, `runSingleAutomation` + o aviso de `engine.ts:140-155`, migração 052, `api/automations/cron/route.ts` inteiro |
| 5   | README + fechamento do débito                             | Haiku 4.5      | —                                                         | —                                                                                                                                           |

**Por que Opus só em dois pontos.** A unidade 2 tem um modo de falha que passa
por todos os testes unitários (o laço parse↔serialize só aparece em interação
real) e a unidade 4 tem dois que só aparecem em produção semanas depois (o N²
de execuções e a duplicação sob ticks sobrepostos). São erros de **composição
entre arquivos**, não de lógica dentro de um arquivo — o tipo que a 2ª revisão
da SPEC 045 documentou como invisível numa revisão de diff. Por isso a coluna
de leitura obrigatória existe: uma revisão da unidade 4 que não carregou
`engine.ts:140-155` reproduz o ponto cego independentemente do modelo.

**Por que nada aqui é Haiku, exceto a unidade 5.** Todas as outras tocam
isolamento de tenant, idempotência ou aritmética de fuso.

**Paralelização.** As unidades 1 e 5 são as únicas destacáveis. As unidades 2 e
3 tocam o mesmo arquivo e devem ficar na mesma sessão; a 4 depende de ter lido
a 1 e a 3.
