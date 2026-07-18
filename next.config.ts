import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Cabeçalhos de segurança básicos aplicados a toda resposta.
 *
 * O CSP é enviado como `Content-Security-Policy-Report-Only` para que
 * o navegador reporte violações no console sem bloquear nada — quando
 * tivermos confiança de que nada legítimo o dispara (dois deploys, um
 * passe em toda rota), trocamos a chave para `Content-Security-Policy`
 * para aplicar de fato.
 *
 * O restante dos cabeçalhos são bloqueios diretos, seguros para
 * aplicar hoje:
 *   - HSTS: só faz sentido em HTTPS (é no-op em http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     hardening OWASP básico, sem custo de comportamento.
 *   - Permissions-Policy: não usamos câmera / microfone / etc, então
 *     negamos. Um comprometimento na cadeia de suprimentos ou um
 *     plugin esquecido não consegue reativá-los silenciosamente.
 */
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    // O microfone é permitido para same-origin (`self`) para que o
    // compositor da caixa de entrada possa gravar notas de voz via
    // MediaRecorder. Todo o resto permanece negado — uma dependência
    // comprometida não consegue capturar silenciosamente a câmera /
    // geolocalização / etc.
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      // O Next.js precisa de 'unsafe-inline' para seu script de
      // hidratação inline e de 'unsafe-eval' em dev + algumas
      // otimizações de produção. CSP baseado em nonce é um projeto
      // futuro.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + atributos de estilo inline em muitos componentes.
      "style-src 'self' 'unsafe-inline'",
      // Avatares em bucket público do Supabase, avatares de contato
      // (URLs https arbitrárias que podem ser coladas pela UI),
      // imagens OG, data URLs para pequenos assets inline.
      "img-src 'self' data: blob: https:",
      // Prévias de mídia de saída (blob: do MediaRecorder + seletor
      // de arquivo) e áudio/vídeo em bucket público do Supabase que a
      // caixa de entrada renderiza.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // REST + realtime (WSS) do Supabase. Todas as chamadas à API da
      // Meta acontecem server-side, então graph.facebook.com não
      // pertence aqui.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
] as const;

const nextConfig: NextConfig = {
  /**
   * Política de Cache-Control.
   *
   * Por que isso existe:
   *   O CDN da Hostinger aplicava `s-maxage=31536000` (1 ano) a
   *   páginas HTML pré-renderizadas por padrão. Quando um novo deploy
   *   enviava novos hashes de chunk do Turbopack, a edge continuava
   *   servindo HTML de um ano atrás referenciando nomes de arquivo de
   *   chunk que já não existiam mais em disco — resultado: HTML 200,
   *   mas cada /_next/static/*.js e .css voltava 404, e a página
   *   renderizava sem estilo. Modo privado/anônimo não ajudava porque
   *   o cache é server-side.
   *
   * Estratégia:
   *   - /_next/static/* — deixamos para o Next. Chunks de dev do
   *     Turbopack podem ficar obsoletos se forçarmos cache imutável
   *     aqui; o Next já emite os cabeçalhos corretos de produção para
   *     assets com hash.
   *   - /api/*          — no-store. Respostas da API são por usuário
   *     e nunca devem ser compartilhadas entre requisições na edge.
   *   - Todo o resto — público, s-maxage breve + stale-while-
   *     revalidate generoso. A edge serve instantaneamente do cache
   *     nos primeiros 5 min, depois retorna o conteúdo em cache
   *     enquanto atualiza em segundo plano por até 24 h. A defasagem
   *     de hash de chunk de um deploy se autocorrige em ~5 min sem
   *     latência visível para o usuário.
   *
   *   Nota: rotas dinâmicas do dashboard (/inbox, /contacts,
   *   /pipelines, /broadcasts, etc.) são renderizadas no servidor por
   *   requisição — o Next.js e a autenticação do Supabase já impedem
   *   que sejam servidas de um cache compartilhado. O s-maxage aqui é
   *   um teto; o Next.js e o middleware de autenticação ainda definem
   *   `private` / `no-store` para respostas por usuário.
   *
   * Os cabeçalhos de segurança são adicionados por uma regra catch-all
   * separada abaixo — o Next.js mescla os cabeçalhos de cada regra
   * correspondente, então eles se aplicam a toda resposta,
   * independente de qual regra de cache foi aplicada.
   */
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/:path((?!_next/static|_next/image|api).*)',
        headers: [
          {
            key: 'Cache-Control',
            value:
              'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
          },
        ],
      },
      {
        // Cabeçalhos de segurança em toda resposta, incluindo assets
        // de /_next/static (o nosniff importa lá) e /api/* (HSTS +
        // referrer-policy não fazem mal).
        source: '/:path*',
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
