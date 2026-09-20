# Kairikos — convenciones del repositorio

Portal SaaS multiproducto para pymes. Next.js 14 (App Router) + Prisma + PostgreSQL 16,
desplegado con Docker Compose en una VPS propia. Este documento recoge las reglas que hoy
solo viven como comentarios dentro de los archivos: son poco obvias y romperlas suele
fallar en silencio, no con un error.

## Mapa

```
portal/            La aplicación entera (Next.js + Prisma). Casi todo el trabajo ocurre aquí.
automations/       Workflows de n8n como código: un generador TS por workflow.
scripts/           scheduler.sh — el que de verdad dispara los crons en producción.
docker-compose.yml Producción. Cada variable de entorno debe estar listada aquí explícitamente.
```

Siete productos, identificados por `Product.code`: `chatbot`, `web`, `leads`, `seo`,
`reviews`, `recall`, `prospecting`. El acceso siempre se comprueba con
`isProductContracted(prisma, clientId, code)` (`src/lib/client-product-access.ts`), nunca
mirando tablas a mano. Cuando dos productos comparten una superficie, existe un helper con
la regla: `hasGoogleBusinessConnectAccess` (reviews **o** recall),
`hasLeadsInboxAccess` (leads **o** prospecting). Reutilízalos en vez de repetir el OR.

## Comandos

```bash
npx vitest run                      # tests unitarios — NO es `npm test`
npx vitest run tests/unit/x.test.ts # un archivo
npx tsc --noEmit                    # comprobación de tipos, obligatoria antes de terminar
npm run lint
npm test                            # ¡ojo! esto es Playwright (e2e), no los unitarios
```

Los tests unitarios viven en `portal/tests/unit/**/*.test.ts` y corren en Node, sin DOM.

## Tres trampas que fallan en silencio

Estas tres no dan error: simplemente el código no se ejecuta nunca. Son la causa habitual
de "lo implementé y no pasa nada".

### 1. Un cron nuevo no corre si no se añade a `scripts/scheduler.sh`

`vercel.json` declara horarios, pero **es inerte**: este stack no está en Vercel. El único
disparador real es el contenedor `scheduler`, que recorre la lista `ENDPOINTS` de
`scripts/scheduler.sh` cada 5 minutos. Añadir la ruta ahí es parte de la tarea, no un extra.

Cada endpoint debe ser idempotente y seguro de llamar más veces de las que necesita,
porque es exactamente lo que va a pasar. La lógica de "¿toca ya?" vive en TypeScript
(patrón `isDigestDue` / `isProspectingRunDue`), nunca en la cadencia del scheduler.

### 2. Una variable de entorno nueva necesita tres sitios, no uno

```
portal/.env.example              la documenta
.env de la VPS                   tiene el valor real
docker-compose.yml               la pasa al contenedor  ← el que se olvida
```

Docker Compose **no** expone automáticamente todo el `.env` al contenedor: cada variable
tiene que estar listada en el bloque `environment:` del servicio `app`. Si falta ahí, el
contenedor nunca la ve aunque esté correctamente puesta en la VPS.
(`GOOGLE_PLACES_API_KEY` estuvo así desde su Fase A hasta que se detectó.)

### 3. `prisma migrate dev` está roto en este repo

La shadow database falla al reaplicar migraciones antiguas (`function cuid() does not exist`).
El flujo que sí funciona:

```bash
# 1. editar prisma/schema.prisma, luego:
npx prisma format && npx prisma validate
# 2. escribir a mano prisma/migrations/<AAAAMMDDHHMMSS>_nombre/migration.sql
npx prisma db execute --file prisma/migrations/<dir>/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <dir>
npx prisma generate
```

Cuidado con los nombres de columna al escribir el SQL: los modelos nuevos usan `@map` a
snake_case, pero **los modelos antiguos no lo hacen** — en `ChatbotConversation` la columna
es literalmente `"clientId"`, no `"client_id"`. Comprueba el modelo antes de escribir el DDL.

## Fronteras de la arquitectura

**El portal decide, n8n interpreta plataformas externas.** n8n no tiene acceso de lectura a
esta base de datos: todo entra por rutas `/api/internal/*` autenticadas con `PORTAL_API_KEY`
en la cabecera `x-kairikos-internal-key`, y todo sale por webhooks salientes
(`channel-webhook.ts`, con reintentos y backoff propios).

