/**
 * Layout da área de disparo.
 *
 * Existe por um motivo só: montar o `MessagingLimitProvider` acima de
 * `/broadcasts`, `/broadcasts/new` e `/broadcasts/[id]`, para que o
 * tier da Meta seja buscado UMA vez ao entrar na área — e não a cada
 * passo do wizard (SPEC 044 §4.4).
 */

import type { ReactNode } from 'react';

import { MessagingLimitProvider } from '@/components/broadcasts/messaging-limit-provider';

export default function BroadcastsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <MessagingLimitProvider>{children}</MessagingLimitProvider>;
}
