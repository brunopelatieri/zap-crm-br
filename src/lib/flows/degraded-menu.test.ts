/**
 * O coração da F6.2 (SPEC 049 §5.2 / §7.1).
 *
 * Módulo puro: nenhum banco, nenhum canal. O que se prova aqui é que a
 * numeração que o cliente VÊ é a numeração que o matcher CONTA, e que
 * toda ambiguidade devolve `null` em vez de escolher um ramo.
 */

import { describe, it, expect } from 'vitest';
import {
  matchDegradedReply,
  menuOptionsOf,
  optionMarker,
  renderDegradedMenu,
} from './degraded-menu';

const BUTTONS = {
  node_type: 'send_buttons',
  config: {
    text: 'Como posso ajudar?',
    buttons: [
      { reply_id: 'b1', title: 'Falar com vendas', next_node_key: 'vendas' },
      {
        reply_id: 'b2',
        title: 'Segunda via de boleto',
        next_node_key: 'boleto',
      },
      { reply_id: 'b3', title: 'Outro assunto', next_node_key: 'outro' },
    ],
  },
};

const LIST = {
  node_type: 'send_list',
  config: {
    text: 'Escolha um pedido',
    button_label: 'Ver opções',
    sections: [
      {
        title: 'Recentes',
        rows: [
          { reply_id: 'o1', title: 'Pedido 1001', next_node_key: 'ord_1' },
          { reply_id: 'o2', title: 'Pedido 1002', next_node_key: 'ord_2' },
        ],
      },
      {
        title: 'Antigos',
        rows: [
          { reply_id: 'o3', title: 'Pedido 0999', next_node_key: 'ord_3' },
        ],
      },
    ],
  },
};

describe('menuOptionsOf', () => {
  it('preserva a ordem de cfg.buttons', () => {
    expect(menuOptionsOf(BUTTONS).map((o) => o.next_node_key)).toEqual([
      'vendas',
      'boleto',
      'outro',
    ]);
  });

  it('achata as seções do send_list na ordem em que aparecem', () => {
    expect(menuOptionsOf(LIST).map((o) => o.title)).toEqual([
      'Pedido 1001',
      'Pedido 1002',
      'Pedido 0999',
    ]);
  });

  it('devolve vazio para nós que não são menu', () => {
    expect(
      menuOptionsOf({ node_type: 'send_message', config: { text: 'oi' } })
    ).toEqual([]);
    expect(menuOptionsOf({ node_type: 'send_buttons', config: {} })).toEqual(
      []
    );
    expect(
      menuOptionsOf({ node_type: 'send_list', config: { sections: [{}] } })
    ).toEqual([]);
  });
});

describe('renderDegradedMenu', () => {
  it('numera as opções na ordem exibida', () => {
    expect(renderDegradedMenu(BUTTONS)).toBe(
      [
        'Como posso ajudar?',
        '',
        '1\u{FE0F}\u{20E3} Falar com vendas',
        '2\u{FE0F}\u{20E3} Segunda via de boleto',
        '3\u{FE0F}\u{20E3} Outro assunto',
      ].join('\n')
    );
  });

  it('header_text vira a primeira linha e footer_text a última', () => {
    const text = renderDegradedMenu({
      node_type: 'send_buttons',
      config: {
        ...BUTTONS.config,
        header_text: 'Atendimento',
        footer_text: 'Responda com o número',
      },
    })!;
    expect(text.startsWith('Atendimento\n\nComo posso ajudar?')).toBe(true);
    expect(text.endsWith('\n\nResponda com o número')).toBe(true);
  });

  it('achata as seções do send_list e ignora o button_label', () => {
    const text = renderDegradedMenu(LIST)!;
    expect(text).toContain('1\u{FE0F}\u{20E3} Pedido 1001');
    expect(text).toContain('3\u{FE0F}\u{20E3} Pedido 0999');
    // O rótulo do botão "ver opções" não existe quando as opções já
    // estão na tela.
    expect(text).not.toContain('Ver opções');
    // O título da seção não é escolha — não vira opção numerada.
    expect(text).not.toContain('Recentes');
  });

  it('NÃO interpola {{vars.x}} — o caminho nativo também não interpola', () => {
    const text = renderDegradedMenu({
      node_type: 'send_buttons',
      config: {
        text: 'Oi {{vars.name}}, o que deseja?',
        buttons: [{ reply_id: 'b1', title: 'Falar', next_node_key: 'x' }],
      },
    })!;
    expect(text).toContain('{{vars.name}}');
  });

  it('devolve null quando não há opção alguma', () => {
    expect(
      renderDegradedMenu({
        node_type: 'send_buttons',
        config: { text: 'Sem botões', buttons: [] },
      })
    ).toBeNull();
    expect(
      renderDegradedMenu({ node_type: 'send_message', config: { text: 'x' } })
    ).toBeNull();
  });

  it('marcador vira "11." depois do décimo (o emoji de teclado acaba)', () => {
    expect(optionMarker(0)).toBe('1\u{FE0F}\u{20E3}');
    expect(optionMarker(9)).toBe('\u{1F51F}');
    expect(optionMarker(10)).toBe('11.');
  });
});