> **Esta frase describía un objetivo, no la realidad, hasta el 20/09/2026.** Una auditoría de
> la instancia real encontró que el turno del bot lo generaba n8n —prompt escrito a mano en un
> nodo Code y llamada a OpenAI— y que el motor del portal (`/api/internal/channels/*/reply`,
> `chatbot-conversation.ts`) no lo llamaba nadie. Telegram, el widget web y (desde el
> 20/09/2026) el WhatsApp de Meta ya están convertidos; **Messenger e Instagram todavía
> no** — siguen en `meta-multi-tenant.json`, armando el prompt a mano y sin verificar
> la firma de Meta en absoluto. Si tocas canales, mira antes `automations/desplegado/`
> —que es lo que de verdad corre— y `docs/plan-motor-chatbot.md`.
>
> Y hay un prerrequisito que invalida cualquier prueba mientras falte: `PORTAL_API_URL` y
> `PORTAL_API_KEY` **no están definidas en los contenedores de n8n**, así que ninguna llamada
> de n8n al portal ha funcionado nunca. Ver el README de `automations/desplegado/`.
>
> **Incidente de seguridad encontrado el 20/09/2026, sin resolver**: el flujo de WhatsApp
> tenía la `PORTAL_API_KEY` real escrita en texto plano (ya corregido para usar `$env`, pero
> el valor viejo sigue siendo válido y sigue en el historial de git de una rama ya empujada).
> **`PORTAL_API_KEY` debe rotarse en la VPS** antes de dar esto por cerrado — no lo puede
> hacer Claude, el clasificador de modo automático bloquea la lectura del `.env` de
> producción. `META_APP_SECRET` y el verify token de Meta de ese mismo flujo probablemente
> también están expuestos y solo se rotan desde el panel de Meta. Ver el README de
> `automations/desplegado/`.

**El cliente nunca se toma del cuerpo de la petición.** Las rutas internas resuelven
`clientId`/`tenantId` desde un identificador externo (un `conversationId`, un
`phone_number_id`, un `connectionId`). Aceptar un `clientId` que manda el llamante permitiría
escribir en cualquier tenant.

**Tres capas de autenticación, no intercambiables:**

| Superficie | Autenticación |
|---|---|
| `/api/portal/*` | Sesión del cliente (`getSession` + `resolveClientFromSession`) |
| `/api/admin/*` | Sesión de operador (`authenticateAdminRequest`), a veces con TOTP |
| `/api/internal/*` | `PORTAL_API_KEY` por cabecera, comparación en tiempo constante |
| `/api/cron/*` | `Authorization: Bearer ${CRON_SECRET}` |

## Cómo se escribe una integración de IA

Hay ocho construidas y todas siguen el mismo molde: `review-reply-ai.ts`,
`conversation-summary-ai.ts`, `lead-classification-ai.ts`, `chatbot-reply-ai.ts`,
`assistant-ai.ts`, `job-capture-ai.ts`, `seo-content-ai.ts`, `prospecting-brief-ai.ts`.
Cópialo.

- `fetch` directo a la Messages API de Anthropic. Sin SDK.
- **Nunca lanza.** Devuelve un resultado tipado: `{ok:true, ...}` | `{ok:false, error}` |
  `{ok:true, skipped:true, reason:'no_api_key'}`. Sin clave configurada, la función degrada
  con gracia y el que llama sigue funcionando.
- El parseo de la respuesta se aísla en una **función pura exportada** (`parseDigestResponse`,
  `parseLeadClassificationResponse`) para poder testear JSON malformado sin tocar la red.
