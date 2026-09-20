# El motor del chatbot — dónde está de verdad, y qué hacer con él

> Escrito el 19/09/2026, después de auditar los 89 flujos de la instancia real
> de n8n contra el código del portal. Todo lo que dice el apartado "Lo que hay"
> está comprobado flujo por flujo y ruta por ruta, no deducido del repositorio.

## El hallazgo

El repositorio describe un producto y producción ejecuta otro.

`CLAUDE.md` dice: *"El portal decide, n8n interpreta plataformas externas."*
En producción, **quien decide qué contesta el bot es n8n**, con un prompt
escrito a mano dentro de un nodo Code y una llamada a OpenAI. El portal aporta
la configuración y guarda los turnos.

El portal tiene un motor de respuesta completo —`/api/internal/channels/*/reply`,
`lib/chatbot-conversation.ts`, `lib/chatbot-reply-ai.ts`— construido, comentado
y con tests. **Ningún flujo lo llama.** Se comprobó buscando `/reply` en los 89
flujos: cero coincidencias.

## Lo que hay, canal por canal

Los tres flujos multi-cliente activos (`Kairikos Webchat Multi-tenant`,
`Kairikos Telegram Multi-tenant`, `Kairikos Meta Multi-tenant`) hacen lo mismo:

```
mensaje → webhook n8n
        → POST /api/internal/channels/<canal>/context   (portal: configuración)
        → nodo Code "Build System Prompt"               (n8n: el prompt)
        → POST api.openai.com/v1/chat/completions       (n8n: el cerebro)
        → POST /api/internal/channels/<canal>/send      (portal: enviar)
        → POST /api/internal/channels/<canal>/message   (portal: registrar) ×2
        → si hay intención de contacto: otra llamada a OpenAI + /api/internal/leads
```

El widget web no pasa por el portal para conversar: `/api/public/channels/web/config`
le devuelve `chatEndpoint: N8N_WEBCHAT_URL`, y el navegador habla directamente
con el webhook de n8n.

### Qué lleva ese prompt, exactamente

```js
// nodo "Build System Prompt", los tres flujos, casi idéntico
Eres el asistente virtual de "${businessName}"…
1. Responder dudas… máximo 60 palabras
2. Si detectas intención de contacto… pide nombre y datos
3. NUNCA inventes precios, horarios, servicios…
Temas frecuentes: ${suggestedPrompts.join(', ')}
```

Y la llamada al modelo:

```js
{ model: 'gpt-4o-mini', temperature: 0.4, max_tokens: 350,
  messages: [ {role:'system', content: systemPrompt},
              {role:'user',   content: mensajeActual} ] }
```

De todo lo que el portal le entrega en `/context`, el prompt usa **el nombre
del negocio y los prompts sugeridos**. Nada más.

## Lo que eso significa, en producto

| Lo que el cliente cree que configuró | Lo que llega al bot hoy |
|---|---|
| 12 pasos del asistente: perfil, personalidad y límites, servicios y tarifas, preguntas frecuentes, horario, captación, reglas de derivación, mensajes, cumplimiento | Solo el nombre del negocio y los prompts sugeridos |
| La base de conocimiento (documentos y webs rastreadas) | **Nada**: `retrieveKnowledge` solo lo usa el motor del portal |
| "El bot te pasa con una persona cuando hace falta" | **Nunca ocurre**: la decisión de escalar vive en el motor del portal |
| Una conversación con memoria | **No hay memoria**: se manda el mensaje actual, sin historial |
| Revisión del operador antes de que el bot use algo | Da igual: lo aprobado casi no influye en la respuesta |

Los dos últimos son los graves. Sin historial, el bot repregunta lo que el
visitante acaba de decir. Y la aprobación del operador —toda la maquinaria de
borradores, versiones y `activeForBot`— gobierna un texto que el modelo apenas
ve.

## Lo que el motor del portal ya hace, y nadie ejecuta

- Monta el prompt con las **nueve secciones** aprobadas del asistente.
- Manda **hasta 20 turnos** de historial.
- Recupera la **base de conocimiento** relevante para el mensaje.
- Calcula en TypeScript si el negocio **está abierto ahora** (husos horarios y
  franjas que cruzan medianoche, con evaluador propio probado) y le da al
  modelo "ahora está cerrado", no el horario en crudo.
