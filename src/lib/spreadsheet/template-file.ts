/**
 * Modelo de planilha oferecido no passo 2 (SPEC 044 §3.1).
 *
 * Gerado a partir de `SPREADSHEET_COLUMNS` em vez de ser um arquivo
 * estático em `public/`: um modelo estático envelhece em silêncio no
 * dia em que uma coluna muda de nome, e o usuário só descobre pelo
 * "nenhuma coluna de telefone encontrada" — depois de montar a
 * planilha inteira.
 *
 * As linhas de exemplo usam números claramente fictícios (prefixo
 * 9 0000-000x): quem esquecer de apagá-las importa telefones que a
 * triagem já marca como não-WhatsApp, em vez de disparar para alguém.
 */

import { SPREADSHEET_COLUMNS } from './parse-csv';

export const AUDIENCE_TEMPLATE_FILENAME = 'modelo-audiencia-zap-crm.csv';

/** Uma linha por coluna de `SPREADSHEET_COLUMNS`, na mesma ordem. */
const EXAMPLE_ROWS: string[][] = [
  [
    '5511900000001',
    'Maria Souza',
    'maria@exemplo.com.br',
    'Loja da Maria',
    'cliente;vip',
  ],
  [
    '5521900000002',
    'João Lima',
    'joao@exemplo.com.br',
    'Lima Serviços',
    'lead',
  ],
];

/**
 * Monta o CSV do modelo. Sem BOM — quem baixa o arquivo o acrescenta
 * (o Excel precisa dele para os acentos); o parser o absorve no `trim`
 * de `readCsvTable` de qualquer forma.
 *
 * CRLF por ser o que o Excel espera ao abrir um `.csv` no Windows.
 */
export function buildAudienceTemplateCsv(): string {
  const header = SPREADSHEET_COLUMNS.map((column) => column.aliases[0]);
  return [header, ...EXAMPLE_ROWS].map((row) => row.join(',')).join('\r\n');
}
