// Cliente de service-role da rota de auto-resposta da IA.
//
// Reexporta o canônico de `@/lib/supabase/admin`. O arquivo continua
// existindo porque os testes deste módulo mockam `./admin-client` por
// caminho relativo — e porque o import local documenta que este caminho
// roda sem `auth.uid()` (o webhook de entrada não tem sessão).
export { supabaseAdmin } from '@/lib/supabase/admin';
