# Lo que hay DESPLEGADO en n8n — foto del 20/09/2026

Esta carpeta no es un diseño ni un objetivo: es **lo que estaba corriendo** en la
instancia real (`n8n.srv1170607.hstgr.cloud`) el día que se auditó, bajado por su
API. Existe porque el resto de `automations/` describía flujos que no son los que
se ejecutan, y sobre esa ficción se estaban tomando decisiones.

Regla: cuando se cambie un flujo en n8n, se vuelve a exportar aquí. Si esta
carpeta y la instancia se separan, esta carpeta miente y vuelve a empezar el
problema.

## n8n → portal: `PORTAL_API_URL` / `PORTAL_API_KEY` — RESUELTO el 22/09/2026

**Hasta el 22/09/2026 n8n nunca pudo hablar con el portal.** `PORTAL_API_URL` y
`PORTAL_API_KEY` no estaban definidas en `root-n8n-1` ni `root-n8n-worker-1`
(comprobado con `printenv` el 20/09/2026): cada nodo que llama a
`{{ $env.PORTAL_API_URL }}/api/internal/...` construía una URL vacía y reventaba
con *"Invalid URL"*. Por eso producción tenía **0 conversaciones, 0 chatbots
activos, 0 widgets y 0 hitos**: el chatbot no respondía mal, no respondía.

Cómo quedó, para quien tenga que tocarlo:

- n8n **no** se despliega con el pipeline de Hostinger del portal. Vive en
  `/root/docker-compose.yml` de la VPS (proyecto Compose `root`) con su propio
  `/root/.env`. Ningún deploy del portal lo reescribe.
- Las dos variables están en `/root/.env`
  (`PORTAL_API_URL=https://portal.kairikos.cloud`) y listadas en el bloque
  `environment:` de **los dos** servicios, `n8n` y `n8n-worker` — en modo
  `queue` los nodos se ejecutan en el worker, así que ponerla solo en `n8n` no
  sirve.
- Comprobado desde dentro del worker: sin cabecera, 401; con la clave y una
  conexión que no existe, 404 (`not_found`) — la autenticación pasa.

**`PORTAL_API_KEY` está duplicada.** Si se rota en el portal (secreto de GitHub
→ `deploy.yml`), hay que cambiarla también en `/root/.env` y recrear n8n, o
todos los canales que pasan por n8n dejan de contestar sin error visible:

```bash
cd /root && docker compose up -d --no-deps --pull never n8n n8n-worker
```

`--pull never` es a propósito: la imagen no lleva tag, y sin él una recreación
puede actualizar n8n de versión de paso. Recrear corta ~1 minuto las
automatizaciones ajenas a Kairikos que viven en la misma instancia.

## Secreto del webhook de Telegram — APLICADO el 22/09/2026

`telegram-multi-tenant.json` (reexportado, versión `b78b7014` en la instancia)
lleva el cambio de la revisión de seguridad del 22/09/2026:

- El portal registra el webhook con `secret_token`, y Telegram manda en cada
  entrega la cabecera `X-Telegram-Bot-Api-Secret-Token`.
- `Extract Input` la lee (`item.headers['x-telegram-bot-api-secret-token']`) y
  el nodo `POST …/telegram/reply` la reenvía como `webhookSecret`.
- `/api/internal/channels/telegram/reply` contesta **401** si falta o no
  coincide. Antes bastaba con conocer el `connectionId` de la URL para meter
  mensajes y gastar crédito de IA.

Se subió por la API (`PUT /workflows/SpbahgfJqf5FA56o`) aplicando solo esos
dos cambios sobre la versión viva, que coincidía con esta exportación. Una
entrega de prueba con un `connectionId` falso confirmó que `Extract Input`
produce `webhookSecret`; la llamada al portal falló con *Invalid URL* — el
hallazgo de arriba, que sigue sin resolver.