- **Quita la valla de markdown antes de parsear.** Haiku envuelve el JSON en ` ```json `
  aunque el prompt diga explícitamente que no lo haga; se detectó cuando falló el 100% de un
  barrido real. Ver `stripCodeFence` en `lead-classification-ai.ts`.
- Modelo por defecto `claude-haiku-4-5-20251001`, sobreescribible por variable de entorno.
  Ese override (`ANTHROPIC_*_MODEL`) **no está en `docker-compose.yml`**: en la VPS no llega
  al contenedor y el modelo se cambia en `/admin/portal/settings/anthropic`. Sirve en local.
- El lib de IA **no ve la base de datos ni un `clientId`**: recibe texto y devuelve texto. Quien
  llama reúne el material y decide qué hacer con el resultado.

**Cuando la IA propone algo que el cliente va a confirmar, la ruta no guarda.** `suggest`
(Prospección, Fase A) devuelve rubros y zonas y el cliente los mete en el formulario de
siempre con un clic; el guardado sigue siendo el `PATCH` de siempre. Así una sugerencia mala
no cambia por su cuenta a quién se busca. Vale para cualquier propuesta futura: proponer y
persistir son dos pasos, y el segundo es del cliente.

**Si el servidor va a salir a internet con una URL que escribe el cliente, fíltrala antes.**
Solo `http(s)`, fuera `localhost`, `.local`, `10.*`, `192.168.*`, `172.16–31.*`,
`169.254.169.254` y los hosts sin punto. Y ojo con completar el esquema: anteponer
`https://` a `ftp://archivos.example` da una URL válida cuyo host es `ftp`
(`safePublicUrl` en la ruta `prospecting/campaign/suggest`).

Interpretar es trabajo de IA; reunir señales es trabajo del portal. La generación de contenido
SEO reúne datos ya sincronizados y no llama a APIs externas en vivo dentro del mismo paso.

## Cuando un cliente quiere "dos de algo"

Dos webs, dos fichas de Google, dos líneas de teléfono, dos negocios. Hay dos
formas de venderlo y **la elige el coste marginal**, no la preferencia:

- **La segunda unidad no nos cuesta nada recurrente** → UN contrato con tope
  por tarifa. Es lo que hace `reviews` (`TIER_LOCATION_CAP`, 1/3/10 fichas) y
  lo que debe hacer `prospecting` (`TIER_LEAD_CAP` ya ata el gasto, así que
  una búsqueda más es gratis para nosotros).
- **La segunda unidad cuesta dinero cada mes** → UN CONTRATO POR UNIDAD. Es lo
  que hacen `seo` (rastreo + Search Console + GA4 + generación con IA por web),
  `recall` (un número de Twilio, minutos, transcripción por línea) y `web`.

El porqué de la primera está escrito en `lib/review-locations.ts`: "una factura
variable es justo la ansiedad contra la que se vende este catálogo". Vale
mientras el coste sea nuestro y fijo; cuando es lineal, absorberlo en una tarifa
plana es vender por debajo de coste.

Lo segundo se implementa con el eje multi-instancia: `MULTI_INSTANCE_PRODUCT_CODES`
en `client-product-access.ts`, que es la MISMA lista que excluye el índice único
parcial de `ClientProduct` en Postgres. Son tres capas (índice, checkout, alta de
operador) y hay un test que compara la constante con el predicado de la migración
— separarlas hace reventar el insert, o deja la puerta abierta en silencio.
Ver `docs/plan-multi-instancia-fase-1.md`.

## Datos y persistencia

**Toda fila que escribe un cliente tiene su tabla de auditoría** (`LeadAudit`,
`SeoProfileAudit`, `ProspectingCampaignAudit`, `LeadQualificationProfileAudit`,
`WebQuoteAudit`, `ChatbotConfigStepAudit`). Son append-only. Cuando escriben tanto el cliente
como el operador, se separa con `actorType` + `actorOperatorId`; cuando solo escribe el
cliente, basta un `actorEmail` con la forma `client:<clientId>`.

**Nunca metas un secreto en la auditoría.** El patrón es guardar metadatos:
`{ wordpressUrl, wordpressUsername, hasAppPassword: true }`, jamás la contraseña ni su
ciphertext.

**Cada clase de secreto tiene su propia clave de cifrado.** `GOOGLE_TOKEN_ENCRYPTION_KEY`,
`TWILIO_CREDENTIAL_ENCRYPTION_KEY`, `SEO_CMS_CREDENTIAL_ENCRYPTION_KEY`,
`CHANNEL_CREDENTIAL_ENCRYPTION_KEY`… No se reutiliza una clave para otra cosa. AES-256-GCM
vía `operator-crypto.ts` (`encryptBuffer` / `decryptBuffer`), guardando ciphertext, iv y tag
en tres columnas `Bytes`.