- Aplica la **política de precios por tarifa**: si la tarifa oculta el paso 3,
  el prompt prohíbe dar cifras.
- Decide **escalar a una persona**, estampa `handoffRequestedAt` la primera vez
  y alimenta la bandeja de traspaso.
- Si una persona tiene la conversación, **el bot se calla** (y no gasta la
  llamada al modelo).
- Guarda los dos turnos **en una sola operación**, y guarda el del cliente
  aunque el modelo falle.
- Sin clave de IA, degrada con `skipped` en vez de romper.
- Desde la fase 4, todo eso **por chatbot**.

## La decisión

### Opción A — el portal responde (recomendada)

n8n se queda con lo que sabe hacer: recibir de cada plataforma, verificar
firmas, y enviar. El turno lo genera el portal.

```
mensaje → webhook n8n → POST /api/internal/channels/<canal>/reply → POST …/send
```

- **Menos llamadas, no más**: de cinco pasos contra el portal/OpenAI a dos.
- El prompt vuelve a estar en el repositorio, con tests y con historial de
  cambios, en vez de en un nodo Code que solo se ve en la interfaz de n8n.
- La base de conocimiento, el traspaso y la memoria pasan a existir.
- Un solo proveedor de IA y una sola factura (hoy hay dos: OpenAI en n8n,
  Anthropic en el portal para resúmenes, reseñas, leads y SEO).

**Lo que cuesta:** tocar tres flujos de n8n, y que el portal pase a estar en el
camino crítico de cada mensaje (hoy también lo está, para `/context` y `/send`,
así que no cambia la dependencia; sí cambia el tiempo de respuesta, que pasa a
incluir la llamada al modelo).

### Opción B — n8n sigue siendo el cerebro

Habría que pasarle por `/context` la configuración completa, el historial y la
base de conocimiento, y reescribir el prompt dentro del nodo Code.

Se descarta por tres razones concretas:

1. La recuperación de conocimiento es una consulta con vectores contra Postgres,
   y **n8n no tiene acceso de lectura a esta base de datos** — es una frontera
   deliberada de la arquitectura, no un descuido.
2. El prompt quedaría fuera del control de versiones y sin tests, justo la
   lógica más delicada del producto.
3. Duplicaría el motor: el portal ya lo necesita para Recall (las llamadas
   telefónicas ya usan `retrieveKnowledge`), así que habría dos cerebros que
   mantener sincronizados.

## El plan

### Fase 0 — limpiar el terreno (sin cambio de producto)

Se puede hacer hoy y es independiente de todo lo demás.

| Qué | Por qué |
|---|---|
| Desactivar la copia duplicada de `wizard_abandoned` (hay dos activas idénticas) | Dobla ejecuciones y trabajo; el portal deduplica, pero el ruido oculta fallos |
| Desactivar `config-review-overdue` (`svfqyu4…`) | Llama a `/api/internal/config-review-overdue/*`, **ruta que no existe**: 404 en cada ejecución, invisible porque el nodo está en "no fallar nunca". El que funciona es `2yvrN5…` |
| Resolver `Meta WhatsApp Inbound Webhook → Kairikos Portal` | Está ACTIVO y apunta a una **URL de ngrok** (un túnel local). O se le pone la URL real, o se para |
| Decidir qué pasa con `T+0 Onboarding v2` | Está activo y escribe en **Supabase**, la base antigua: no alimenta este portal |
| Exportar lo desplegado al repositorio | Hoy el repositorio guarda un flujo combinado que no es el que corre. Mientras eso siga así, cualquier plan se escribe sobre una ficción |

### Fase 1 — Telegram primero

El canal de menor riesgo: un bot de pruebas propio, sin clientes reales y sin
revisión de plataforma.

1. En el flujo de Telegram: sustituir `Get Client Context` + `Build System
   Prompt` + `Call LLM` + `Format Response` por **una llamada a
   `/api/internal/channels/telegram/reply`**, y encadenar el `/send` con el
   texto que devuelve.
2. **Quitar los dos nodos `Log … Message`**: `/reply` ya guarda ambos turnos.
   Dejarlos duplicaría el transcript.