Queda: cada bot conectado **antes** del deploy del portal del 22/09 tiene el
webhook registrado sin secreto y hay que desconectarlo y volver a conectarlo
desde el portal. Según la auditoría del 20/09 no había tráfico real por este
canal, pero conviene mirar la tabla `TelegramConnection`.

## Los siete flujos

| Archivo | Estado | Qué hace |
|---|---|---|
| `webchat-multi-tenant.json` | activo, pero ya no en el camino del widget | **Fase 2a aplicada, superada por la 2b**: el widget habla ahora directo con `/api/public/channels/web/message` — este flujo queda como lo que era antes de la 2a (recibe y traduce), sin tráfico real |
| `telegram-multi-tenant.json` | activo | **Fase 1 aplicada**: recibe de Telegram, el portal contesta (`/channels/telegram/reply`) y n8n envía (`/channels/telegram/send`) |
| `meta-multi-tenant.json` | activo | Messenger e Instagram migrados al motor real; su rama de WhatsApp queda huérfana pero protegida por la verificación de firma |
| `meta-whatsapp-inbound.json` | activo | Recibe de WhatsApp, verifica firma, reparte entre Recall y chatbot, y ya contesta con el motor real (`/channels/whatsapp/reply` + `/send`) |
| `wizard-abandoned.json` | activo | Barrido y aviso de asistente abandonado |
| `config-review-overdue.json` | activo | Barrido y aviso de revisión pendiente del operador |
| `t-0-onboarding-supabase.json` | activo | Onboarding del día 0. **Escribe en Supabase**, la base antigua: no toca este portal |

## Lo que se cambió el 20/09/2026 (fase 0 del plan del motor)

- **Desactivada** la copia duplicada de `wizard_abandoned` (`5Uz1pphrxz7AK5JI`).
  Había dos activas idénticas, con el mismo horario: doble barrido cada 6 horas.
  Queda `w5mLM2GeCkSC36T5`.
- **Desactivado** `config_review_overdue` `svfqyu4IVEYnnnv1`, que llamaba a
  `/api/internal/config-review-overdue/*` — **ruta que no existe en el portal**.
  Devolvía 404 en cada ejecución sin que se notara, porque el nodo está en "no
  fallar nunca". Queda `2yvrN5omfb78K0pE`, que sí llama a las rutas reales
  (`/api/internal/review-overdue/*`).

Copias de seguridad de los dos, tal como estaban antes de desactivarlos, en el
historial de versiones de la propia n8n.

## Lo que sigue pendiente de decisión

1. `meta-whatsapp-inbound.json` apunta a un túnel de desarrollo. O se le pone la
   URL real del portal, o se para: activo y apuntando a una máquina que no está
   levantada es la peor de las dos opciones.
2. `t-0-onboarding-supabase.json` escribe en Supabase. Hoy no alimenta el portal.
3. Hay **dos flujos de Meta activos a la vez** (`meta-multi-tenant` y
   `meta-whatsapp-inbound`). Meta solo llama a una URL, así que uno de los dos
   no recibe nada; hay que mirar en la configuración de la app de Meta cuál es.

## El plan del que esto es la fase 0

`docs/plan-motor-chatbot.md`. Resumen: el cerebro del bot vive hoy en el nodo
Code de estos flujos y en OpenAI, no en el portal, y el motor del portal
(configuración aprobada, historial, base de conocimiento, traspaso a una
persona) no lo ejecuta nadie.

## Fase 1 APLICADA el 20/09/2026 — Telegram lo contesta el portal

`telegram-multi-tenant.json` (ya reexportado) es el flujo con el cerebro
movido al portal:

```
webhook → Extract Input → Has Valid Input?
        → POST /api/internal/channels/telegram/reply     (el portal contesta)
        → Has Reply To Send?                             (reply nulo = persona o tope)
        → POST /api/internal/channels/telegram/send
        → clasificación de leads (sin tocar; la decide la fase 4)
```

Sale: `Get Client Context`, `Context OK?`, `Build System Prompt`, `Call LLM
(OpenAI)`, `Format Response`, y los dos `Log … Message` — estos últimos porque
`/reply` ya guarda los dos turnos, y dejarlos duplicaría el transcript.