**Las credenciales que gestiona el operador van cifradas en Postgres, no en el `.env`.** El
patrón es una tabla `*OperatorCredential` más una pantalla en `/admin/portal/settings/*`, con
la variable de entorno como respaldo. Así se rotan sin reiniciar el stack.

**Los perfiles de producto se crean vacíos al activar, no solo al primer guardado.** Fase 6
añadió `ensureSeoProfile`/`ensureProspectingCampaign`/`ensureLeadQualificationProfile`
(`product-onboarding.ts`, mismo patrón que `ensureRecallSubscription` para `recall`): la fila
nace en el momento del pago, vacía, desde `activateClientProductFromCheckout` y desde el alta
manual de operador. Las rutas de guardado del cliente (`PATCH /api/portal/seo/profile`, etc.)
siguen creando la fila ellas mismas si no la encuentran — ese `create` perezoso queda como
respaldo, no como el único camino.

**Las columnas de estado son texto libre con los valores documentados en un comentario**, no
enums de Prisma, para que n8n pueda extender sin migración. La validación es de aplicación:
las transiciones permitidas viven en un lib compartido (`leads.ts`, `web-quotes.ts`,
`recall.ts`), no repetidas en cada ruta.

## Rutas y libs

Las rutas son finas: autenticación, validación con Zod, y delegar. La lógica vive en
`src/lib/*.ts`, marcada con `import 'server-only'` cuando no debe llegar al cliente. Si un
componente de cliente necesita la misma comprobación, se repite inline en el componente —
nunca se importa el lib.

Cuando dos llamantes hacen lo mismo, se extrae a una función compartida antes de que
diverjan: `ingestClassifiedLead` (`leads.ts`) la usan tanto la ruta interna como el barrido
de clasificación.

Toda ruta lleva `export const dynamic = 'force-dynamic'` y `export const runtime = 'nodejs'`.

## Comentarios

Este código explica **por qué**, no qué. Los comentarios de cabecera de archivo son largos a
propósito y registran las decisiones y los callejones sin salida, con la referencia del
ticket (`KAIA-####`, `WP-##`, `Fase A/B/C`). Cuando un fallo real se corrige, el motivo se
deja escrito junto al arreglo — hay comentarios que citan el subcódigo exacto de error de
Meta que provocó el cambio. Mantén esa costumbre: ahorra repetir la misma investigación.

Si algo es una limitación conocida y aceptada, escríbelo como tal en el sitio donde se nota,
en vez de dejar que parezca un descuido.

## Workflows de n8n

Viven en `automations/<nombre>/` y se generan, no se escriben a mano:

```
build-flows.ts          genera el JSON (ejecutar con npx tsx)
<nombre>.json           export completo, para importar por la UI
<nombre>.api.json       versión recortada para la API REST
import-to-n8n.mjs       lo empuja a una instancia real
smoke-<nombre>.mjs      aserciones sobre la forma del workflow
README.md               contrato, variables y pasos de configuración
```

Dos restricciones descubiertas en la instancia real: los nodos Code **no pueden usar
`require('crypto')`**, y `respondToWebhook` devuelve `text/html` por defecto (Meta exige
`text/plain` para el eco del handshake).

## Antes de dar algo por terminado

1. `npx tsc --noEmit` limpio.
2. `npx vitest run` — **la suite está entera en verde**. Si algo falla, es tuyo.

   Los dos fallos que este archivo daba por preexistentes ya no existen. Eran del mismo tipo y
   conviene reconocerlo: la ruta pasó de comprobar `isProductContracted(…, 'reviews')` a
   `hasGoogleBusinessConnectAccess` (reviews **o** recall), que consulta el helper **dos veces**,
   y el test seguía usando `mockResolvedValueOnce(false)` — solo caía la primera, la segunda
   devolvía el `true` por defecto y el OR dejaba pasar. Con un helper de acceso compuesto,
   `mockResolvedValueOnce` miente.
3. **Los tests unitarios mockean Prisma**, así que una suite verde no dice nada sobre el
   esquema. Si tocaste el modelo de datos, compruébalo contra el Postgres real.
4. Si añadiste un cron, ¿está en `scheduler.sh`? Si añadiste una variable, ¿está en
   `docker-compose.yml`?