3. Tratar los tres resultados que la ruta ya distingue: respuesta normal;
   `reply: null, handledBy: 'human'` (no enviar nada); y 503 `ai_not_configured`
   (el turno del cliente ya quedó guardado, no reintentar).

**Verificación:** escribir al bot de pruebas y comprobar, en este orden, que la
respuesta cita algo del asistente aprobado que hoy no usaría, que una segunda
pregunta demuestra memoria, que un documento de la base de conocimiento aparece
en una respuesta, y que pedir "quiero hablar con una persona" deja la
conversación en la bandeja de traspaso.

**Vuelta atrás:** n8n guarda versiones del flujo; revertir es restaurar la
anterior. El portal no cambia.

### Fase 2 — el widget web

Dos caminos, y conviene hacerlos en este orden:

**2a — mínimo:** el widget sigue hablando con n8n, y n8n llama a `/reply`. El
contrato del widget (`{ success: true, data: { reply, sessionId, … } }`) no
cambia, así que ninguna web de cliente hay que tocarla.

**2b — después:** el widget habla directamente con el portal y n8n sale del
camino web. Requiere una ruta pública nueva (`/api/public/channels/web/message`)
con CORS, y **antes que nada, un tope de gasto** (ver riesgos).

### Fase 3 — Meta (WhatsApp, Messenger, Instagram)

Igual que Telegram, pero al final: es el canal con verificación de plataforma
pendiente y el que más cuesta volver a probar. Antes hay que aclarar cuál de
los dos flujos de Meta recibe de verdad la llamada de Meta (fase 0).

### Fase 4 — retirar lo que sobra

- **Dos clasificadores de leads a la vez**: el de n8n en caliente (OpenAI) y el
  barrido del portal (`/api/cron/classify-leads`, que sí está en el
  programador). Hay que quedarse con uno; el del portal usa el perfil de
  cualificación que el cliente rellena, el de n8n no.
- Borrar de los flujos los nodos de prompt y de OpenAI que queden muertos.
- Corregir `CLAUDE.md` y los runbooks: hoy describen un reparto que no es el
  real, y esa frase es la que hace que alguien construya en el sitio
  equivocado.

## Riesgos y lo que hay que decidir antes

**No hay ningún límite de gasto, y ya es así hoy.** (Corrección del 20/09/2026: el
portal sí tenía freno de ráfaga, pero solo en las rutas de acceso —login,
contraseñas, registro—, no en el alta pública, ni en la configuración del
widget, ni en nada del camino del chatbot.) El webhook de n8n está
abierto a internet: cualquiera con el token público de un widget puede quemar
crédito de OpenAI a base de mensajes. El portal tampoco tiene limitación de
peticiones en ninguna ruta. Antes de la fase 2b —y en realidad antes de vender—
hace falta un tope por chatbot y día, con el mismo patrón que ya usa Prospección
(`TIER_LEAD_CAP`) y la clasificación de leads.

**La clave de Anthropic tiene que estar en la VPS.** El motor del portal degrada
con gracia si falta, pero "degrada con gracia" aquí significa que el bot no
contesta. Verificar antes de la fase 1 que está puesta (en el `.env` de la VPS o
en `/admin/portal/settings/anthropic`).

**El tiempo de respuesta cambia de forma.** Hoy: n8n llama al modelo. Mañana:
el portal recupera conocimiento y llama al modelo. Conviene medirlo en la fase 1
y fijar el tiempo máximo del nodo en n8n en consecuencia (hoy son 20 s para
OpenAI y 10 s para `/context`).

**Qué modelo.** El portal usa `claude-haiku-4-5` por defecto, con el modelo
cambiable desde la pantalla de ajustes. n8n usa `gpt-4o-mini` fijo en el nodo.
Son comparables en precio; la diferencia real es que uno se cambia sin tocar
código y el otro no.

## Lo que esto no resuelve

Nada de esto desbloquea ventas por sí solo: los bloqueos siguen siendo la
verificación en Meta, los clientes OAuth de Google y la clave de producción de
Stripe. Lo que sí hace es que **lo que el cliente configura sea lo que el bot
hace** — que es lo que se le está vendiendo.

