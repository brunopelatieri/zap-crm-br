// ============================================================
// Emojis recentes por usuário — lista MRU em `localStorage`.
//
// O Frimousse não tem "frequentes/recentes"; esta é a camada que o
// ZAP CRM BR acrescenta. No uso real de atendimento uma minoria
// pequena de emojis cobre a esmagadora maioria dos envios
// (👍 ✅ 😊 🙏 ⏰), e a diferença entre um clique e "abrir + buscar +
// clicar" se multiplica por centenas de mensagens por dia.
//
// Por que não no Supabase: seriam duas migrações (vn e rs) e uma
// escrita de REDE a cada emoji clicado — a operação mais frequente do
// recurso. Dado de conveniência, por dispositivo, cabe em
// `localStorage`.
//
// Por que aqui e não num hook: ordenação MRU, deduplicação, teto da
// lista e tolerância a blob corrompido são regra de negócio testável
// sem browser (`AGENTS.md` → "lógica de negócio vive em src/lib/").
// O hook por cima é só `useState` + efeito.
//
// TUDO que sai daqui trata o conteúdo do storage como ENTRADA NÃO
// CONFIÁVEL: outra aba da mesma origem pode ter escrito qualquer
// coisa, e um blob adulterado não pode derrubar o composer.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Configuração — Recentes
// ============================================================

import type { Emoji } from 'frimousse';

import type { KeyValueStorage } from './storage';

/** Quantos guardar. 16 = duas fileiras de 8 na largura do popover. */
export const MAX_RECENTS = 16;

/**
 * Versão do formato gravado. Blob de versão diferente é DESCARTADO,
 * não migrado: são emojis recentes, o custo de perder é o usuário
 * clicar mais uma vez, e código de migração para isso seria caro e
 * nunca exercitado.
 */
const SCHEMA_VERSION = 1;

export interface RecentEmoji {
  /** O caractere JÁ com o tom de pele aplicado, como veio do picker. */
  emoji: string;
  /** Rótulo da Emojibase — vira o `aria-label` do botão na faixa. */
  label: string;
  /** Epoch ms do último uso. Só para uma futura política de expiração. */
  usedAt: number;
}

interface StoredRecents {
  version: number;
  items: RecentEmoji[];
}

export function recentsKey(userId: string): string {
  return `zapcrm:emoji:recents:${userId}`;
}

/** Uma entrada só é aproveitada se os três campos vierem sãos. */
function isRecentEmoji(value: unknown): value is RecentEmoji {
  if (typeof value !== 'object' || value === null) return false;

  const entry = value as Partial<RecentEmoji>;
  return (
    typeof entry.emoji === 'string' &&
    entry.emoji.length > 0 &&
    typeof entry.label === 'string' &&
    entry.label.length > 0 &&
    typeof entry.usedAt === 'number' &&
    Number.isFinite(entry.usedAt)
  );
}

/**
 * Lista MRU gravada para o usuário, ou `[]`.
 *
 * Nunca lança. Devolve `[]` para chave ausente, JSON inválido, versão
 * diferente, `items` que não é array e storage negado; dentro de um
 * array válido, entradas malformadas são FILTRADAS em vez de
 * invalidarem a lista inteira.
 *
 * Deduplica por `emoji` na LEITURA, não só na escrita: a faixa de
 * recentes usa o caractere como `key` do React, e um blob com
 * duplicatas (edição manual, merge de duas abas) renderizaria chaves
 * repetidas — que o React trata como bug de verdade, não como aviso
 * cosmético.
 */
