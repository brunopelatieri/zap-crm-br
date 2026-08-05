'use client';

// ============================================================
// use-deal-draft — camada de dados do picker de negócios.
//
// Responsável por: carregar os funis da conta, carregar as etapas do
// funil selecionado (com cache), manter o rascunho do formulário e
// executar a criação.
//
// A UI (deal-picker-dialog) não fala com o Supabase — só consome este
// hook. Mesma separação do tag-picker: mantém o componente de
// apresentação testável sem mock de rede.
//
// Diferente do picker de etiquetas, aqui NADA é otimista: o `id` do
// negócio e o `stage` embutido só existem depois do round-trip, e
// criar um negócio duplicado por engano deixa lixo visível no board.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useAccountMembers } from '@/hooks/use-account-members';
import {
  PG_FOREIGN_KEY_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  createDeal,
  fetchPipelines,
  fetchStages,
} from '@/lib/pipelines/deals';
import type { Contact, Deal, Pipeline, PipelineStage, Profile } from '@/types';

export interface DealDraft {
  pipelineId: string;
  stageId: string;
  title: string;
  /** String, não number — é input controlado. Convertido no submit. */
  value: string;
  currency: string;
  /** '' = não atribuído. Normalizado para null no insert. */
  assignedTo: string;
}

interface UseDealDraftOptions {
  /** Contato aberto no modal, ou null quando fechado. */
  contact: Contact | null;
  /** Chamado com o negócio criado, para o trigger inserir na lista. */
  onCreated: (deal: Deal) => void;
  /** Fecha o modal. Só é chamado no sucesso — ver §5.3 do SPEC. */
  onClose: () => void;
}

export interface UseDealDraftResult {
  pipelines: Pipeline[];
  /** Etapas do funil selecionado, já ordenadas por `position`. */
  stages: PipelineStage[];
  members: Profile[];
  loadingPipelines: boolean;
  loadingStages: boolean;
  submitting: boolean;
  draft: DealDraft;
  setDraft: (patch: Partial<DealDraft>) => void;
  /** Todos os campos obrigatórios preenchidos e nenhum envio em voo. */
  canSubmit: boolean;
  submit: () => Promise<void>;
}

/** Lê o código de erro do Postgres/PostgREST de um `unknown`. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Último funil usado no picker, para poupar o agente de reescolher o
 * mesmo funil a cada negócio. Mesmo padrão de `inbox/page.tsx`
 * (`CONTACT_PANEL_STORAGE_KEY`) e `flow-editor-shell.tsx`: chave
 * própria, leitura/escrita sempre em `try/catch` — `localStorage`
 * lança em navegação privativa e em contexto sandboxed. Diferente
 * daqueles dois casos, aqui não há risco de mismatch de hidratação:
 * o valor só é lido dentro de `loadPipelines`, chamado a partir de um
 * `useEffect` (pós-montagem), nunca durante o render inicial.
 */
const LAST_PIPELINE_STORAGE_KEY = 'zapcrm:inbox:last-pipeline-id';

