// ============================================================
// Helpers de cor — puros, sem React e sem I/O.
//
// Existem por causa do seletor de cor customizada das etiquetas
// (docs/spec-settings-tag-editing.md): a partir do momento em que o
// usuário pode digitar um HEX arbitrário, três coisas passam a
// precisar de código e não de constante:
//
//   1. validar / normalizar o que foi digitado (`#ABC` → `#aabbcc`);
//   2. estimar se o chip resultante fica legível, já que ele pinta o
//      texto com a própria cor sobre a mesma cor a 12,5% de opacidade;
//   3. oferecer uma grade de cores maior que os 8 presets.
//
// Nada aqui conhece Tailwind, tema ou DOM — o cálculo de contraste é
// o de luminância relativa da WCAG 2.x, aplicado sobre cores já
// compostas em sRGB.
// ============================================================

/** HEX aceito na entrada: 3 ou 6 dígitos, `#` opcional. */
const HEX_INPUT_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True se `value` é um HEX de 3 ou 6 dígitos (com ou sem `#`). */
export function isValidHexColor(value: string): boolean {
  return HEX_INPUT_RE.test(value.trim());
}

/**
 * Normaliza para a forma canônica `#rrggbb` minúscula, ou `null` se a
 * entrada não for um HEX válido.
 *
 * Forma canônica única importa além da estética: `dirty` no modal de
 * edição compara strings, e `#10B981` vs `#10b981` marcariam como
 * "alterado" algo que não mudou.
 */
export function normalizeHexColor(value: string): string | null {
  const match = HEX_INPUT_RE.exec(value.trim());
  if (!match) return null;

  const digits = match[1].toLowerCase();
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;

  return `#${full}`;
}

