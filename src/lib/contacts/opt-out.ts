/**
 * Detecção de opt-out por palavra-chave no inbound (SPEC 044 §6.8).
 *
 * O que este módulo decide
 *
 *   Se uma mensagem recebida É um pedido de descadastro. Nada mais: quem
 *   grava o estado e a trilha é `set_contact_opt_in` (migração 048), e
 *   quem chama é o webhook.
 *
 * Por que o casamento é EXATO e não por "contém"
 *
 *   "Não vou parar de comprar com vocês" contém "parar". Um match por
 *   substring transformaria um elogio em descadastro — e o erro é
 *   silencioso e caro nas duas direções: o cliente para de receber sem
 *   ter pedido, e o operador perde uma pessoa engajada sem nunca saber
 *   por quê. Por isso a regra é: a mensagem INTEIRA, normalizada, tem
 *   que ser uma das frases da lista.
 *
 *   O custo dessa escolha é reconhecido: "sair dessa lista por favor"
 *   não casa. A saída para isso não é afrouxar o predicado — é
 *   acrescentar a frase à lista quando ela aparecer de verdade nos
 *   dados. Um falso negativo é um contato que o agente descadastra à
 *   mão; um falso positivo é um cliente perdido em silêncio.
 *
 * Normalização
 *
 *   Minúsculas, sem acento, sem pontuação, espaços colapsados. É o que
 *   faz "SAIR!", "sair" e "Sair." serem a mesma coisa — e "não" e "nao"
 *   também, que é como metade dos clientes digita no celular.
 */

/**
 * Frases que significam "me tire da lista", já normalizadas.
 *
 * Ordem irrelevante (a busca é por igualdade). Acrescentar variantes
 * aqui é o caminho previsto para melhorar a cobertura — ver a nota do
 * cabeçalho sobre por que não se afrouxa o predicado.
 */
export const OPT_OUT_KEYWORDS: readonly string[] = [
  // Pedidos diretos
  'sair',
  'sair da lista',
  'quero sair',
  'quero sair da lista',
  'parar',
  'pare',
  'parar de receber',
  'pare de enviar',
  'pare de me enviar mensagens',
  // Descadastro
  'descadastrar',
  'descadastre',
  'me descadastre',
  'me descadastrar',
  'cancelar',
  'cancele',
  'cancelar inscricao',
  'cancelar recebimento',
  // Remoção
  'remover',
  'remova',
  'me remova',
  'me remova da lista',
  // Recusa explícita
  'nao quero mais',
  'nao quero receber',
  'nao quero mais receber',
  'nao quero mais receber mensagens',
  'nao me envie mais mensagens',
  // Inglês — aparece em base internacional e é o padrão da Meta
  'stop',
  'unsubscribe',
  'opt out',
  'optout',
  'remove me',
];

/**
 * Teto de caracteres antes de sequer normalizar.
 *
 * Um pedido de descadastro é curto. Ignorar mensagens longas evita
 * gastar trabalho em cada inbound de conversa normal e, principalmente,
 * evita que uma frase longa que POR ACASO normalize para uma
 * palavra-chave (só pontuação e uma palavra, por exemplo) escape da
 * regra do casamento exato.
 */
const MAX_LENGTH = 60;

/** Minúsculas, sem acento, sem pontuação, espaços colapsados. */
export function normalizeInbound(text: string): string {
  return (
    text
      .normalize('NFD')
      // Remove os diacríticos que o NFD separou das letras.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Pontuação vira espaço (e não vazio): "sair,agora" não deve
      // colapsar em "sairagora".
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/**
 * A palavra-chave que a mensagem casou, ou `null` quando não é um
 * pedido de descadastro.
 *
 * Devolve a frase NORMALIZADA, não o texto original: é ela que vai para
 * `contact_consent_events.keyword`, e a trilha precisa de um valor
 * comparável entre registros — não de "SAIR!!!" numa linha e "Sair" em
 * outra.
 */
export function detectOptOut(text: string | null | undefined): string | null {
  if (!text) return null;
  if (text.length > MAX_LENGTH) return null;

  const normalized = normalizeInbound(text);
  if (!normalized) return null;

  return OPT_OUT_KEYWORDS.includes(normalized) ? normalized : null;
}
