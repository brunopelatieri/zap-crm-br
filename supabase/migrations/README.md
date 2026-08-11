# Migrações — convenções e notas

## Numeração

Os arquivos são numerados sequencialmente (`NNN_nome.sql`) e aplicados nessa
ordem — várias migrações posteriores dependem de schema/funções criadas em
migrações anteriores, então a ordem numérica **é** a ordem de aplicação, sem
exceção.

A numeração acompanha (mas não é 1:1 com) as SPECs em `docs/spec-NNN-*.md`:
cada SPEC pode gerar zero, uma ou várias migrações, dependendo de quanto de
schema ela precisa.

## Por que não existe `043_*.sql`

Não é um arquivo perdido nem uma migração pulada por engano — **nunca
existiu**. [SPEC 043](../../docs/spec-043-quadro-de-atribuicao.md) (Quadro de
Atribuição / Team View no Inbox) foi implementada só em
UI/frontend (`src/components/inbox/assignment-board`), reaproveitando a RLS
que já existia desde a migração `039_conversation_assignment.sql`. Sem
mudança de schema, não houve migração `043` — a numeração de SPEC ficou
"reservada" e a próxima migração real (`044_messaging_limit_and_quota.sql`)
já nasceu associada à SPEC seguinte (044, audiência multiformato e triagem).

Ao aplicar as migrações num projeto novo (`apply_migration` uma a uma, na
ordem), o salto de `042` para `044` é esperado — não indica arquivo
faltando.
