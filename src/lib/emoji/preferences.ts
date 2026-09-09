// ============================================================
// Preferência de tom de pele do seletor de emojis.
//
// Mora em `localStorage`, não em coluna do Supabase: migração se paga
// quando o dado precisa ser lido pelo servidor, auditado ou
// compartilhado, e tom de pele não é nenhum dos três. O custo
// alternativo seria uma migração em DOIS projetos Supabase (vn e rs),
// um round-trip antes do primeiro render e revisão de RLS — por uma
// preferência cosmética. Mesmo raciocínio (e mesmo precedente) do
// `use-theme.tsx` / `themes.ts`.
//
// A chave leva o `userId` no sufixo porque em PME é comum a mesma
// estação atender com dois logins diferentes: sem isso, um herdaria a
// preferência do outro. Isso é higiene, NÃO isolamento de segurança —
// `localStorage` é por origem e quem abre o navegador lê as duas
// chaves de qualquer forma. Por isso só preferência cosmética mora
// aqui.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Configuração — Skin tone
// ============================================================

import type { SkinTone } from 'frimousse';

import type { KeyValueStorage } from './storage';

/** Tom neutro (amarelo) — o padrão do próprio Frimousse. */
export const DEFAULT_SKIN_TONE: SkinTone = 'none';

/**
 * `Record<SkinTone, true>` em vez de array: o tipo obriga a listar
 * TODOS os tons do Frimousse (faltar um não compila) e proíbe inventar
 * um que não existe (sobrar um também não compila).
 *
 * Se a lib adicionar um tom numa versão futura, o typecheck acusa aqui
 * — bem melhor do que a UI aceitar o tom novo, gravá-lo, e a leitura
 * seguinte descartá-lo em silêncio por não reconhecer o valor.
 */
const SKIN_TONE_SET: Record<SkinTone, true> = {
  none: true,
  light: true,
  'medium-light': true,
  medium: true,
  'medium-dark': true,
  dark: true,
};

/** Todos os tons suportados. Derivado do Record — não duplique a lista. */
export const SKIN_TONES = Object.keys(SKIN_TONE_SET) as readonly SkinTone[];

export function skinToneKey(userId: string): string {
  return `zapcrm:emoji:skin-tone:${userId}`;
}

/**
 * `=== true`, não `in` nem truthy: `SKIN_TONE_SET['toString']` devolve
 * a função herdada do prototype, e um teste por `in`/truthy aceitaria
 * `'toString'` como tom válido.
 */
export function isSkinTone(value: unknown): value is SkinTone {
  return typeof value === 'string' && SKIN_TONE_SET[value as SkinTone] === true;
}

/**
 * Tom gravado para o usuário, ou o padrão.
 *
 * Nunca lança: storage ausente (servidor), acesso negado pelo
 * navegador e valor gravado inválido caem todos em
 * `DEFAULT_SKIN_TONE`.
 */
export function readSkinTone(
  storage: KeyValueStorage | null,
  userId: string
): SkinTone {
  try {
    const raw = storage?.getItem(skinToneKey(userId));
    return isSkinTone(raw) ? raw : DEFAULT_SKIN_TONE;
  } catch {
    // Storage negado pelo navegador — segue no padrão.
    return DEFAULT_SKIN_TONE;
  }
}

/**
 * Grava o tom escolhido.
 *
 * Nunca lança: `setItem` estoura por cota e em janela privada do
 * Safari, e perder uma preferência cosmética não pode derrubar o
 * composer no meio de um atendimento.
 */
export function writeSkinTone(
  storage: KeyValueStorage | null,
  userId: string,
  tone: SkinTone
): void {
  try {
    storage?.setItem(skinToneKey(userId), tone);
  } catch {
    // Cota estourada ou storage negado — preferência é best-effort.
  }
}
