/**
 * Menu degradado — o PAR de tradução de um flow em canal sem botão
 * (SPEC 049 §5.2, correção do PRD 047 §10.1).
 *
 * Por que isto é um par, e não um formatador
 *
 *   O PRD descreveu só metade: "botão degrada para texto numerado". Só
 *   que quem suspende o run é o próprio nó `send_buttons`/`send_list`, e
 *   o resume só casa `interactive_reply` (`matchReplyId`). Degradar
 *   apenas a SAÍDA produz este roteiro: o cliente recebe `1️⃣ 2️⃣ 3️⃣`,
 *   digita `2`, a mensagem chega como `kind: 'text'`, nenhum ramo casa,
 *   o run cai na política de fallback e REENVIA o mesmo menu até
 *   estourar `reprompt_count`. Um bot que pergunta três vezes e desiste,
 *   sem uma linha de erro em lugar nenhum.
 *
 *   Por isso o tradutor de saída (`renderDegradedMenu`) e o casador de
 *   entrada (`matchDegradedReply`) vivem no MESMO módulo, leem a MESMA
 *   ordem de opções (`menuOptionsOf`) e são testados juntos: a
 *   numeração que o cliente vê é, por construção, a numeração que o
 *   matcher conta.
 *
 * Módulo puro, de propósito
 *
 *   Nada aqui toca banco, canal ou run. Quem decide *se* degrada é o
 *   motor, lendo a matriz de capacidades do canal da conversa (D-2:
 *   derivar na hora, sem coluna nova — a pergunta "este canal renderiza
 *   botão?" tem uma resposta só, e é a mesma que decidiu a degradação no
 *   envio; não há como divergirem porque são a mesma leitura).
 *
 * A degradação NUNCA inventa opção
 *
 *   Toda regra ambígua devolve `null`, e `null` cai na política de
 *   fallback de sempre (reprompt/handoff/ignore). Mandar o cliente para
 *   o ramo errado é pior que perguntar de novo: o reprompt ele
 *   desempata digitando o número; o ramo errado ele descobre no fim do
 *   atendimento.
 */

import type { SendButtonsNodeConfig, SendListNodeConfig } from './types';

/** Uma opção do menu, já achatada e na ordem em que o cliente a vê. */
export interface MenuOption {
  reply_id: string;
  title: string;
  next_node_key: string;
}

/** O que este módulo aceita: o nó cru, como vem de `flow_nodes`. */
export interface MenuNode {
  node_type: string;
  config: Record<string, unknown>;
}

/**
 * Opções na ORDEM EXIBIDA — a mesma que numera a saída e que o matcher
 * conta.
 *
 * `send_buttons`: a ordem de `cfg.buttons`.
 * `send_list`: as linhas das seções, achatadas na ordem em que as seções
 * aparecem. O título da seção não vira opção: ele não tem
 * `next_node_key` e o cliente não pode "escolher a seção".
 */
export function menuOptionsOf(node: MenuNode): MenuOption[] {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return (cfg.buttons ?? []).map((b) => ({
      reply_id: b.reply_id,
      title: b.title,
      next_node_key: b.next_node_key,
    }));
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    const out: MenuOption[] = [];
    for (const section of cfg.sections ?? []) {
      for (const row of section.rows ?? []) {
        out.push({
          reply_id: row.reply_id,
          title: row.title,
          next_node_key: row.next_node_key,
        });
      }
    }
    return out;
  }
  return [];
}

/**
 * Emoji de teclado numérico até 10 (o teto de linhas da Meta num
 * `send_list`; botões param em 3). Acima disso o marcador vira `11.` —
 * feio, mas legível, e o matcher aceita os dois.
 */
const KEYCAPS = [
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
  '6️⃣',
  '7️⃣',
  '8️⃣',
  '9️⃣',
  '\u{1F51F}',
];

/** Marcador da n-ésima opção (0-based na entrada, 1-based na tela). */
export function optionMarker(index: number): string {
  return KEYCAPS[index] ?? `${index + 1}.`;
}

