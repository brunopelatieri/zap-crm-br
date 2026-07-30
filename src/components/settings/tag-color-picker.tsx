'use client';

// ============================================================
// TagColorPicker — seleção de cor de etiqueta.
//
// Fechado, é a fileira de 8 presets que já existia, mais um botão de
// "cor personalizada". Aberto, oferece três caminhos para a mesma
// coisa, do mais barato ao mais preciso:
//
//   1. grade estendida (36 cores)  → um clique, cobre o caso comum;
//   2. input[type=color] nativo    → picker do SO, para "esta cor";
//   3. campo HEX                   → colar o valor da marca.
//
// Sem dependência nova: não há biblioteca de color picker no projeto e
// instalar uma para esta tela não se paga (§2.5 do SPEC). O input
// nativo já é acessível por teclado e tem zero custo de bundle.
//
// `onChange` só dispara com HEX canônico (`#rrggbb` minúsculo), então
// o consumidor nunca precisa validar de novo.
//
// A11y: usamos `aria-pressed` em botões, e não um `radiogroup` de
// verdade, porque não implementamos navegação por setas — anunciar
// "grupo de rádio" prometeria ao leitor de tela um teclado que não
// existe. A §6 do SPEC prevê explicitamente essa opção.
// ============================================================

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Pipette } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EXTENDED_COLORS, normalizeHexColor } from '@/lib/colors';
import { PRESET_COLORS } from '@/lib/tags';
import { cn } from '@/lib/utils';

interface TagColorPickerProps {
  /** HEX canônico. */
  value: string;
  /** Só é chamado com HEX canônico válido. */
  onChange: (hex: string) => void;
  disabled?: boolean;
  /** 'sm' na linha de criação (fileira compacta), 'md' no modal. */
  size?: 'sm' | 'md';
}

export function TagColorPicker({
  value,
  onChange,
  disabled = false,
  size = 'sm',
}: TagColorPickerProps) {
  const t = useTranslations('Settings.tagsAndFields');
  const tColors = useTranslations('Settings.tagsAndFields.colors');

  // O picker é montado duas vezes na mesma página (linha de criação +
  // modal de edição), então o id do campo HEX não pode ser literal —
  // dois `<label for>` apontando para o mesmo id levariam o foco para
  // o campo errado.
  const hexFieldId = useId();

  const [open, setOpen] = useState(false);
  // Rascunho do campo HEX. `null` significa "espelhe `value`" — é o
  // estado de repouso, e o motivo de não haver `useEffect` de
  // sincronização aqui.
  //
  // O rascunho precisa existir porque enquanto o usuário digita, "#3b8"
  // é um estado legítimo do input mas não uma cor. E precisa sobreviver
  // à mudança de `value`: em "abc" o valor já vira `#aabbcc` (3 dígitos
  // é HEX válido), e espelhar de volta tornaria impossível continuar
  // digitando "abcdef".
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const hexValue = hexDraft ?? value;

  const isPreset = PRESET_COLORS.some((preset) => preset.value === value);
  const hexDraftValid = normalizeHexColor(hexValue) !== null;
  const swatch = size === 'sm' ? 'size-6' : 'size-7';

  function commitHexDraft(raw: string) {
    const normalized = normalizeHexColor(raw);
    if (normalized) onChange(normalized);
  }

  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={t('colorLabel')}
    >
      {PRESET_COLORS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(preset.value)}
          aria-label={t('useColor', { color: tColors(preset.name) })}
          aria-pressed={value === preset.value}
          title={tColors(preset.name)}
          className={cn(
            swatch,
            'rounded-md transition-transform',
            !disabled && 'hover:scale-110',
            disabled && 'cursor-not-allowed opacity-50',
            value === preset.value &&
              'outline-primary outline outline-2 outline-offset-2'
          )}
          style={{ backgroundColor: preset.value }}
        />
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          type="button"
          disabled={disabled}
          aria-label={t('customColor')}
          aria-pressed={!isPreset}
          title={t('customColor')}
          className={cn(
            swatch,
            'text-foreground/70 flex items-center justify-center rounded-md transition-transform',
            !disabled && 'hover:scale-110',
            disabled && 'cursor-not-allowed opacity-50',
            !isPreset && 'outline-primary outline outline-2 outline-offset-2'
          )}
          // Quando a cor ativa não é preset, o botão passa a exibi-la —
          // é o único lugar da fileira onde essa cor aparece. Com uma
          // cor de preset ativa, o gradiente anuncia a função.
          style={
            isPreset
              ? {
                  background:
                    'conic-gradient(#ef4444, #f59e0b, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
                }
              : { backgroundColor: value }
          }
        >
          <Pipette className="size-3.5 drop-shadow-[0_0_2px_rgba(255,255,255,0.9)] dark:drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
        </PopoverTrigger>

        <PopoverContent align="start" className="gap-3">
          <div
            className="grid grid-cols-6 gap-1.5"
            role="group"
            aria-label={t('colorGrid')}
          >
            {EXTENDED_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => {
                  onChange(color);
                  setOpen(false);
                }}
                // O HEX é o rótulo: nomear 36 tons ("azul 600"?) daria
                // rótulos piores que o próprio swatch, e a escolha aqui
                // é visual por natureza.
                aria-label={color}
                aria-pressed={value === color}
                title={color}
                className={cn(
                  'flex size-7 items-center justify-center rounded-md transition-transform hover:scale-110',
                  value === color &&
                    'outline-primary outline outline-2 outline-offset-1'
                )}
                style={{ backgroundColor: color }}
              >
                {value === color && (
                  <Check className="size-3.5 text-white drop-shadow-[0_0_2px_rgba(0,0,0,0.6)]" />
                )}
              </button>
            ))}
          </div>

          <div className="border-border flex items-end gap-2 border-t pt-3">
            {/* O input nativo não é estilizável de forma consistente
                entre navegadores: renderizamos o swatch e deixamos o
                input real por cima, transparente e do mesmo tamanho —
                ele continua sendo o alvo de clique e de foco. */}
            <div className="relative shrink-0">
              <div
                aria-hidden
                className="border-input size-8 rounded-lg border"
                style={{ backgroundColor: value }}
              />
              <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value.toLowerCase())}
                aria-label={t('pickerNative')}
                title={t('pickerNative')}
                className="absolute inset-0 size-8 cursor-pointer opacity-0"
              />
            </div>

            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={hexFieldId} className="text-xs">
                {t('hexLabel')}
              </Label>
              <Input
                id={hexFieldId}
                value={hexValue}
                onChange={(e) => {
                  setHexDraft(e.target.value);
                  commitHexDraft(e.target.value);
                }}
                // Volta a espelhar `value`: o que ficou no campo passa a
                // ser a forma canônica do que foi realmente aplicado.
                onBlur={() => setHexDraft(null)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  // O picker vive dentro do modal de edição; sem isto o
                  // Enter no campo de cor submeteria o formulário.
                  e.preventDefault();
                  commitHexDraft(hexValue);
                }}
                placeholder="#3b82f6"
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!hexDraftValid}
                aria-describedby={hexDraftValid ? undefined : `${hexFieldId}-e`}
                className="font-mono text-xs"
              />
            </div>
          </div>

          {!hexDraftValid && (
            <p id={`${hexFieldId}-e`} className="text-destructive text-xs">
              {t('invalidHex')}
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
