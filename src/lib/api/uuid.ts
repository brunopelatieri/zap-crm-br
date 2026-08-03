// ============================================================
// Validação de UUID para rotas de API.
//
// Existe para que um path param malformado vire 400 antes de chegar
// ao Postgres — sem isso, `/api/.../foo/claim` produz um 22P02
// ("invalid input syntax for type uuid") que a rota traduz em 500,
// escondendo um erro do cliente atrás de um erro do servidor.
//
// A mesma expressão aparece inline em `src/lib/api/v1/pagination.ts`
// e em `src/app/api/whatsapp/templates/[id]/route.ts`, cada uma com a
// própria justificativa. Este módulo é a versão compartilhada para
// código novo; vale consolidar aquelas duas num passe futuro.
// ============================================================

/**
 * UUID v4 mais a forma mais frouxa que o `gen_random_uuid` do Postgres
 * emite. Não é parsing exaustivo de RFC — o objetivo é só rejeitar
 * payloads fora do formato antes de tocar o banco.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard: `value` tem forma de UUID. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