Detalles que importan al revisarlo:

- El tiempo máximo del nodo del portal sube a 30 s: reúne la configuración
  aprobada y la base de conocimiento antes de llamar al modelo, mientras que
  el nodo de OpenAI al que sustituye tenía 20 s.
- `reply: null` **no es un fallo**: significa que una persona tiene la
  conversación o que el chatbot agotó su tope del mes. En los dos casos el
  turno del cliente ya quedó guardado y no hay nada que enviar. Por eso el
  portal responde 200 y no 503: un 503 invitaría a reintentar.
- La clasificación de leads sigue llamando a OpenAI y ahora toma el
  `conversationId` de la respuesta de `/reply` y el texto de `Extract Input`.

Se le activó además el guardado de datos de las ejecuciones (`saveDataSuccessExecution: all`)
para poder inspeccionar la prueba con el bot real; se puede quitar después.

Vuelta atrás: el historial de versiones de la propia n8n guarda el flujo
anterior, con sus dieciséis nodos.

## Fase 2a APLICADA el 20/09/2026 — el widget lo contesta el portal

`webchat-multi-tenant.json`: el flujo llama a `/api/internal/channels/web/reply`
y `Format Response` solo traduce la respuesta al contrato que espera el widget
(`{ success: true, data: { reply, sessionId, timestamp, mode, contactIntent } }`),
así que **ninguna web de cliente hay que tocarla**.

- `mode` dice de dónde salió la respuesta: `portal` (normal), `human` (una
  persona tiene la conversación), `cap` (el chatbot agotó su tope del mes) o
  `fallback` (el portal falló y se contesta algo digno igualmente).
- Los textos de `human`, `cap` y `fallback` están escritos en ese nodo y son
  una decisión de producto: revísalos.
- `Widget Desconocido?` distingue 404/403 del portal (token que no existe o
  widget apagado) del resto de fallos, que sí merecen una respuesta.

## WhatsApp de Meta — confirmado y corregido el 20/09/2026

La pantalla de configuración de Meta (WhatsApp → Configuration → Webhook) apunta
a `/webhook/meta-whatsapp`, que es la ruta exacta de **`meta-whatsapp-inbound.json`**,
no la de `meta-multi-tenant`. Es decir: todo el WhatsApp real de un cliente entra
por aquí, y `meta-multi-tenant` está activo pero huérfano para este canal —
nadie lo invoca.

Se decidió mantener `meta-whatsapp-inbound` como base para WhatsApp, no
`meta-multi-tenant`, porque **verifica la firma HMAC de Meta** (SHA-256 escrito
a mano, ya que los nodos Code no pueden usar `require('crypto')`) y
`meta-multi-tenant` no verifica nada en su rama de WhatsApp — cualquiera podría
mandarle mensajes falsos.