/**
 * O texto que substitui o menu nativo.
 *
 * ```
 * Atendimento            ← header_text
 *
 * Como posso ajudar?     ← text (corpo)
 *
 * 1️⃣ Falar com vendas
 * 2️⃣ Segunda via de boleto
 *
 * Responda com o número  ← footer_text
 * ```
 *
 * `button_label` do `send_list` é descartado de propósito: ele rotula um
 * botão "ver opções" que não existe quando as opções já estão na tela.
 *
 * ⚠️ NÃO interpola `{{vars.x}}`. O caminho nativo
 * (`engineSendInteractiveButtons`) também não interpola, e o objetivo da
 * degradação é trocar o TRANSPORTE, não o conteúdo — um menu que
 * interpola só num dos canais é uma diferença que o autor do flow não
 * pediu e não veria.
 *
 * Devolve `null` quando não há opção alguma: sem opção não há menu, e
 * mandar só o corpo criaria uma pergunta sem resposta possível.
 */
export function renderDegradedMenu(node: MenuNode): string | null {
  const options = menuOptionsOf(node);
  if (options.length === 0) return null;

  const cfg = node.config as {
    text?: string;
    header_text?: string;
    footer_text?: string;
  };

  const blocks: string[] = [];
  const header = cfg.header_text?.trim();
  if (header) blocks.push(header);
  const body = cfg.text?.trim();
  if (body) blocks.push(body);
  blocks.push(
    options.map((o, i) => `${optionMarker(i)} ${o.title}`).join('\n')
  );
  const footer = cfg.footer_text?.trim();
  if (footer) blocks.push(footer);

  return blocks.join('\n\n');
}

/**
 * Caixa e acento fora; espaço colapsado. É a normalização das regras 3 e
 * 4 — "Segunda via de boleto", "segunda via de boleto" e
 * "SEGUNDA  VIA DE BOLETO" são a mesma escolha para quem digitou.
 */
function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Regras 1 e 2 da §5.2 — índice digitado e emoji de teclado numérico.
 *
 * São um caminho só porque não podem discordar: `2️⃣` é o dígito `2` com
 * dois modificadores (VS16 + combining keycap). Removê-los reduz o
 * emoji ao número que o cliente quis dizer.
 *
 * Pontuação de fim (`2.`, `2)`, `2 -`) é tolerada: quem responde
 * numerado costuma copiar a pontuação da lista.
 */
function parseOptionIndex(text: string): number | null {
  const digits = text
    .replace(/[\uFE0F\u20E3]/g, '')
    .replace(/\u{1F51F}/gu, '10')
    .replace(/[.)\]\u2013\u2014-]+$/, '')
    .trim();
  if (!/^\d{1,2}$/.test(digits)) return null;
  return Number(digits);
}

/**
 * A resposta em TEXTO casou com alguma opção do menu degradado?
 *
 * Devolve o `next_node_key` da opção, ou `null` para "nada casou" — que
 * o motor trata com a política de fallback de sempre.
 *
 * Ordem das regras (§5.2), da mais literal para a mais generosa:
 *
 *   1. Índice 1-based na ordem exibida — `"2"`
 *   2. Emoji de teclado numérico — `"2️⃣"`
 *   3. Rótulo exato, sem caixa e sem acento — `"segunda via de boleto"`
 *   4. Rótulo por PREFIXO, se inequívoco — `"segunda"` → item 2
 *   5. Nada casou → `null`
 *
 * A regra 4 é a única com risco, e é onde o "inequívoco" trabalha: um
 * menu com "Vendas" e "Vendas corporativas" não pode mandar o cliente
 * para o lugar errado porque ele digitou "vendas". Dois acertos = zero
 * acerto.
 *
 * A regra 3 exige a mesma unicidade, pelo mesmo motivo: dois rótulos
 * idênticos apontando para nós diferentes são uma ambiguidade do flow,
 * não uma escolha do cliente.
 */
export function matchDegradedReply(
  node: MenuNode,
  text: string
): string | null {
  const options = menuOptionsOf(node);
  if (options.length === 0) return null;

  const raw = text.trim();
  if (!raw) return null;

  // Regras 1 e 2 — índice / emoji numérico.
  const index = parseOptionIndex(raw);
  if (index !== null && index >= 1 && index <= options.length) {
    return options[index - 1].next_node_key;
  }

  const needle = normalizeLabel(raw);
  if (!needle) return null;

  // Regra 3 — rótulo exato.
  const exact = options.filter((o) => normalizeLabel(o.title) === needle);
  if (exact.length === 1) return exact[0].next_node_key;
  if (exact.length > 1) return null;

  // Regra 4 — prefixo inequívoco.
  const prefix = options.filter((o) =>
    normalizeLabel(o.title).startsWith(needle)
  );
  if (prefix.length === 1) return prefix[0].next_node_key;

  // Regra 5.
  return null;
}
