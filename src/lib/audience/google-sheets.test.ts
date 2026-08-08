import { describe, expect, it } from 'vitest';
import {
  buildSheetCsvUrl,
  extractSheetRef,
  looksLikeGoogleLoginPage,
} from './google-sheets';

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

describe('extractSheetRef', () => {
  it('extrai id e gid de uma URL de edição', () => {
    expect(
      extractSheetRef(
        `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123`
      )
    ).toEqual({ spreadsheetId: ID, gid: '123' });
  });

  it('aceita URL sem gid', () => {
    expect(
      extractSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit`)
    ).toEqual({ spreadsheetId: ID, gid: undefined });
  });

  it('aceita gid na query string', () => {
    expect(
      extractSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=7`)
    ).toMatchObject({ gid: '7' });
  });

  it('recorta espaços em volta', () => {
    expect(
      extractSheetRef(`  https://docs.google.com/spreadsheets/d/${ID}/edit  `)
    ).toMatchObject({ spreadsheetId: ID });
  });

  // ---- superfície de SSRF -------------------------------------------

  it('rejeita host que não é docs.google.com', () => {
    expect(
      extractSheetRef(`https://evil.tld/spreadsheets/d/${ID}/edit`)
    ).toBeNull();
  });

  it('rejeita userinfo disfarçando o host', () => {
    // `https://docs.google.com@evil.tld/` tem hostname evil.tld.
    expect(
      extractSheetRef(
        `https://docs.google.com@evil.tld/spreadsheets/d/${ID}/edit`
      )
    ).toBeNull();
  });

  it('rejeita subdomínio parecido', () => {
    expect(
      extractSheetRef(`https://docs.google.com.evil.tld/spreadsheets/d/${ID}/`)
    ).toBeNull();
  });

  it('rejeita http sem TLS', () => {
    expect(
      extractSheetRef(`http://docs.google.com/spreadsheets/d/${ID}/edit`)
    ).toBeNull();
  });

  it('rejeita esquemas não-http', () => {
    expect(extractSheetRef('file:///etc/passwd')).toBeNull();
    expect(extractSheetRef('javascript:alert(1)')).toBeNull();
  });

  it('rejeita endereço de metadados da instância', () => {
    expect(
      extractSheetRef('http://169.254.169.254/latest/meta-data/')
    ).toBeNull();
  });

  it('rejeita URL do Google que não é planilha', () => {
    expect(
      extractSheetRef('https://docs.google.com/document/d/abc/edit')
    ).toBeNull();
  });

  it('rejeita id curto demais para ser real', () => {
    expect(
      extractSheetRef('https://docs.google.com/spreadsheets/d/abc/edit')
    ).toBeNull();
  });

  it('rejeita entrada vazia ou não-URL', () => {
    expect(extractSheetRef('')).toBeNull();
    expect(extractSheetRef('   ')).toBeNull();
    expect(extractSheetRef('planilha do google')).toBeNull();
  });
});

describe('buildSheetCsvUrl', () => {
  it('monta a URL de export a partir de constantes', () => {
    expect(buildSheetCsvUrl({ spreadsheetId: ID, gid: '123' })).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=123`
    );
  });

  it('omite gid quando ausente', () => {
    expect(buildSheetCsvUrl({ spreadsheetId: ID })).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`
    );
  });

  it('aponta sempre para docs.google.com, seja qual for o id', () => {
    // A reconstrução é a barreira real: nada da string colada
    // sobrevive até a requisição.
    const url = new URL(buildSheetCsvUrl({ spreadsheetId: ID }));
    expect(url.origin).toBe('https://docs.google.com');
  });
});

describe('looksLikeGoogleLoginPage', () => {
  it('detecta a página de login servida com 200 para planilha privada', () => {
    expect(
      looksLikeGoogleLoginPage(
        '<html><head><title>Sign in - Google Accounts</title></head>'
      )
    ).toBe(true);
  });

  it('detecta a versão em português', () => {
    expect(
      looksLikeGoogleLoginPage('<html><body>Fazer login para continuar</body>')
    ).toBe(true);
  });

  it('não confunde CSV legítimo com login', () => {
    expect(looksLikeGoogleLoginPage('phone,name\n5511988887777,Maria')).toBe(
      false
    );
  });

  it('não confunde CSV que contém a palavra html', () => {
    expect(
      looksLikeGoogleLoginPage('phone,name\n5511988887777,html sign in')
    ).toBe(false);
  });
});