function readLastPipelineId(): string | null {
  try {
    return localStorage.getItem(LAST_PIPELINE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastPipelineId(id: string): void {
  try {
    localStorage.setItem(LAST_PIPELINE_STORAGE_KEY, id);
  } catch {
    // Persistência é best-effort; ignora falhas de storage.
  }
}

const EMPTY_DRAFT: DealDraft = {
  pipelineId: '',
  stageId: '',
  title: '',
  value: '',
  currency: '',
  assignedTo: '',
};

export function useDealDraft({
  contact,
  onCreated,
  onClose,
}: UseDealDraftOptions): UseDealDraftResult {
  const t = useTranslations('Inbox.dealPicker');
  const tForm = useTranslations('Pipelines.form');
  const { user, accountId, defaultCurrency } = useAuth();

  const contactId = contact?.id ?? null;
  const isOpen = contactId !== null;

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const [loadingStages, setLoadingStages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraftState] = useState<DealDraft>(EMPTY_DRAFT);

  // Etapas por funil. Num ref e não em estado: escrever no cache não
  // deve provocar render, e ele precisa sobreviver às trocas de funil
  // dentro da mesma sessão do modal. Zerado a cada abertura — funis e
  // etapas são configuração, e reabrir é a hora certa de repuxar.
  const stageCacheRef = useRef<Record<string, PipelineStage[]>>({});

  // Fora das deps do reset. `defaultCurrency` chega DEPOIS do primeiro
  // render (o profile resolve por rede); se ele entrasse nas deps, um
  // usuário que abrisse o modal antes disso veria o título já digitado
  // ser apagado quando a moeda da conta finalmente chegasse.
  const defaultCurrencyRef = useRef(defaultCurrency);
  useEffect(() => {
    defaultCurrencyRef.current = defaultCurrency;
  });

  // Mesmo motivo do `onTagsChangedRef` em use-contact-tags: o trigger
  // pode recriar o callback a cada render, e `submit` não deve ganhar
  // identidade nova por causa disso.
  const onCreatedRef = useRef(onCreated);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCreatedRef.current = onCreated;
    onCloseRef.current = onClose;
  });

  const setDraft = useCallback((patch: Partial<DealDraft>) => {
    setDraftState((prev) => {
      const next = { ...prev, ...patch };
      // Trocar de funil invalida a etapa. Manter o `stageId` antigo
      // seria pior que zerar: o insert falharia com 23503 contra um
      // estágio que pertence a outro funil.
      if (
        patch.pipelineId !== undefined &&
        patch.pipelineId !== prev.pipelineId
      ) {
        next.stageId = '';
        // Persiste a escolha manual do agente — só quando ele de fato
        // troca de funil, não quando o load inicial define o default.
        if (patch.pipelineId) writeLastPipelineId(patch.pipelineId);
      }
      return next;
    });
  }, []);

  const membersEnabled = isOpen;
  const { members } = useAccountMembers(membersEnabled);

  // ---- Reset do rascunho a cada abertura -------------------------
  // Sync legítimo dirigido por prop, mesmo padrão do useEffect de
  // reset do deal-form. Depende só de `contact`: ver o comentário do
  // `defaultCurrencyRef` acima.
  useEffect(() => {
    if (!contact) return;
    setDraftState({
      pipelineId: '',
      stageId: '',
      // Pré-preenchido para que o caso comum ("registrar este lead no
      // funil") não exija digitação nenhuma.
      title: contact.name || contact.phone || '',
      value: '',
      currency: defaultCurrencyRef.current,
      assignedTo: '',
    });
  }, [contact]);

  // ---- Carga dos funis -------------------------------------------
  // Compartilhada entre a abertura do modal e o retry após um 23503.
  // `isCancelled` existe para o caso da abertura, onde o cleanup do
  // efeito precisa descartar uma resposta que chegou tarde demais.
  const loadPipelines = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const supabase = createClient();
      setLoadingPipelines(true);
      try {
        const rows = await fetchPipelines(supabase);
        if (isCancelled()) return;
        stageCacheRef.current = {};
        setPipelines(rows);
        // Se o funil salvo ainda existir na conta, reabre nele — senão
        // (funil excluído, ou primeira vez), cai no primeiro sem erro.
        const savedId = readLastPipelineId();
        const initialId = rows.some((p) => p.id === savedId)
          ? (savedId as string)
          : (rows[0]?.id ?? '');
        setDraftState((prev) => ({
          ...prev,
          pipelineId: initialId,
          stageId: '',
        }));
      } catch (err) {
        console.error('[use-deal-draft] falha ao carregar funis:', err);
        if (isCancelled()) return;
        setPipelines([]);
        toast.error(t('failedToLoad'));
      } finally {
        if (!isCancelled()) setLoadingPipelines(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadPipelines(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isOpen, loadPipelines]);

  // ---- Carga das etapas do funil selecionado ---------------------
  const pipelineId = draft.pipelineId;

  useEffect(() => {
    if (!pipelineId) {
      setStages([]);
      return;
    }

    const cached = stageCacheRef.current[pipelineId];
    if (cached) {
      // Volta ao funil anterior não paga round-trip.
      setStages(cached);
      setDraftState((prev) =>
        prev.stageId ? prev : { ...prev, stageId: cached[0]?.id ?? '' }
      );
      return;
    }

    let cancelled = false;
    setLoadingStages(true);

    (async () => {
      try {
        const supabase = createClient();
        const rows = await fetchStages(supabase, pipelineId);
        if (cancelled) return;
        stageCacheRef.current[pipelineId] = rows;
        setStages(rows);
        // `rows` já vem ordenado por `position`, então [0] é a
        // primeira etapa do funil.
        setDraftState((prev) =>
          prev.stageId ? prev : { ...prev, stageId: rows[0]?.id ?? '' }
        );
      } catch (err) {
        console.error('[use-deal-draft] falha ao carregar etapas:', err);
        if (cancelled) return;
        setStages([]);
        toast.error(t('failedToLoad'));
      } finally {
        if (!cancelled) setLoadingStages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pipelineId, t]);

  const canSubmit = useMemo(
    () =>
      !submitting &&
      Boolean(draft.title.trim()) &&
      Boolean(draft.pipelineId) &&
      Boolean(draft.stageId) &&
      Boolean(accountId),
    [accountId, draft.pipelineId, draft.stageId, draft.title, submitting]
  );

  const submit = useCallback(async () => {
    if (!contactId || submitting) return;

    const title = draft.title.trim();
    if (!title || !draft.pipelineId || !draft.stageId) return;

    if (!user) {
      toast.error(tForm('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(tForm('toastNotLinked'));
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      const deal = await createDeal(supabase, {
        userId: user.id,
        accountId,
        pipelineId: draft.pipelineId,
        stageId: draft.stageId,
        contactId,
        title,
        value: parseFloat(draft.value) || 0,
        currency: draft.currency,
        assignedTo: draft.assignedTo || null,
      });

      onCreatedRef.current(deal);
      toast.success(tForm('toastCreated'));
      onCloseRef.current();
    } catch (err) {
      console.error('[use-deal-draft] falha ao criar negócio:', err);
      const code = errorCode(err);

      if (code === PG_FOREIGN_KEY_VIOLATION) {
        // Único caso em que o estado carregado está comprovadamente
        // velho (um admin excluiu o funil/etapa entre o load e o
        // submit). Repuxar é a ação certa, e o agente não tem como
        // adivinhar isso sozinho.
        toast.error(t('stageGone'));
        await loadPipelines();
      } else if (code === PG_INSUFFICIENT_PRIVILEGE) {
        // Não deve acontecer — a UI já é gatada por canSendMessages.
        toast.error(t('onlyAgentsCanCreate'));
      } else {
        toast.error(tForm('toastFailedCreate'));
      }
      // O modal NÃO fecha: fechar descartaria o rascunho e obrigaria
      // o agente a redigitar tudo.
    } finally {
      setSubmitting(false);
    }
  }, [
    accountId,
    contactId,
    draft.assignedTo,
    draft.currency,
    draft.pipelineId,
    draft.stageId,
    draft.title,
    draft.value,
    loadPipelines,
    submitting,
    t,
    tForm,
    user,
  ]);

  return {
    pipelines,
    stages,
    members,
    loadingPipelines,
    loadingStages,
    submitting,
    draft,
    setDraft,
    canSubmit,
    submit,
  };
}
