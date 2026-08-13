# WP-09 — Cerrar la migración multi-tenant: `tenantId` a NOT NULL

## Qué se ha hecho ya (en este PR, sin acceso a producción)

La migración `20260724130000_multi_tenant_phase0` (KAIA-4258) añadió una
columna `tenant_id` **nullable** a cada tabla client-scoped y rellenó las
filas existentes con un tenant `'default'`, dejando dicho a "el API refactor
(KAIA-4267) la pasará a NOT NULL cuando termine el rollout" — pero ningún
punto de escritura de la aplicación llegó a fijar `tenantId` al crear una
fila nueva. Resultado: cada `ChatbotClient` / `ChatbotActivity` /
`ChatbotConfigStep` / etc. creado desde esa migración ha seguido
naciendo con `tenant_id = NULL`, exactamente igual que las filas
anteriores a la migración.

Este PR corrige eso a nivel de aplicación:

- `portal/src/lib/tenant.ts` — constante `DEFAULT_TENANT_ID`, el mismo
  UUID que la migración Phase 0 sembró (`00000000-0000-0000-0000-000000000001`).
  No existe todavía un flujo de alta multi-tenant real, así que todo
  cliente nuevo pertenece a este tenant único hasta que exista uno.
- Todos los `.create()` / `.upsert()` que crean una fila client-scoped
  ahora propagan `tenantId` (del cliente resuelto, o `DEFAULT_TENANT_ID`
  al crear el `ChatbotClient` original en el intake): intake route,
  `wizard-client.ts`, `wizard-review.ts`, `onboarding-actions.ts` (ambas
  copias, portal y admin), `internal/activity/route.ts`,
  `internal/wizard-abandoned/fire/route.ts`.

Esto **para la sangría** — ninguna fila nueva debería volver a nacer con
`tenant_id = NULL` a partir de este PR. No toca el dato histórico ni el
esquema (`schema.prisma` sigue declarando `tenantId` como nullable, a
propósito — ver más abajo).

## Qué falta y por qué no se ha aplicado desde aquí

Cerrar la migración (columna `NOT NULL` de verdad) requiere:

1. Correr `01-audit.sql` contra producción para confirmar cuántas filas
   siguen con `tenant_id = NULL` y, sobre todo, cuántos `Tenant` distintos
   existen hoy — un backfill a ciegas al tenant `'default'` sería
   incorrecto si ya existe más de un tenant real.
2. Confirmar que el fix de este PR lleva desplegado un ciclo completo
   (para no competir con una instancia vieja que todavía no lo tiene).
3. Aplicar `02-migration.sql` (backfill de los restos + `DEFAULT` a nivel
   de columna como red de seguridad + `ALTER COLUMN ... SET NOT NULL`)
   contra la conexión directa (`DIRECT_URL`, no el pool de PgBouncer — ver
   el comentario en `datasource db` de `schema.prisma`, KAIA-14409).
4. Solo entonces: quitar el `?` de `tenantId` en `schema.prisma` para los
   8 modelos "Group A" y correr `prisma generate`, en un PR aparte.

Nada de esto se puede verificar desde este sandbox — `DATABASE_URL` apunta
a `localhost:55432`, inalcanzable. Este es el mismo límite que ha aplicado
a cada WP de este sprint que toca la base de datos.

## Los tres ficheros

- **`01-audit.sql`** — solo lectura. Correr primero, pegar el resultado en
  el PR/ticket antes de que nadie ejecute `02-migration.sql`.
- **`02-migration.sql`** — backfill + `DEFAULT` + `NOT NULL` para las 8
  tablas "Group A" (siempre client-scoped: `ChatbotClient`,
  `ChatbotClientUser`, `ChatbotActivity`, `ChatbotConversation`,
  `ChatbotConfigStep`, `ChatbotConfigStepAudit`, `ClientProduct`,
  `ClientProductAudit`). Deliberadamente NO toca `IntakeSubmission`,
  `OperatorNotification` ni `N8nExecution` ("Group B") — esas tres pueden
  representar legítimamente un evento global sin cliente asociado, así
  que `tenant_id` se queda nullable para ellas.
- **`03-rollback.sql`** — inversa de la parte de esquema (no de-hace el
  backfill; toma una copia de seguridad antes de aplicar `02-migration.sql`
  si necesitas recuperación punto-en-el-tiempo real).

Este directorio vive fuera de `prisma/migrations/` a propósito — así
`prisma migrate deploy` nunca la recoge sola. Cuando alguien con acceso a
producción esté listo, el paso 4 de arriba es: renombrar
`02-migration.sql` a un directorio con timestamp dentro de
`prisma/migrations/` y correr `npm run prisma:migrate:deploy` (o aplicar
el SQL directamente con `psql` contra `DIRECT_URL`).

## Nota sobre `ChatbotConversation`

Ningún código del portal escribe `ChatbotConversation` (confirmado — no
hay ninguna llamada `chatbotConversation.create` en `portal/src`). Esas
filas las escribe un pipeline externo (n8n / sync de Supabase). El
backfill de filas existentes es seguro, pero el `NOT NULL` que añade
`02-migration.sql` empezará a rechazar cualquier INSERT de ese pipeline
que no incluya `tenant_id` — coordinar con quien mantenga ese pipeline
ANTES de aplicar la migración, no después.
