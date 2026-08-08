'use client';

/**
 * Context do limite de mensageria (SPEC 044 §4.4).
 *
 * Espelha a forma do `AuthProvider` de propósito: o projeto não tem
 * Zustand, Redux nem React Query, e introduzir um gerenciador de estado
 * só para guardar quatro números seria criar um padrão novo onde o
 * existente resolve.
 *
 * Montado no layout de `/broadcasts`, então a lista, o wizard inteiro e
 * a tela de detalhe compartilham UMA busca — atende ao "ao navegar para
 * a rota, buscar o limite" sem refazer a chamada a cada passo.
 *
 * `Infinity` não sobrevive ao JSON, então a rota manda `null` para o
 * tier ilimitado e a reconstituição acontece aqui — assim todo consumidor
 * lida com números, e `remaining >= n` funciona sem caso especial.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { FALLBACK_TIER, tierCap } from '@/lib/whatsapp/messaging-limit';

export interface MessagingLimitValue {
  /** False quando a conta ainda não conectou o WhatsApp. */
  configured: boolean;
  tier: string;
  /** Teto bruto do tier. `Infinity` para ilimitado. */
  tierCap: number;
  /** Teto após margem de segurança — é contra este que se valida. */
  effectiveCap: number;
  usedLast24h: number;
  /** Quanto ainda cabe na janela de 24 h. `Infinity` para ilimitado. */
  remaining: number;
  /** True quando exibimos o último valor conhecido (Meta indisponível). */
  stale: boolean;
  loading: boolean;
  checkedAt: string | null;
  refresh: () => Promise<void>;
}

const FALLBACK_STATE: Omit<MessagingLimitValue, 'refresh'> = {
  configured: false,
  tier: FALLBACK_TIER,
  tierCap: tierCap(FALLBACK_TIER),
  effectiveCap: tierCap(FALLBACK_TIER),
  usedLast24h: 0,
  remaining: tierCap(FALLBACK_TIER),
  stale: true,
  loading: true,
  checkedAt: null,
};

const MessagingLimitContext = createContext<MessagingLimitValue | null>(null);

/** `null` do JSON = sem teto. */
function toNumber(value: number | null | undefined): number {
  return value === null || value === undefined
    ? Number.POSITIVE_INFINITY
    : value;
}

interface ApiResponse {
  configured?: boolean;
  tier?: string;
  tierCap?: number | null;
  effectiveCap?: number | null;
  usedLast24h?: number;
  remaining?: number | null;
  stale?: boolean;
  checkedAt?: string;
}

export function MessagingLimitProvider({ children }: { children: ReactNode }) {
  const [state, setState] =
    useState<Omit<MessagingLimitValue, 'refresh'>>(FALLBACK_STATE);

  // Evita setState depois do unmount quando o usuário sai da área de
  // disparo antes da resposta chegar.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch('/api/whatsapp/messaging-limit');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiResponse = await res.json();

      if (!mountedRef.current) return;

      if (!data.configured) {
        setState({ ...FALLBACK_STATE, loading: false });
        return;
      }

      const tier = data.tier ?? FALLBACK_TIER;
      setState({
        configured: true,
        tier,
        tierCap: toNumber(data.tierCap),
        effectiveCap: toNumber(data.effectiveCap),
        usedLast24h: data.usedLast24h ?? 0,
        remaining: toNumber(data.remaining),
        stale: data.stale ?? false,
        loading: false,
        checkedAt: data.checkedAt ?? null,
      });
    } catch {
      // Rota fora, offline, 429. Mantém o teto restritivo e marca
      // como desatualizado — nunca "sem limite".
      if (!mountedRef.current) return;
      setState((prev) => ({ ...prev, loading: false, stale: true }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<MessagingLimitValue>(
    () => ({ ...state, refresh }),
    [state, refresh]
  );

  return (
    <MessagingLimitContext.Provider value={value}>
      {children}
    </MessagingLimitContext.Provider>
  );
}

/**
 * Lê a cota do context.
 *
 * Fora do provider devolve o estado restritivo em vez de lançar — um
 * componente renderizado por engano fora da área de disparo deve
 * bloquear, não derrubar a página.
 */
export function useMessagingLimit(): MessagingLimitValue {
  const ctx = useContext(MessagingLimitContext);
  if (!ctx) {
    return {
      ...FALLBACK_STATE,
      loading: false,
      refresh: async () => {},
    };
  }
  return ctx;
}