describe('matchDegradedReply — regra 1 (índice 1-based)', () => {
  it('casa o número na ordem exibida', () => {
    expect(matchDegradedReply(BUTTONS, '1')).toBe('vendas');
    expect(matchDegradedReply(BUTTONS, '2')).toBe('boleto');
    expect(matchDegradedReply(BUTTONS, '3')).toBe('outro');
  });

  it('conta através das seções no send_list', () => {
    expect(matchDegradedReply(LIST, '3')).toBe('ord_3');
  });

  it('tolera espaço em volta e pontuação de fim', () => {
    expect(matchDegradedReply(BUTTONS, '  2  ')).toBe('boleto');
    expect(matchDegradedReply(BUTTONS, '2.')).toBe('boleto');
    expect(matchDegradedReply(BUTTONS, '2)')).toBe('boleto');
  });

  it('índice fora da faixa não casa', () => {
    expect(matchDegradedReply(BUTTONS, '0')).toBeNull();
    expect(matchDegradedReply(BUTTONS, '4')).toBeNull();
    expect(matchDegradedReply(BUTTONS, '99')).toBeNull();
  });
});

describe('matchDegradedReply — regra 2 (emoji de teclado numérico)', () => {
  it('casa o emoji que o próprio menu imprimiu', () => {
    expect(matchDegradedReply(BUTTONS, '2\u{FE0F}\u{20E3}')).toBe('boleto');
  });

  it('casa o emoji sem o seletor de variação (alguns teclados omitem)', () => {
    expect(matchDegradedReply(BUTTONS, '3\u{20E3}')).toBe('outro');
  });

  it('🔟 é o décimo item', () => {
    const ten = {
      node_type: 'send_list',
      config: {
        sections: [
          {
            rows: Array.from({ length: 10 }, (_, i) => ({
              reply_id: `r${i}`,
              title: `Opção ${i + 1}`,
              next_node_key: `n${i + 1}`,
            })),
          },
        ],
      },
    };
    expect(matchDegradedReply(ten, '\u{1F51F}')).toBe('n10');
  });
});

describe('matchDegradedReply — regra 3 (rótulo exato)', () => {
  it('ignora caixa e acento', () => {
    expect(matchDegradedReply(BUTTONS, 'segunda via de boleto')).toBe('boleto');
    expect(matchDegradedReply(BUTTONS, 'SEGUNDA VIA DE BOLETO')).toBe('boleto');
    expect(
      matchDegradedReply(
        {
          node_type: 'send_buttons',
          config: {
            buttons: [
              {
                reply_id: 'b1',
                title: 'Endereço da matriz',
                next_node_key: 'e',
              },
              { reply_id: 'b2', title: 'Outro', next_node_key: 'o' },
            ],
          },
        },
        'endereco da matriz'
      )
    ).toBe('e');
  });

  it('colapsa espaço repetido', () => {
    expect(matchDegradedReply(BUTTONS, 'Segunda   via  de boleto')).toBe(
      'boleto'
    );
  });

  it('dois rótulos idênticos são ambiguidade do flow, não escolha do cliente', () => {
    const dupe = {
      node_type: 'send_buttons',
      config: {
        buttons: [
          { reply_id: 'b1', title: 'Suporte', next_node_key: 'sup_a' },
          { reply_id: 'b2', title: 'Suporte', next_node_key: 'sup_b' },
        ],
      },
    };
    expect(matchDegradedReply(dupe, 'suporte')).toBeNull();
  });
});

describe('matchDegradedReply — regra 4 (prefixo inequívoco)', () => {
  it('casa o prefixo quando só uma opção começa por ele', () => {
    expect(matchDegradedReply(BUTTONS, 'segunda')).toBe('boleto');
    expect(matchDegradedReply(BUTTONS, 'Falar')).toBe('vendas');
  });

  it('prefixo ambíguo NÃO casa com nenhum — o reprompt é a resposta certa', () => {
    const ambiguous = {
      node_type: 'send_buttons',
      config: {
        buttons: [
          { reply_id: 'b1', title: 'Vendas', next_node_key: 'v1' },
          { reply_id: 'b2', title: 'Vendas corporativas', next_node_key: 'v2' },
        ],
      },
    };
    expect(matchDegradedReply(ambiguous, 'vendas corporativas')).toBe('v2');
    // Exato ganha do prefixo; "vendas" sozinho é ambíguo e não casa.
    expect(matchDegradedReply(ambiguous, 'venda')).toBeNull();
  });

  it('rótulo exato ganha do prefixo de outro item', () => {
    const overlap = {
      node_type: 'send_buttons',
      config: {
        buttons: [
          { reply_id: 'b1', title: 'Vendas', next_node_key: 'v1' },
          { reply_id: 'b2', title: 'Vendas corporativas', next_node_key: 'v2' },
        ],
      },
    };
    expect(matchDegradedReply(overlap, 'Vendas')).toBe('v1');
  });

  it('sufixo ou palavra do meio não casam — só prefixo', () => {
    expect(matchDegradedReply(BUTTONS, 'boleto')).toBeNull();
    expect(matchDegradedReply(BUTTONS, 'via de')).toBeNull();
  });
});

describe('matchDegradedReply — regra 5 (nada casou)', () => {
  it('texto solto devolve null', () => {
    expect(matchDegradedReply(BUTTONS, 'xyz')).toBeNull();
    expect(matchDegradedReply(BUTTONS, 'quero falar com alguém')).toBeNull();
  });

  it('vazio devolve null', () => {
    expect(matchDegradedReply(BUTTONS, '')).toBeNull();
    expect(matchDegradedReply(BUTTONS, '   ')).toBeNull();
  });

  it('nó sem opções devolve null', () => {
    expect(
      matchDegradedReply(
        { node_type: 'send_buttons', config: { buttons: [] } },
        '1'
      )
    ).toBeNull();
    expect(
      matchDegradedReply({ node_type: 'collect_input', config: {} }, '1')
    ).toBeNull();
  });
});
