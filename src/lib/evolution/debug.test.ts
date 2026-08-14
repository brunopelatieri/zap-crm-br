/**
 * Descritor de payload para diagnóstico manual do canal QRCode.
 *
 * O que se prova aqui é sobretudo o que ele NÃO imprime: o payload da
 * Evolution carrega `instanceToken` (o segredo que autentica a instância
 * inteira) e, com `WEBHOOK_FILES=true`, megabytes de base64 por áudio.
 */

import { describe, expect, it } from 'vitest';

import { describeShape } from './debug';

describe('describeShape', () => {
  it('redige o instanceToken — o log nunca pode virar vazamento', () => {
    const out = describeShape({
      event: 'Message',
      instanceId: 'inst-1',
      instanceToken: 'segredo-que-autentica-a-instancia',
    });

    expect(out).not.toContain('segredo-que-autentica-a-instancia');
    expect(out).toContain('instanceToken: ***');
    expect(out).toContain('instanceId: "inst-1"');
  });

  it('redige também o material de decriptação da mídia', () => {
    const out = describeShape({
      mediaKey: 'CmVkaWFLZXlCYXNlNjQ=',
      fileEncSHA256: 'ZW5jU0hB',
    });

    expect(out).not.toContain('CmVkaWFLZXlCYXNlNjQ=');
    expect(out).not.toContain('ZW5jU0hB');
  });

  it('trunca valor longo mostrando o tamanho, em vez de despejar base64', () => {
    const out = describeShape({ base64: 'A'.repeat(5000) });

    expect(out.length).toBeLessThan(300);
    expect(out).toContain('(len=5000)');
  });

  it('preserva os NOMES das chaves — é por eles que se descobre a grafia', () => {
    const out = describeShape({
      Info: { Chat: '5511999999999@s.whatsapp.net', IsFromMe: false },
      Message: { audioMessage: { URL: 'https://x/y.enc', PTT: true } },
    });

    expect(out).toContain('Info');
    expect(out).toContain('Chat');
    expect(out).toContain('audioMessage');
    expect(out).toContain('URL');
    expect(out).toContain('PTT: true');
  });

  it('resume array longo sem percorrer tudo', () => {
    const out = describeShape({ ids: ['a', 'b', 'c', 'd', 'e'] });
    expect(out).toContain('…+2');
  });

  it('não quebra com null, undefined nem estrutura vazia', () => {
    expect(describeShape(null)).toBe('null');
    expect(describeShape({ a: null, b: undefined, c: {}, d: [] })).toContain(
      'a: null'
    );
  });
});
