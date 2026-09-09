'use client';

// ============================================================
// Conteúdo do popover de emoji — alvo do `next/dynamic` em
// `emoji-picker.tsx`. Fica em arquivo próprio de propósito: separar o
// painel do gatilho é o que mantém o Frimousse (e o dado da Emojibase)
// fora do chunk inicial do inbox.
//
// SPEC: docs/spec-066-emoji-picker-inbox.md § Uso
// ============================================================

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { EmojiPicker, useSkinTone, type Emoji, type SkinTone } from 'frimousse';

import { toEmojiLocale } from '@/lib/emoji/locale';
import { browserStorage } from '@/lib/emoji/storage';
import {
  DEFAULT_SKIN_TONE,
  readSkinTone,
  writeSkinTone,
} from '@/lib/emoji/preferences';
import type { RecentEmoji } from '@/lib/emoji/recents';

interface EmojiPickerPanelProps {
  onSelect: (emoji: Emoji) => void;
  recents: RecentEmoji[];
  onClearRecents: () => void;
  /** '' quando o usuário ainda não resolveu — cai no tom padrão. */
  userId: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * `export default`: é o formato que `next/dynamic` consome sem
 * wrapper adicional.
 */
export default function EmojiPickerPanel({
  onSelect,
  recents,
  onClearRecents,
  userId,
  searchRef,
}: EmojiPickerPanelProps) {
  const t = useTranslations('EmojiPicker');
  const emojiLocale = toEmojiLocale(useLocale());
  // Leitura síncrona: precisa existir no PRIMEIRO render, porque o
  // Frimousse só lê `skinTone` como valor INICIAL (ver PersistSkinTone
  // abaixo e a SPEC § Configuração — Skin tone).
  //
  // `userId` vazio (janela de hidratação antes do `useAuth()` resolver)
  // cai direto no padrão, sem tocar o storage — mesma guarda que
  // `useEmojiRecents()` já aplica para recentes (achado de code review:
  // sem isso, essa janela leria/gravaria um balde `skin-tone:` sem
  // sufixo, compartilhado por qualquer sessão ainda não resolvida).
  const initialSkinTone = userId
    ? readSkinTone(browserStorage(), userId)
    : DEFAULT_SKIN_TONE;

  // Reforço de foco: o Base UI tenta focar `searchRef` num único
  // `queueMicrotask` no instante em que o popover abre (ver
  // `emoji-picker.tsx`) — mas este painel só existe de verdade depois
  // que o chunk do `next/dynamic` carrega. Numa primeira abertura sem
  // hover prévio (toque, ou Tab+Enter direto no teclado, sem o
  // prefetch ter tido tempo de resolver), o microtask do Base UI roda
  // ANTES do chunk terminar, com `searchRef.current` ainda nulo, cai
  // no fallback (foca o popup) e nunca se corrige sozinho (achado de
  // code review). Este efeito roda depois que o PRÓPRIO painel montou
  // — ou seja, depois que o campo de busca já existe de verdade — e
  // corrige o foco nesse caso. É um no-op quando o Base UI já acertou:
  // refocar o mesmo elemento não tem efeito observável.
  useEffect(() => {
    searchRef.current?.focus();
  }, [searchRef]);

  return (
    <EmojiPicker.Root
      locale={emojiLocale}
      emojibaseUrl="/emojibase"
      skinTone={initialSkinTone}
      columns={8}
      onEmojiSelect={onSelect}
      className="bg-popover isolate flex h-[368px] w-[352px] flex-col"
    >
      <PersistSkinTone userId={userId} initialTone={initialSkinTone} />

      {recents.length > 0 && (
        <div
          role="group"
          aria-label={t('recents')}
          className="border-border flex flex-wrap items-center gap-0.5 border-b p-2"
        >
          {recents.map((r) => (
            <button
              key={r.emoji}
              type="button"
              aria-label={r.label}
              title={r.label}
              onClick={() => onSelect({ emoji: r.emoji, label: r.label })}
              className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md text-lg"
            >
              {r.emoji}
            </button>
          ))}
          <button
            type="button"
            onClick={onClearRecents}
            aria-label={t('clearRecents')}
            title={t('clearRecents')}
            className="text-muted-foreground hover:text-foreground ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <EmojiPicker.Search
        ref={searchRef}
        placeholder={t('searchPlaceholder')}
        className="border-border bg-muted text-foreground placeholder-muted-foreground m-2 rounded-md border px-2.5 py-1.5 text-sm outline-none"
      />

      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t('loading')}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t('empty')}
        </EmojiPicker.Empty>
        <EmojiPicker.List className="pb-1.5 select-none" />
      </EmojiPicker.Viewport>

      <div className="border-border flex items-center gap-2 border-t p-2">
        <EmojiPicker.SkinToneSelector aria-label={t('skinTone')} />
      </div>
    </EmojiPicker.Root>
  );
}

/**
 * Persiste o tom de pele escolhido pelo `SkinToneSelector`.
 *
 * `skinTone` no `Root` é valor INICIAL — o Frimousse escreve no store
 * uma vez (efeito interno com `[skinTone]` nas dependências) e a
 * v0.3.0 não expõe `onSkinToneChange`. `useSkinTone()`, chamado aqui
 * DENTRO do `Root`, é o único jeito de observar o que o seletor fez.
 * Sem este componente a preferência simplesmente não persiste, sem
 * erro nenhum.
 */
function PersistSkinTone({
  userId,
  initialTone,
}: {
  userId: string;
  initialTone: SkinTone;
}) {
  const [tone] = useSkinTone();
  // Baseline = o valor que já está gravado (o mesmo que inicializou o
  // Root). Sem isto, o efeito grava de volta no mount o valor que
  // acabou de ler — regravação redundante a cada abertura do popover,
  // mesmo sem o usuário trocar nada (achado de code review).
  const lastWrittenRef = useRef(initialTone);

  useEffect(() => {
    if (!userId) return; // ver nota em `initialSkinTone` acima
    if (tone === lastWrittenRef.current) return;
    lastWrittenRef.current = tone;
    writeSkinTone(browserStorage(), userId, tone);
  }, [tone, userId]);

  return null;
}