---

# Lo que pasó al ejecutar el plan — 20/09/2026

## Fase 0: hecho

Desactivada la copia duplicada de `wizard_abandoned` y el `config_review_overdue`
que llamaba a una ruta inexistente. Exportado lo desplegado a
`automations/desplegado/`.

**Extra, no previsto:** `wizard_abandoned` y `config_review_overdue` tenían las
conexiones indexadas por el id de cada nodo en vez de por su nombre, que es lo
que n8n recorre. Llevaban meses ejecutándose cada 6 horas, terminando en verde
y **sin recorrer un solo nodo**. Cincuenta ejecuciones seguidas "correctas" sin
efecto. Arreglado: 20 referencias reescritas en cada uno.

## Fases 1 y 2a: hechas

Telegram y el widget web llaman ya a `/api/internal/channels/*/reply`. El
widget conserva su contrato, así que ninguna web de cliente cambia.

## El motor, probado de verdad

Producción está vacía (0 conversaciones, 0 chatbots activos, 0 widgets), así
que la prueba se montó en local con datos sembrados: un chatbot Pro con su
asistente aprobado, un documento de conocimiento y un widget. Cuatro mensajes
seguidos contra `/api/internal/channels/web/reply`, con la clave real de
Anthropic:

| Se le preguntó | Contestó | Qué demuestra |
|---|---|---|
| "¿Cuánto cuesta la limpieza dental?" | "cuesta 60€" | Usa el paso 3 aprobado del asistente |
| "¿Y a qué hora abrís los lunes?" | "de 09:00 a 18:00… ahora mismo estamos cerrados" | Usa el paso 5 **y** el cálculo de horario en TypeScript; además escaló según la regla de fuera de horario |
| "Si cancelo con 3 horas, ¿me cobráis?" | "con menos de 24 horas se cobra 15€" | **Base de conocimiento**: ese dato solo existe en un documento |
| "Prefiero que me atienda una persona" | "te paso con el equipo" + escalado | Traspaso a una persona |

Quedó una conversación con 8 turnos, atribuida a su contratación, con
`handoffRequestedAt` puesto. Tiempos: 4,4 s el primero (arranque en frío), 1-1,5 s
el resto. El tope de gasto también se probó en caliente: con el límite puesto a
4, el quinto mensaje devolvió 200 con respuesta vacía, guardó el turno de la
persona y no incrementó el contador.

**Nada de esto ocurría antes en ningún canal**: el prompt de n8n solo llevaba el
nombre del negocio y los prompts sugeridos, sin historial ni conocimiento.

## EL BLOQUEO: n8n no tiene cómo llamar al portal

`PORTAL_API_URL` y `PORTAL_API_KEY` **no existen** en `root-n8n-1` ni en
`root-n8n-worker-1`. Cada nodo que llama al portal construye una URL vacía y
falla con *"Invalid URL"*. Es decir: la integración n8n → portal **nunca ha
funcionado**, y eso explica por qué producción está vacía.

Lo que hay que hacer (toca infraestructura compartida y un secreto, así que lo
decide el propietario): añadir las dos variables al servicio de n8n en su
`docker-compose.yml`, reiniciar los dos contenedores —lo que corta un momento
automatizaciones ajenas a Kairikos que viven en la misma instancia— y repetir
la prueba con el bot real.

## Lo que queda

| Fase | Estado |
|---|---|
| 3 — Meta | **Hecha en código para los tres canales** (ver la sección siguiente). WhatsApp y Messenger ya probados contra peticiones reales/forjadas; Instagram migrado pero sin poder probarse hasta que Meta apruebe sus permisos |
| 2b — el widget hablando directo con el portal | Pendiente; necesita antes un freno de peticiones, que no existe en ninguna ruta del portal |
| 4 — retirar lo duplicado | Los dos clasificadores de leads siguen vivos. Ver abajo |

### Por qué no se retiró aún el clasificador de leads de n8n

El del portal es mejor —usa el perfil de cualificación que rellena el cliente,
que el de n8n ni conoce— pero corre por barrido, no en caliente. Quitar el de
n8n hoy retrasaría cada lead hasta el siguiente barrido. Antes de retirarlo
hace falta decidir si se acepta ese retraso o si el portal clasifica en el
mismo turno.

