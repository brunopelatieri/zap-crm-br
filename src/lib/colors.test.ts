import { describe, expect, it } from 'vitest';

import {
  CHIP_SURFACES,
  EXTENDED_COLORS,
  LOW_CONTRAST_RATIO,
  chipBackgroundHex,
  chipContrastRatio,
  contrastRatio,
  hasLowChipContrast,
  isValidHexColor,
  mixHex,
  normalizeHexColor,
  relativeLuminance,
} from './colors';
import { PRESET_COLORS } from './tags';

describe('isValidHexColor', () => {
  it.each(['#aabbcc', 'aabbcc', '#abc', 'abc', '#AABBCC', '#ABC', '  #abc  '])(
    'aceita %s',
    (value) => {
      expect(isValidHexColor(value)).toBe(true);
    }
  );

  it.each([
    '',
    '#',
    '#ab',
    '#abcd',
    '#abcde',
    '#abcdefg',
    '#gggggg',
    'rgb(0,0,0)',
    'red',
    '##abc',
  ])('rejeita %s', (value) => {
    expect(isValidHexColor(value)).toBe(false);
  });
});

describe('normalizeHexColor', () => {
  it('expande a forma de 3 dígitos', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
    expect(normalizeHexColor('f0a')).toBe('#ff00aa');
  });

  it('minúsculas e prefixo canônicos', () => {
    expect(normalizeHexColor('10B981')).toBe('#10b981');
    expect(normalizeHexColor('#10B981')).toBe('#10b981');
  });

  it('ignora espaços em volta', () => {
    expect(normalizeHexColor('  #3B82F6 ')).toBe('#3b82f6');
  });

  it('é idempotente', () => {
    const once = normalizeHexColor('#ABC')!;
    expect(normalizeHexColor(once)).toBe(once);
  });

  it('devolve null para entrada inválida', () => {
    expect(normalizeHexColor('#abcd')).toBeNull();
    expect(normalizeHexColor('nope')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('ancora preto em 0 e branco em 1', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('cresce monotonicamente com o cinza', () => {
    const grays = ['#000000', '#333333', '#808080', '#cccccc', '#ffffff'];
    const lums = grays.map(relativeLuminance);
    expect([...lums].sort((a, b) => a - b)).toEqual(lums);
  });

  it('lança para HEX inválido', () => {
    expect(() => relativeLuminance('nope')).toThrow(/Invalid hex color/);
  });
});

describe('contrastRatio', () => {
  it('preto vs branco = 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('cor contra si mesma = 1', () => {
    expect(contrastRatio('#10b981', '#10b981')).toBeCloseTo(1, 10);
  });

  it('é simétrico', () => {
    expect(contrastRatio('#10b981', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#10b981'),
      10
    );
  });
});

describe('mixHex', () => {
  it('alpha 1 devolve o foreground; alpha 0, o background', () => {
    expect(mixHex('#ffffff', '#000000', 1)).toBe('#ffffff');
    expect(mixHex('#ffffff', '#000000', 0)).toBe('#000000');
  });

  it('alpha 0.5 fica no meio', () => {
    expect(mixHex('#ffffff', '#000000', 0.5)).toBe('#808080');
  });
});

describe('chipBackgroundHex', () => {
  // 0x20/0xff ≈ 12,5% — o mesmo alpha do sufixo `20` no estilo do chip.
  it('tinge levemente a superfície clara', () => {
    expect(chipBackgroundHex('#000000', 'light')).toBe('#dfdfdf');
  });

  it('tinge levemente a superfície escura', () => {
    expect(chipBackgroundHex('#ffffff', 'dark')).toBe('#2f3135');
  });

  it('cai na superfície quando a cor é inválida', () => {
    expect(chipBackgroundHex('nope', 'light')).toBe(CHIP_SURFACES.light);
    expect(chipBackgroundHex('', 'dark')).toBe(CHIP_SURFACES.dark);
  });
});

describe('hasLowChipContrast', () => {
  it('acusa quase-branco só no tema claro', () => {
    expect(hasLowChipContrast('#ffff00')).toEqual({ light: true, dark: false });
    expect(hasLowChipContrast('#f5f5f5')).toEqual({ light: true, dark: false });
  });

  it('acusa quase-preto só no tema escuro', () => {
    expect(hasLowChipContrast('#000000')).toEqual({ light: false, dark: true });
    expect(hasLowChipContrast('#0a0a0a')).toEqual({ light: false, dark: true });
  });

  it('não acusa uma cor de luminância média', () => {
    expect(hasLowChipContrast('#64748b')).toEqual({
      light: false,
      dark: false,
    });
  });

  it('é tolerante a HEX inválido em vez de lançar', () => {
    // Cores podem chegar do banco sem passar pelo picker (import de CSV,
    // fluxo n8n): "não sei medir" não é "está ruim".
    expect(hasLowChipContrast('red')).toEqual({ light: false, dark: false });
    expect(hasLowChipContrast('')).toEqual({ light: false, dark: false });
  });

  // Guarda de calibragem: o limiar existe para pegar cores que somem no
  // fundo, não para condenar a paleta que já está em produção. Se este
  // teste quebrar, ou o limiar subiu demais, ou um preset novo é ilegível
  // — nos dois casos a decisão é humana, não um ajuste silencioso.
  it('não acusa nenhum dos presets de PRESET_COLORS', () => {
    for (const preset of PRESET_COLORS) {
      expect(hasLowChipContrast(preset.value), preset.name).toEqual({
        light: false,
        dark: false,
      });
    }
  });

  it('mantém margem entre o limiar e o pior preset', () => {
    const worst = Math.min(
      ...PRESET_COLORS.flatMap((p) => [
        chipContrastRatio(p.value, 'light'),
        chipContrastRatio(p.value, 'dark'),
      ])
    );
    expect(worst).toBeGreaterThan(LOW_CONTRAST_RATIO);
  });
});

describe('EXTENDED_COLORS', () => {
  it('preenche uma grade de 6 colunas sem sobra', () => {
    expect(EXTENDED_COLORS.length % 6).toBe(0);
    expect(EXTENDED_COLORS.length).toBe(36);
  });

  it('já está na forma canônica', () => {
    for (const color of EXTENDED_COLORS) {
      expect(normalizeHexColor(color)).toBe(color);
    }
  });

  it('não tem duplicatas', () => {
    expect(new Set(EXTENDED_COLORS).size).toBe(EXTENDED_COLORS.length);
  });

  it('inclui os presets em tom 500', () => {
    for (const preset of PRESET_COLORS) {
      expect(EXTENDED_COLORS).toContain(preset.value);
    }
  });
});
