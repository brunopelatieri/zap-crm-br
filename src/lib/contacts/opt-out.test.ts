import { describe, expect, it } from 'vitest';

import { OPT_OUT_KEYWORDS, detectOptOut, normalizeInbound } from './opt-out';

describe('normalizeInbound', () => {
  it('tira acento, caixa e pontuação', () => {
    expect(normalizeInbound('NÃO QUERO MAIS!!!')).toBe('nao quero mais');
    expect(normalizeInbound('  Sair.  ')).toBe('sair');
    expect(normalizeInbound('Descadastrar')).toBe('descadastrar');
  });

  it('pontuação vira espaço, não vazio', () => {
    // "sair,agora" não pode colapsar em "sairagora" — a fronteira de
    // palavra é o que permite comparar frases inteiras.
    expect(normalizeInbound('sair,agora')).toBe('sair agora');
  });

  it('colapsa espaços repetidos e quebras de linha', () => {
    expect(normalizeInbound('quero   sair\nda lista')).toBe(
      'quero sair da lista'
    );
  });
});

describe('detectOptOut — casa', () => {
  it('reconhece as palavras-chave da §6.8', () => {
    expect(detectOptOut('SAIR')).toBe('sair');
    expect(detectOptOut('parar')).toBe('parar');
    expect(detectOptOut('Descadastrar')).toBe('descadastrar');
  });

  it('tolera pontuação, caixa e espaço em volta', () => {
    expect(detectOptOut('  Sair!  ')).toBe('sair');
    expect(detectOptOut('PARE.')).toBe('pare');
  });

  it('reconhece as frases com acento na grafia normalizada', () => {
    expect(detectOptOut('não quero mais receber')).toBe(
      'nao quero mais receber'
    );
  });

  it('cobre as variantes em inglês', () => {
    expect(detectOptOut('STOP')).toBe('stop');
    expect(detectOptOut('unsubscribe')).toBe('unsubscribe');
    expect(detectOptOut('opt-out')).toBe('opt out');
  });

  it('devolve a forma normalizada, para a trilha ser comparável', () => {
    expect(detectOptOut('SAIR!!!')).toBe(detectOptOut('sair'));
  });

  it('toda palavra-chave da lista casa consigo mesma', () => {
    for (const keyword of OPT_OUT_KEYWORDS) {
      expect(detectOptOut(keyword)).toBe(keyword);
    }
  });
});

describe('detectOptOut — NÃO casa', () => {
  it('ignora a palavra-chave dentro de uma frase maior', () => {
    // O caso que justifica o casamento exato: um elogio não pode virar
    // descadastro.
    expect(detectOptOut('não vou parar de comprar com vocês')).toBeNull();
    expect(
      detectOptOut('vou sair de viagem amanhã, me avise depois')
    ).toBeNull();
    expect(detectOptOut('pode cancelar meu pedido de ontem?')).toBeNull();
  });

  it('ignora mensagem normal', () => {
    expect(detectOptOut('bom dia, tudo bem?')).toBeNull();
    expect(detectOptOut('quanto custa o plano anual?')).toBeNull();
  });

  it('ignora vazio, nulo e indefinido', () => {
    expect(detectOptOut('')).toBeNull();
    expect(detectOptOut(null)).toBeNull();
    expect(detectOptOut(undefined)).toBeNull();
    expect(detectOptOut('   ')).toBeNull();
    expect(detectOptOut('!!!')).toBeNull();
  });

  it('ignora mensagem longa, mesmo que normalize para uma palavra-chave', () => {
    const long = 'sair' + '!'.repeat(80);
    expect(long.length).toBeGreaterThan(60);
    expect(detectOptOut(long)).toBeNull();
  });
});