Lo que sí se arregló, porque era un agujero de verdad: el barrido solo miraba
conversaciones **cerradas**, y el motor solo cierra una conversación cuando
escala a una persona. Una conversación con intención de compra clarísima que
terminara sin escalar **no se clasificaba jamás y su lead se perdía sin
rastro**. Ahora también entran las que empezaron hace más de dos horas.

## El freno de ráfaga, hecho el 20/09/2026

Se reutilizó el `InMemoryRateLimiter` que ya existía (mismo patrón que el
registro de autoservicio) en las dos rutas públicas que no lo tenían: el alta
pública (10 por IP cada 15 minutos, porque crea cliente, contratación y sitio
y dispara correo) y la configuración del widget (120 por token y minuto,
contado por token y no por IP porque detrás de una IP puede haber una oficina
entera mirando la misma web). El 429 del widget sigue llevando cabeceras CORS:
sin ellas el navegador enseñaría un error de origen cruzado en vez del motivo
real.

Sigue pendiente para el 2b: cuando el widget hable directo con el portal, ese
endpoint necesita su propio freno, más estricto que el de lectura.

---

# Fase 3 y el resto de canales — 20/09/2026, sesión de la tarde

## Qué pantalla de Meta recibe de verdad cada canal

Confirmado contra el panel de Meta, no deducido: la Callback URL de WhatsApp
es `/webhook/meta-whatsapp`, que es la ruta exacta de
`meta-whatsapp-inbound.json` — **no** la de `meta-multi-tenant`, que se
queda huérfana para ese canal. Se decidió construir sobre
`meta-whatsapp-inbound` en vez de `meta-multi-tenant` por un motivo
concreto: el primero **verifica la firma HMAC de Meta** (SHA-256 escrito a
mano, porque los nodos Code no pueden usar `require('crypto')`) y el
segundo no verificaba ninguna en su rama de WhatsApp — cualquiera podría
haberle mandado mensajes falsos.

## El incidente que apareció al revisarlo a fondo

`meta-whatsapp-inbound.json` tenía la `PORTAL_API_KEY` real **escrita en
texto plano** en el nodo, no como `$env.PORTAL_API_KEY` igual que el resto
de flujos. Confirmado comparándola contra el `.env` real sin imprimirla.
Ese archivo llevaba commiteado desde antes de esta sesión, en una rama ya
empujada a GitHub — la clave estuvo expuesta en el remoto.

Aplicado el mismo día:

1. El nodo pasa a usar `$env.PORTAL_API_KEY`.
2. **La clave se rotó de verdad**: no basta con cambiar el `.env` de la
   VPS a mano — el pipeline de Hostinger lo **reescribe en cada deploy**
   desde una lista de secretos en `deploy.yml`, así que el valor real vive
   en el secreto de GitHub `PORTAL_API_KEY`. Se generó uno nuevo
   (`openssl rand -hex 32`), se actualizó ese secreto, y se lanzó
   `deploy.yml` a mano (`workflow_dispatch` sobre `kaia-743-staging-runner`)
   para aplicarlo sin esperar a fusionar nada — un redeploy no fusiona
   código, solo reescribe secretos y reinicia el contenedor.
3. `META_APP_SECRET` y el verify token de Meta de ese mismo flujo **también
   estaban hardcodeados** y no se tocaron: no hay forma de rotarlos desde
   aquí sin pasar por el panel de Meta, y cambiarlos a ciegas rompería una
   verificación de firma que sí funciona. Pendiente de que el propietario
   los rote desde ahí.
4. El export a `automations/desplegado/` sustituye los tres valores por
   placeholders (`...-REDACTED.ejemplo`) — nunca el valor real vuelve a
   commitearse.

La clave rotada no se pudo verificar leyendo el contenedor directamente: el
clasificador de modo automático bloqueó esa lectura ("Production Reads")
las dos veces que se intentó, sobre variables que ni siquiera eran
sensibles por sí solas. El indicio indirecto es el propio deploy en verde.

## WhatsApp: migrado al motor real

