/**
 * Configuração da integração Evolution Go (PRD 047 §12 / SPEC 048 §7).
 *
 * Nenhuma variável aqui é obrigatória. Sem `EVOLUTION_API_URL` a aba
 * "WhatsApp QRCode" aparece desabilitada com instruções — nunca 503
 * silencioso, nunca some da navegação (é a armadilha "agendamento não
 * dispara, sem erro" do AGENTS.md se repetindo, e este módulo existe
 * para fechá-la logo na leitura do `.env`).
 */

export interface EvolutionConfig {
  apiUrl: string;
  globalApiKey: string;
  maxInstancesPerAccount: number;
  maxInstancesTotal: number;
  instancePrefix: string;
  /** Origem pública para montar a URL de webhook. */
  webhookPublicUrl: string | null;
  requestTimeoutMs: number;
  /**
   * Teto pra `/send/media`. A Evolution BAIXA o arquivo da nossa URL
   * assinada e SOBE pro WhatsApp de forma síncrona, dentro da mesma
   * requisição — ao contrário de `/send/text` (praticamente instantâneo),
   * um vídeo de alguns MB pode facilmente estourar os 15s padrão de
   * `requestTimeoutMs`, abortando o envio do lado do CRM mesmo que a
   * Evolution tivesse terminado um instante depois (visto em produção:
   * "Evolution request failed: This operation was aborted" ao mandar
   * vídeo). Bem mais folgado que o timeout genérico; envios de texto e
   * chamadas de gerência de instância continuam usando `requestTimeoutMs`.
   */
  mediaRequestTimeoutMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/**
 * Lê a configuração do `.env`. Devolve `null` quando `EVOLUTION_API_URL`
 * ou `EVOLUTION_GLOBAL_API_KEY` estão ausentes — as duas variáveis sem
 * as quais NENHUMA chamada à Evolution é possível. Todo o resto tem
 * padrão.
 */
export function readEvolutionConfig(
  env: Record<string, string | undefined> = process.env
): EvolutionConfig | null {
  const apiUrl = env.EVOLUTION_API_URL?.trim();
  const globalApiKey = env.EVOLUTION_GLOBAL_API_KEY?.trim();
  if (!apiUrl || !globalApiKey) return null;

  return {
    // Sem barra no final — os call sites concatenam `${apiUrl}/instance/...`.
    apiUrl: apiUrl.replace(/\/+$/, ''),
    globalApiKey,
    maxInstancesPerAccount: positiveInt(
      env.EVOLUTION_MAX_INSTANCES_PER_ACCOUNT,
      3
    ),
    maxInstancesTotal: positiveInt(env.EVOLUTION_MAX_INSTANCES_TOTAL, 20),
    instancePrefix: env.EVOLUTION_INSTANCE_PREFIX?.trim() || 'zapcrm',
    webhookPublicUrl:
      env.EVOLUTION_WEBHOOK_PUBLIC_URL?.trim() ||
      env.NEXT_PUBLIC_SITE_URL?.trim() ||
      null,
    requestTimeoutMs: positiveInt(env.EVOLUTION_REQUEST_TIMEOUT_MS, 15_000),
    mediaRequestTimeoutMs: positiveInt(
      env.EVOLUTION_MEDIA_REQUEST_TIMEOUT_MS,
      60_000
    ),
  };
}

export function isEvolutionConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return readEvolutionConfig(env) !== null;
}
