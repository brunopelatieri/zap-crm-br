// Cliente de service-role do motor de Flows.
//
// Reexporta o canônico de `@/lib/supabase/admin`. Mantido como arquivo
// próprio porque vários módulos e testes já o importam por este caminho.
export { supabaseAdmin } from '@/lib/supabase/admin';