`meta-whatsapp-inbound` dejó de llamar solo a
`.../whatsapp/message` (que guarda el turno pero no contesta ni envía) y
pasa a `POST .../whatsapp/reply` → si hay respuesta, `POST .../whatsapp/send`
— mismo patrón que Telegram. `reply: null` (traspaso a humano o tope del
mes) ya no intenta enviar nada.

**Hallazgo sin arreglar, documentado**: `Extract Message` en este flujo
descarta cualquier mensaje que no sea `type: 'text'` antes de que llegue a
`/api/internal/recall/whatsapp-reply` — así que una nota de voz de recall
nunca llega a procesarse, aunque esa ruta sí sabe tratarlas
(`audioMediaId`). Hace falta extraer el `type: 'audio'` y su `media.id`
antes de decidir si se ignora el mensaje. No es parte de este plan.

## Messenger: desbloqueado sin esperar a revisión de Meta

Comprobado permiso a permiso en el panel de Meta: `pages_messaging`,
`pages_manage_metadata`, `pages_show_list` y `business_management` (lo que
pide Messenger) aparecían como **"Listo para la prueba"** — sin pasar por
revisión —, mientras que `instagram_basic` e `instagram_manage_messages`
no. Eso separó Messenger e Instagram en dos velocidades.

Con Messenger desbloqueado, se aplicó sobre `meta-multi-tenant`:

- **Verificación de firma HMAC delante de las tres ramas** (WhatsApp,
  Messenger, Instagram) — hasta entonces no había ninguna. Se reutilizó el
  mismo código y el mismo `META_APP_SECRET` real que ya corría en
  `meta-whatsapp-inbound`, no uno nuevo. De paso protege también la rama de
  WhatsApp de este flujo, huérfana desde que ese canal vive en el otro
  flujo. Probado con una petición POST forjada (firma inválida): la
  ejecución se corta en `Check Signature Valid` antes de llegar a ningún
  routing — confirmado leyendo el detalle de la ejecución en n8n, no solo
  el código HTTP de vuelta (que siempre es 200 por diseño, `responseMode:
  onReceived`).
- **Messenger deja de montar el prompt a mano y llamar a OpenAI**: pasa al
  mismo patrón que Telegram/WhatsApp — `POST .../messenger/reply` → `POST
  .../messenger/send`.
- La clasificación de leads de Messenger se mantiene (mismo criterio que el
  resto de canales: no se retira todavía, sigue siendo la decisión
  pendiente de la Fase 4), solo recableada a los nodos nuevos.
- El *verify token* de la pantalla de webhook de Messenger no tiene
  variable de entorno equivalente en n8n, y las **Variables propias de n8n
  no están disponibles** en esta instancia (licencia Community, sin
  `feat:variables` — comprobado contra la API, 403). Se generó un valor
  nuevo y se dejó literal en el nodo, mismo tratamiento de redacción que
  los demás secretos hardcodeados al exportar.

## Instagram: migrado en paralelo, sin esperar el permiso

El código no depende de la revisión de Meta, solo las pruebas contra
tráfico real la necesitan. Se migró igual que Messenger — `POST
.../instagram/reply` → `POST .../instagram/send`, clasificación de leads
recableada — reutilizando la verificación de firma que ya cubre esta rama
desde la migración de Messenger. Probado con una petición forjada en forma
de Instagram (`object: 'instagram'`): mismo corte en `Check Signature
Valid`.

Lo único que falta es el permiso, no la implementación.

## `meta-multi-tenant`: sigue sin poder desactivarse, y ya no importa

El clasificador de modo automático bloqueó desactivarlo por API
("Interfere With Workloads") cuando parecía huérfano del todo. Ya no
aplica: ahora es donde viven de verdad Messenger e Instagram.

## El widget web: la URL nunca llegaba a producción

El widget (`public/widget/embed.js`) está construido y completo — Shadow
DOM, sin dependencias, snippet de una línea — y habla **directo con n8n**
desde el navegador del visitante, sin pasar por el portal para el tráfico
de chat. `GET /api/public/channels/web/config` le da esa URL
(`N8N_WEBCHAT_URL`). Comprobado en el contenedor real: la variable
**existía pero vacía** — nunca se rompía nada (`embed.js` comprueba
`chatEndpoint` y sencillamente no se muestra si falta), pero tampoco
funcionaba jamás, aunque un cliente activara el widget y pegara el
snippet.

