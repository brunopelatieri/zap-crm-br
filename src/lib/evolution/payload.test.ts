/**
 * Leitura tolerante a grafia (SPEC 048 §6.5).
 *
 * O caso que motivou o módulo: o proto de áudio traz `URL`, e o webhook
 * procurava `url` — a mensagem entrava com `content_type: 'audio'` e
 * `media_path` nulo, virando "Áudio indisponível" no inbox.
 */

import { describe, expect, it } from 'vitest';

import { pickBoolean, pickKey, pickRecord, pickString } from './payload';

describe('pickString', () => {
  it('acha o campo pela grafia exata', () => {
    expect(pickString({ url: 'a' }, 'url')).toBe('a');
  });

  it('acha o campo ignorando a caixa — URL quando se procura url', () => {
    expect(pickString({ URL: 'https://x/y.enc' }, 'url')).toBe(
      'https://x/y.enc'
    );
    expect(pickString({ Mimetype: 'audio/ogg' }, 'mimetype')).toBe('audio/ogg');
  });

  it('a grafia exata tem prioridade sobre a equivalente por caixa', () => {
    expect(pickString({ id: 'minusculo', ID: 'maiusculo' }, 'ID')).toBe(
      'maiusculo'
    );
  });

  it('respeita a ordem dos candidatos', () => {
    expect(
      pickString({ url: 'segundo', mediaUrl: 'primeiro' }, 'mediaUrl', 'url')
    ).toBe('primeiro');
  });

  it('trata string vazia como ausência', () => {
    // Um `ID: ""` do provedor não é um id — deixá-lo passar transformaria
    // "campo não veio" em "campo veio vazio" lá na frente.
    expect(pickString({ ID: '' }, 'ID')).toBeNull();
  });

  it('devolve null para campo ausente, objeto nulo ou tipo errado', () => {
    expect(pickString({}, 'url')).toBeNull();
    expect(pickString(null, 'url')).toBeNull();
    expect(pickString({ url: 42 }, 'url')).toBeNull();
  });
});

describe('pickRecord e pickKey', () => {
  it('pickRecord devolve só objetos — nunca array nem primitivo', () => {
    expect(pickRecord({ Info: { a: 1 } }, 'info')).toEqual({ a: 1 });
    expect(pickRecord({ Info: [1, 2] }, 'info')).toBeNull();
    expect(pickRecord({ Info: 'texto' }, 'info')).toBeNull();
  });

  it('pickKey devolve o valor cru, inclusive arrays', () => {
    expect(pickKey({ MessageIDs: ['a'] }, 'messageids')).toEqual(['a']);
  });
});

describe('pickBoolean', () => {
  it('lê booleano por qualquer caixa', () => {
    expect(pickBoolean({ IsFromMe: true }, 'isfromme')).toBe(true);
    expect(pickBoolean({ isFromMe: false }, 'IsFromMe')).toBe(false);
  });

  it('aceita as strings "true"/"false" do envelope', () => {
    expect(pickBoolean({ Connected: 'true' }, 'Connected')).toBe(true);
  });

  it('distingue ausente (null) de false', () => {
    expect(pickBoolean({}, 'Connected')).toBeNull();
    expect(pickBoolean({ Connected: false }, 'Connected')).toBe(false);
  });
});
