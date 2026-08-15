import { describe, expect, it } from 'vitest';

import {
  CONTACTS_PAGE_SIZE,
  hasActiveContactFilters,
  planContactQuery,
} from './contact-filter-query';

const TAG = '11111111-1111-1111-1111-111111111111';
const CHANNEL = '22222222-2222-2222-2222-222222222222';
const CHANNEL_2 = '33333333-3333-3333-3333-333333333333';

function state(over: Partial<Parameters<typeof planContactQuery>[0]> = {}) {
  return { search: '', tagIds: [], channelIds: [], page: 0, ...over };
}

describe('planContactQuery', () => {
  it('sem filtro nenhum lê a tabela direto', () => {
    expect(planContactQuery(state())).toEqual({
      mode: 'table',
      search: null,
      from: 0,
      to: CONTACTS_PAGE_SIZE - 1,
    });
  });

  it('só busca textual continua na tabela — o teto do PostgREST não se aplica', () => {
    // A busca é um predicado na própria `contacts`, sem JOIN: o
    // `count: 'exact'` do caminho direto já conta certo.
    expect(planContactQuery(state({ search: '  maria  ' }))).toEqual({
      mode: 'table',
      search: 'maria',
      from: 0,
      to: CONTACTS_PAGE_SIZE - 1,
    });
  });

  it('paginação da tabela é inclusiva e 0-based', () => {
    const plan = planContactQuery(state({ page: 2 }));
    expect(plan).toMatchObject({ mode: 'table', from: 50, to: 74 });
  });

  it('etiqueta selecionada vai pelo RPC, sem filtro de canal', () => {
    // p_channel_ids null (e não []) é o que mantém a chamada idêntica
    // à da 025 para quem só filtra etiqueta.
    expect(planContactQuery(state({ tagIds: [TAG] }))).toEqual({
      mode: 'rpc',
      params: {
        p_tag_ids: [TAG],
        p_search: null,
        p_limit: CONTACTS_PAGE_SIZE,
        p_offset: 0,
        p_channel_ids: null,
      },
    });
  });

  it('canal sozinho também vai pelo RPC, com p_tag_ids vazio', () => {
    // Este é o caminho que a 061 abriu: sem ele, "só canal" cairia num
    // `.in('id', ids)` que perde contatos em silêncio (SPEC 049 §1.4).
    expect(planContactQuery(state({ channelIds: [CHANNEL] }))).toEqual({
      mode: 'rpc',
      params: {
        p_tag_ids: [],
        p_search: null,
        p_limit: CONTACTS_PAGE_SIZE,
        p_offset: 0,
        p_channel_ids: [CHANNEL],
      },
    });
  });

  it('etiqueta + canal + busca + página viajam juntos no RPC', () => {
    expect(
      planContactQuery(
        state({
          search: ' joão ',
          tagIds: [TAG],
          channelIds: [CHANNEL, CHANNEL_2],
          page: 3,
        })
      )
    ).toEqual({
      mode: 'rpc',
      params: {
        p_tag_ids: [TAG],
        p_search: 'joão',
        p_limit: CONTACTS_PAGE_SIZE,
        p_offset: 75,
        p_channel_ids: [CHANNEL, CHANNEL_2],
      },
    });
  });

  it('busca só de espaços não vira termo', () => {
    expect(
      planContactQuery(state({ search: '   ', tagIds: [TAG] }))
    ).toMatchObject({
      params: { p_search: null },
    });
  });

  it('pageSize customizado manda no limite e no offset dos dois caminhos', () => {
    expect(planContactQuery(state({ page: 1, pageSize: 10 }))).toMatchObject({
      mode: 'table',
      from: 10,
      to: 19,
    });
    expect(
      planContactQuery(state({ page: 1, pageSize: 10, channelIds: [CHANNEL] }))
    ).toMatchObject({
      params: { p_limit: 10, p_offset: 10 },
    });
  });
});

describe('hasActiveContactFilters', () => {
  it('reconhece cada filtro isoladamente', () => {
    expect(
      hasActiveContactFilters({ search: '', tagIds: [], channelIds: [] })
    ).toBe(false);
    expect(
      hasActiveContactFilters({ search: '  ', tagIds: [], channelIds: [] })
    ).toBe(false);
    expect(
      hasActiveContactFilters({ search: 'ana', tagIds: [], channelIds: [] })
    ).toBe(true);
    expect(
      hasActiveContactFilters({ search: '', tagIds: [TAG], channelIds: [] })
    ).toBe(true);
    expect(
      hasActiveContactFilters({ search: '', tagIds: [], channelIds: [CHANNEL] })
    ).toBe(true);
  });
});