export function readRecents(
  storage: KeyValueStorage | null,
  userId: string
): RecentEmoji[] {
  let raw: string | null;
  try {
    raw = storage?.getItem(recentsKey(userId)) ?? null;
  } catch {
    // Storage negado pelo navegador.
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Blob corrompido — começa do zero em vez de estourar.
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];

  const blob = parsed as Partial<StoredRecents>;
  if (blob.version !== SCHEMA_VERSION) return [];
  if (!Array.isArray(blob.items)) return [];

  const seen = new Set<string>();
  const items: RecentEmoji[] = [];

  for (const entry of blob.items) {
    if (!isRecentEmoji(entry)) continue;
    if (seen.has(entry.emoji)) continue;

    seen.add(entry.emoji);
    // Reconstruído campo a campo de propósito: chaves extras de um
    // blob editado à mão não vazam para o estado do React.
    items.push({
      emoji: entry.emoji,
      label: entry.label,
      usedAt: entry.usedAt,
    });

    if (items.length >= MAX_RECENTS) break;
  }

  return items;
}

/**
 * Grava a lista já pronta. Exportada (não só de uso interno) para que
 * o hook do React possa escrever sem passar por `pushRecent` — ver
 * `mergeRecent` abaixo.
 */
export function writeRecents(
  storage: KeyValueStorage | null,
  userId: string,
  items: RecentEmoji[]
): void {
  try {
    const payload: StoredRecents = { version: SCHEMA_VERSION, items };
    storage?.setItem(recentsKey(userId), JSON.stringify(payload));
  } catch {
    // Cota estourada ou storage negado — recentes são best-effort.
  }
}

/**
 * Funde um emoji escolhido numa lista MRU já carregada, SEM tocar
 * storage.
 *
 * Extraído de `pushRecent` (achado de code review): o hook do React já
 * mantém a lista atual em estado — reler o storage a cada clique era
 * trabalho redundante no caminho mais frequente do recurso inteiro.
 * `useEmojiRecents()` chama esta função direto sobre o estado em
 * memória e só grava quando o resultado realmente muda.
 *
 * Devolve a MESMA referência recebida (`current`) quando `emoji` não
 * tem caractere válido — é o sinal que os chamadores usam
 * (`next !== current`) para saber se algo mudou e vale a pena gravar.
 *
 * A deduplicação é pela string `emoji`, que já carrega o tom de pele:
 * 👍 e 👍🏽 permanecem entradas separadas de propósito — são caracteres
 * diferentes e o atendente escolheu cada um.
 */
export function mergeRecent(
  current: RecentEmoji[],
  emoji: Emoji,
  now: number = Date.now()
): RecentEmoji[] {
  const character = emoji?.emoji;
  if (typeof character !== 'string' || character.length === 0) {
    return current;
  }

  // Rótulo vazio cai no próprio caractere: sem isso gravaríamos uma
  // entrada que `isRecentEmoji` rejeita na leitura seguinte, e a faixa
  // de recentes nunca cresceria — falha silenciosa e difícil de ligar
  // à causa.
  const label =
    typeof emoji.label === 'string' && emoji.label.length > 0
      ? emoji.label
      : character;

  return [
    { emoji: character, label, usedAt: now },
    ...current.filter((item) => item.emoji !== character),
  ].slice(0, MAX_RECENTS);
}

/**
 * Registra um uso (lendo e gravando o storage) e devolve a lista já
 * atualizada.
 *
 * Devolver a lista (em vez de só gravar) deixa quem chama atualizar o
 * estado sem reler o storage — e mantém a UI correta mesmo quando a
 * gravação falha por cota. Só grava quando `mergeRecent` de fato
 * mudou algo (`next !== current`), então um emoji inválido não
 * reescreve o storage com o mesmo conteúdo.
 */
export function pushRecent(
  storage: KeyValueStorage | null,
  userId: string,
  emoji: Emoji,
  now: number = Date.now()
): RecentEmoji[] {
  const current = readRecents(storage, userId);
  const next = mergeRecent(current, emoji, now);
  if (next !== current) {
    writeRecents(storage, userId, next);
  }
  return next;
}

/** Esvazia a lista do usuário. Nunca lança. */
export function clearRecents(
  storage: KeyValueStorage | null,
  userId: string
): void {
  try {
    storage?.removeItem(recentsKey(userId));
  } catch {
    // Storage negado — nada a fazer.
  }
}
