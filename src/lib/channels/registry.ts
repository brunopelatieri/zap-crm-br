/**
 * O único `switch` por tipo de canal do sistema (PRD 047 §6.3).
 *
 * Todo o resto — inbox, automações, flows, IA — pergunta ao registro
 * qual adaptador usar e trabalha contra a interface. Se aparecer um
 * segundo `if (channel.type === …)` em qualquer outro arquivo, é sinal
 * de que a abstração vazou e que o terceiro canal vai doer.
 */

import type { ChannelAdapter, ChannelType } from './types';
import { whatsappCloudAdapter } from './adapters/whatsapp-cloud';
import { evolutionAdapter } from './adapters/evolution';

/**
 * `Record<ChannelType, …>` obriga, por exaustividade do TypeScript, a
 * registrar um adaptador para cada tipo declarado — um canal não pode
 * existir na matriz de capacidades e não ter implementação.
 */
const ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  whatsapp_cloud: whatsappCloudAdapter,
  whatsapp_qr: evolutionAdapter,
};

export function getAdapter(type: ChannelType): ChannelAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) {
    throw new Error(`no adapter registered for channel type "${type}"`);
  }
  return adapter;
}

/** O tipo tem adaptador utilizável agora? */
export function hasAdapter(type: ChannelType): boolean {
  return ADAPTERS[type] !== undefined;
}