**Hallazgo grave al revisarlo a fondo: tenía la clave real del portal escrita en
texto plano.** El nodo `X-Kairikos-Internal-Key` traía el valor literal de
`PORTAL_API_KEY`, no una referencia `$env`, a diferencia de todos los demás
flujos. Confirmado comparándolo contra el `.env` real sin imprimirlo. Ese
archivo llevaba commiteado desde el 8030def, en una rama ya empujada a GitHub
(PR #218) — la clave estuvo expuesta en el remoto.

Aplicado el mismo día:
- El nodo ya usa `$env.PORTAL_API_KEY` y `$env.PORTAL_API_URL`, igual que el
  resto de flujos.
- **Pendiente y urgente, y no lo puede hacer nadie más que el propietario**:
  rotar `PORTAL_API_KEY` en la VPS (bloqueado para mí por el clasificador de
  modo automático al intentar leer el `.env` de producción — "Production
  Reads"). Hasta que se rote, el valor expuesto en el historial de git sigue
  siendo válido.
- `META_APP_SECRET` y los verify tokens **ya no están hardcodeados**
  (24/09/2026). Estaban en texto plano dentro de `Verify Signature` y
  `Check Verify Token` de los dos flujos de Meta, así que rotar el secreto
  obligaba a editar nodos a mano y el valor nuevo volvía a quedar a la vista
  de cualquiera con acceso a n8n.

  Ahora los flujos leen tres variables de entorno, puestas en `/root/.env` de
  la VPS y listadas en los servicios `n8n` y `n8n-worker`:

  | variable | dónde se usa |
  |---|---|
  | `META_APP_SECRET` | la firma HMAC, en los dos flujos |
  | `META_VERIFY_TOKEN_WHATSAPP` | `meta-whatsapp-inbound` |
  | `META_VERIFY_TOKEN_MULTITENANT` | `meta-multi-tenant` |

  Los verify tokens son **distintos** en cada flujo; no son intercambiables.

  **Lo que no existe en n8n Community son las _Variables_** (función de pago).
  Las variables de entorno sí funcionan, y estos flujos ya las usaban en otros
  nodos. Se comprobó con una sonda antes de tocar nada: un nodo Code lee
  `$env.META_APP_SECRET` sin problema con
  `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, aunque esa variable no esté en la
  lista de `N8N_UNRESTRICTED_ENV_VARS`.

  Comprobado después contra la instancia real: el saludo de verificación
  devuelve el reto con el token bueno y 403 con uno falso, y una entrega
  firmada se acepta mientras que una con firma inventada da 403.

  **Sigue pendiente rotar el secreto desde el panel de Meta** — eso no lo
  arregla esto. Pero ahora rotar es cambiar un valor en `/root/.env`, otro en
  el portal (`/admin/portal/settings/meta`) y el secreto de GitHub, sin tocar
  ningún flujo.
- La rama del chatbot dejó de llamar solo a `.../whatsapp/message` (que
  guarda el turno pero no contesta ni envía nada) y ahora sigue el mismo
  patrón que Telegram: `POST .../whatsapp/reply` → si hay `reply`, `POST
  .../whatsapp/send`. `reply: null` (traspaso a humano o tope del mes) ya no
  intenta enviar nada.

## Messenger — migrado al motor real el 20/09/2026

Corrección sobre lo anterior: no era "sin cliente al otro lado" de forma
permanente. El producto SÍ promete Messenger e Instagram como canales
(`MetaChannelCard.tsx`, el wizard) — el hueco era que la app de Meta nunca
había activado esos casos de uso, no que no hicieran falta. Confirmado
permiso a permiso: `pages_messaging`, `pages_manage_metadata`,
`pages_show_list` y `business_management` (lo que pide Messenger) aparecían
como "Listo para la prueba" — sin revisión de Meta de por medio —, mientras
que `instagram_basic` e `instagram_manage_messages` no, así que Instagram
sigue bloqueado por una revisión de Meta con plazo propio.

Con Messenger desbloqueado, se aplicó en `meta-multi-tenant`:

- **Verificación de firma HMAC delante de las tres ramas** (WhatsApp,
  Messenger, Instagram) — hasta ahora no había ninguna. Reutiliza el mismo
  código y el mismo `META_APP_SECRET` real que ya corría en
  `meta-whatsapp-inbound`, no uno nuevo. De paso deja de importar que la
  rama de WhatsApp de este flujo esté huérfana: ya no admite peticiones sin
  firmar. Probado contra el flujo real con una petición forjada — se corta
  en `Check Signature Valid` sin llegar a ningún routing.
- **Messenger deja de montar el prompt a mano y llamar a OpenAI**: ahora
  sigue el mismo patrón que Telegram y WhatsApp — `POST
  .../messenger/reply` → si hay respuesta, `POST .../messenger/send`.
- La clasificación de leads de Messenger se mantiene (mismo criterio que
  WhatsApp/Telegram: no se retira todavía, es una decisión de producto
  aparte), recableada a los nodos nuevos.
- El *verify token* de la pantalla de webhook de Messenger quedó fijo en el
  nodo (no hay variable de entorno equivalente en n8n, y las Variables
  propias de n8n no están disponibles — licencia Community, sin
  `feat:variables`). Redactado en este export como
  `MESSENGER-VERIFY-TOKEN-REDACTED.ejemplo`.

**Instagram — migrado al motor real el 20/09/2026, sin esperar a Meta.**
El código no depende de la revisión de Meta, solo las pruebas contra
tráfico real la necesitan — así que se migró igual que Messenger: `POST
.../instagram/reply` → si hay respuesta, `POST .../instagram/send`,
clasificación de leads recableada, verificación de firma ya cubriéndola
desde la migración de Messenger (se reutiliza, no se duplicó). Probado
con una petición forjada en forma de Instagram — se corta en `Check
Signature Valid`, igual que WhatsApp y Messenger.

**Lo que queda pendiente:**
- **Instagram no se puede probar contra tráfico real** hasta que Meta
  apruebe `instagram_basic`/`instagram_manage_messages`. El código está
  listo; falta el permiso, no la implementación.
- **`meta-multi-tenant` sigue sin poder desactivarse por API** — el
  clasificador de modo automático lo bloquea ("Interfere With Workloads");
  ya no aplica de todos modos, ahora que Messenger vive aquí de verdad.
- La copy de `MetaChannelCard.tsx` (*"WhatsApp, Messenger e Instagram... un
  solo paso para los tres canales"*) sigue prometiendo Instagram antes de
  tiempo — pendiente de ajustar mientras Instagram no esté aprobado.
- `Extract Message` en este flujo **descarta cualquier mensaje que no sea
  texto** (`message.type === 'text'`) antes de que llegue a
  `/api/internal/recall/whatsapp-reply` — así que una nota de voz de recall
  nunca llega a esa ruta pese a que la ruta sí sabe procesarlas
  (`audioMediaId`). Es un hallazgo de esta revisión, no un arreglo: hace
  falta extraer el `type: 'audio'` y su `media.id` antes de decidir si se
  ignora el mensaje.

## Dos flujos que se ejecutaban sin hacer nada — arreglado el 20/09/2026

`wizard-abandoned` y `config-review-overdue` tenían las **conexiones indexadas
por el id de cada nodo en vez de por su nombre**, que es lo que n8n recorre.
Resultado: cada 6 horas el disparador se ejecutaba, no encontraba salida y la
ejecución terminaba "con éxito" sin llamar a nada. Cincuenta ejecuciones
seguidas en verde sin efecto ninguno.

Se reescribieron las 20 referencias de cada uno a nombres. A partir de ahora sí
recorren el flujo — y, mientras faltó `PORTAL_API_URL` (hasta el 22/09/2026),
fallaban de forma visible en vez de mentir en verde. Eso fue una mejora, no un
empeoramiento.

## Fase 2b y el clasificador de leads único — 20/09/2026

**El widget web ya no pasa por n8n para el tráfico de mensajes.**
`webchat-multi-tenant` sigue existiendo y activo, pero
`/api/public/channels/web/config` le da al widget `chatEndpoint:
/api/public/channels/web/message` (una ruta nueva del propio portal), no
la URL de este flujo. `embed.js` no cambió ni una línea — sigue mandando
lo mismo, solo que ahora a otro sitio.

**Los cinco clasificadores de leads en caliente de n8n se quitaron** —
`telegram-multi-tenant`, las tres ramas de `meta-multi-tenant` y
`webchat-multi-tenant` terminan ahora en el envío de la respuesta.
Decisión tomada con datos, no a ojo: el barrido del portal
(`/api/cron/classify-leads`) corre cada 5 minutos vía
`scripts/scheduler.sh`, así que la latencia real que se perdía era de
minutos, no de horas, y a cambio se gana una sola factura de IA (Anthropic,
no OpenAI), el perfil de cualificación de cada cliente, tope de gasto real
y cero duplicación entre cinco sitios. Detalle completo en
`docs/plan-motor-chatbot.md`.