/** Canais 0–255. `null` quando a entrada não é HEX válido. */
function parseHex(value: string): [number, number, number] | null {
  const normalized = normalizeHexColor(value);
  if (!normalized) return null;

  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Canal sRGB 0–255 → linear 0–1 (WCAG 2.x). */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Luminância relativa (0 = preto, 1 = branco), fórmula da WCAG 2.x.
 *
 * Lança se `hex` for inválido: quem chama já deve ter validado com
 * `isValidHexColor`. Os consumidores tolerantes a lixo (cores vindas
 * do banco, do import de CSV ou do n8n) são `hasLowChipContrast` e
 * `chipBackgroundHex`, que tratam o caso sem propagar exceção.
 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Invalid hex color: ${hex}`);

  const [r, g, b] = rgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste WCAG entre duas cores opacas. Vai de 1 a 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Mistura `foreground` sobre `background` com opacidade `alpha`
 * (0–1), em sRGB. É o mesmo resultado que o navegador produz para
 * `backgroundColor: '#rrggbbAA'` — só que como cor opaca, para poder
 * entrar no cálculo de contraste e no preview de tema forçado.
 */
export function mixHex(
  foreground: string,
  background: string,
  alpha: number
): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) throw new Error(`Invalid hex color: ${foreground}`);

  return toHex([
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ]);
}

/**
 * Opacidade do fundo do chip de etiqueta. Espelha o sufixo `20` de
 * `backgroundColor: ${tag.color}20` usado no chip — se aquele valor
 * mudar, este muda junto, ou o aviso de contraste passa a medir uma
 * UI que não existe.
 */
export const CHIP_BACKGROUND_ALPHA = 0x20 / 0xff;

/**
 * Superfície sob o chip em cada tema. Os chips vivem dentro de um
 * `Card`, então a referência é o token `--card` de
 * `src/app/globals.css`, convertido de oklch para sRGB:
 *
 *   claro: oklch(1 0 0)           → #ffffff
 *   escuro: oklch(0.18 0.01 260)  → ~#111318
 */
export const CHIP_SURFACES = {
  light: '#ffffff',
  dark: '#111318',
} as const;

export type ChipTheme = keyof typeof CHIP_SURFACES;

/**
 * Limiar de aviso — 2:1, e não os 3:1 (AA texto grande) que a §2.4 do
 * SPEC previa. Desvio deliberado, medido:
 *
 * A §2.4 propunha medir o texto do chip contra o fundo do chip
 * (`${color}20`). Esse número é estruturalmente comprimido, porque o
 * fundo é uma tinta 12,5% da MESMA cor: os 8 presets que já estão em
 * produção pontuam 1,95–3,63 no tema claro por essa métrica, ou seja,
 * um limiar de 3:1 reprovaria 6 deles — incluindo `DEFAULT_TAG_COLOR`
 * (esmeralda, 2,25). Um aviso que dispara na cor padrão só ensina o
 * usuário a ignorar avisos.
 *
 * O que de fato torna uma etiqueta ilegível é a cor se aproximar em
 * luminância da SUPERFÍCIE (o card), não do próprio fundo tingido:
 * `#ffff00` desaparece no claro (1,07) e `#000000` no escuro (1,13),
 * enquanto os presets ficam em 2,15–4,23. Então medimos contra a
 * superfície, e o limiar é ancorado empiricamente no pior preset que
 * já enviamos (âmbar, 2,15 no claro): 2:1 aprova tudo o que hoje é
 * aceito e reprova só o que realmente some no fundo.
 */
export const LOW_CONTRAST_RATIO = 2;

/**
 * Fundo efetivo (opaco) do chip para uma cor e um tema.
 *
 * Usado pelo preview de tema forçado: dentro de um modal claro não dá
 * para confiar em alpha sobre a superfície real para simular o tema
 * escuro — o valor precisa ser composto na mão.
 */
export function chipBackgroundHex(color: string, theme: ChipTheme): string {
  const surface = CHIP_SURFACES[theme];
  if (!isValidHexColor(color)) return surface;
  return mixHex(color, surface, CHIP_BACKGROUND_ALPHA);
}

/** Contraste da cor da etiqueta contra a superfície do card no tema. */
export function chipContrastRatio(color: string, theme: ChipTheme): number {
  return contrastRatio(color, CHIP_SURFACES[theme]);
}

/**
 * Em quais temas a cor rende um chip de leitura difícil.
 *
 * Tolerante a entrada inválida: devolve `false` nos dois temas em vez
 * de lançar, porque a cor pode vir do banco (import de CSV, fluxo n8n)
 * sem ter passado pelo picker — e "não sei medir" não é "está ruim".
 */
export function hasLowChipContrast(color: string): {
  light: boolean;
  dark: boolean;
} {
  if (!isValidHexColor(color)) return { light: false, dark: false };

  return {
    light: chipContrastRatio(color, 'light') < LOW_CONTRAST_RATIO,
    dark: chipContrastRatio(color, 'dark') < LOW_CONTRAST_RATIO,
  };
}

/**
 * Grade estendida do picker: 36 cores, pensada para uma grade de 6
 * colunas. As cinco primeiras linhas são 10 matizes em três tons
 * (400 / 500 / 600 da paleta Tailwind, dois matizes por linha); a
 * última linha completa os matizes que faltavam, no tom 500.
 *
 * Os valores são os HEX da paleta Tailwind v3 — os mesmos que
 * `PRESET_COLORS` em `src/lib/tags.ts` já usa. Não são lidos do CSS
 * de propósito: precisam ser HEX literais para ir ao banco e para o
 * cálculo de contraste.
 *
 * Sem chaves de tradução: aqui a cor é escolhida visualmente, e
 * nomear 36 tons ("azul 600"?) daria rótulos piores que o próprio
 * swatch. O `aria-label` usa o HEX (§6 do SPEC).
 */
// prettier-ignore
export const EXTENDED_COLORS: readonly string[] = [
  // red / orange
  '#f87171', '#ef4444', '#dc2626', '#fb923c', '#f97316', '#ea580c',
  // amber / lime
  '#fbbf24', '#f59e0b', '#d97706', '#a3e635', '#84cc16', '#65a30d',
  // emerald / teal
  '#34d399', '#10b981', '#059669', '#2dd4bf', '#14b8a6', '#0d9488',
  // cyan / blue
  '#22d3ee', '#06b6d4', '#0891b2', '#60a5fa', '#3b82f6', '#2563eb',
  // violet / pink
  '#a78bfa', '#8b5cf6', '#7c3aed', '#f472b6', '#ec4899', '#db2777',
  // indigo / fuchsia / rose / sky / green / slate — tom 500
  '#6366f1', '#d946ef', '#f43f5e', '#0ea5e9', '#22c55e', '#64748b',
] as const;