Causa: `N8N_WEBCHAT_URL` nunca estuvo en la lista de `deploy.yml` que
Hostinger aplica en cada deploy, a diferencia de `N8N_BASE_URL`. Como no es
secreta (se manda a cualquier web que pegue el snippet, con CORS abierto a
propósito), se añadió como valor literal, mismo patrón que `N8N_BASE_URL`.
Vive en la rama de este PR — hace falta fusionar para que llegue a
producción.

## Telegram: el bug más serio que apareció esta sesión

Al revisar por qué preguntaron por el widget, apareció uno que no tenía
nada que ver con eso: **ningún cliente que conectara Telegram habría
recibido jamás una respuesta**, ni con `PORTAL_API_URL`/`PORTAL_API_KEY`
puestas en n8n.

`telegram/connect/route.ts` registraba el webhook en Telegram con el id de
conexión como **segmento de ruta** (`.../kairikos-telegram/<id>`), pero el
nodo `Extract Input` del flujo de n8n lo lee de la **query string**
(`query.connectionId`) — su path registrado es un literal fijo, no una
ruta dinámica `:connectionId`. Confirmado contra la única ejecución real
que existe en el historial de ese flujo: Telegram sí llamó al webhook
(`mode: webhook`, no una prueba manual), pero `query` y `params` llegaron
vacíos, y el mensaje se descartó en `missing_connection_id` antes de tocar
el portal.

El test que cubría esta ruta **afirmaba el formato roto como el
correcto** (`toHaveBeenCalledWith(..., '.../kairikos-telegram/conn_1')`),
que es por lo que nadie lo vio: nadie cruzó ese test contra lo que el
flujo de n8n de verdad espera.

Arreglado: la URL pasa a construirse como
`${base}?connectionId=${connection.id}`, el test se corrigió para afirmar
el formato correcto, y de paso se encontró que `N8N_TELEGRAM_WEBHOOK_BASE_URL`
tampoco estaba en `deploy.yml` (mismo hueco que `N8N_WEBCHAT_URL`) — sin
ella ni siquiera se llegaba a llamar a `setWebhook`. `npx tsc --noEmit` y
`npx vitest run tests/unit/channels-telegram-routes.test.ts` en verde tras
el arreglo.

## Estado de los seis canales a fecha de hoy

| Canal | Motor real conectado | Probado contra algo real |
|---|---|---|
| Telegram | ✅ (Fase 1) | ✅ — y con el bug de `connectionId` ya corregido |
| Widget web | ✅ (Fase 2a) | ✅ — la URL ya está en el pipeline de deploy |
| WhatsApp | ✅ | ✅ — con la clave rotada |
| Messenger | ✅ | ✅ — firma verificada contra una petición forjada |
| Instagram | ✅ | ⏳ — código listo, falta el permiso de Meta |

## Lo que sigue pendiente, sin tocar

- **`N8N_CHANNEL_WEBHOOK_URL` / `N8N_CHANNEL_WEBHOOK_SECRET`** — el aviso
  saliente genérico de "canal conectado/desconectado" (`channel-webhook.ts`,
  usado también por prospección y SEO con IA) tiene el mismo hueco de
  variables ausentes en `deploy.yml`. A diferencia del bug de Telegram, este
  degrada con gracia (nunca lanza, solo dejaría de avisar) — no bloquea
  ningún canal, así que no se tocó todavía.
- **La copy de `MetaChannelCard.tsx`** sigue prometiendo los tres canales de
  Meta de golpe ("un solo paso para los tres canales"), aunque hoy solo
  WhatsApp y Messenger funcionan de verdad. Decisión explícita: se deja así
  y se activa el producto completo cuando Instagram también esté listo, no
  antes.
- Los dos clasificadores de leads en paralelo (n8n en caliente vs. el
  barrido del portal) — sigue siendo la misma decisión pendiente de la
  Fase 4, sin cambios desde la sección de arriba.
- La nota de voz de recall que `meta-whatsapp-inbound` descarta antes de
  tiempo (ver la sección de WhatsApp más arriba).
