# Lo que hay DESPLEGADO en n8n — foto del 20/09/2026

Esta carpeta no es un diseño ni un objetivo: es **lo que estaba corriendo** en la
instancia real (`n8n.srv1170607.hstgr.cloud`) el día que se auditó, bajado por su
API. Existe porque el resto de `automations/` describía flujos que no son los que
se ejecutan, y sobre esa ficción se estaban tomando decisiones.

Regla: cuando se cambie un flujo en n8n, se vuelve a exportar aquí. Si esta
carpeta y la instancia se separan, esta carpeta miente y vuelve a empezar el
problema.

## EL HALLAZGO QUE MANDA SOBRE TODO LO DEMÁS

**n8n nunca ha podido hablar con el portal.** `PORTAL_API_URL` y
`PORTAL_API_KEY` **no están definidas** en los contenedores `root-n8n-1` ni
`root-n8n-worker-1` (comprobado con `printenv` el 20/09/2026). Cada nodo que
llama a `{{ $env.PORTAL_API_URL }}/api/internal/...` construye una URL vacía y
revienta con *"Invalid URL"*.

Eso explica lo que la base de datos ya decía y nadie había atado: en producción
hay **0 conversaciones, 0 chatbots activos, 0 widgets y 0 hitos**. El chatbot
no es que respondiera mal — es que **nunca ha respondido**.

Lo que hace falta, y no se puede hacer desde aquí porque toca infraestructura
compartida y un secreto:

1. Añadir al servicio de n8n en su `docker-compose.yml` de la VPS:
   `PORTAL_API_URL=https://portal.kairikos.cloud` y `PORTAL_API_KEY=<el mismo
   valor que el portal>`.
2. Reiniciar `root-n8n-1` y `root-n8n-worker-1`. **Ojo**: en esa instancia
   viven también automatizaciones ajenas a Kairikos, así que el reinicio las
   corta un momento.
3. Volver a lanzar la prueba del widget o del bot de Telegram.

Hasta entonces, cualquier cambio en estos flujos es teoría: el portal no
recibe nada.

## Los siete flujos

| Archivo | Estado | Qué hace |
|---|---|---|
| `webchat-multi-tenant.json` | activo | **Fase 2a aplicada**: widget web; el portal contesta (`/channels/web/reply`) y n8n solo traduce al contrato del widget |
| `telegram-multi-tenant.json` | activo | **Fase 1 aplicada**: recibe de Telegram, el portal contesta (`/channels/telegram/reply`) y n8n envía (`/channels/telegram/send`) |
| `meta-multi-tenant.json` | activo | Igual, para WhatsApp, Messenger e Instagram |
| `meta-whatsapp-inbound.json` | activo | Recibe de Meta, verifica firma y reparte entre Recall y chatbot. **Apunta a un túnel de desarrollo personal** (sustituido aquí por `TUNEL-DE-DESARROLLO.ejemplo`), así que en producción no llega a ningún sitio |
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

## Dos flujos que se ejecutaban sin hacer nada — arreglado el 20/09/2026

`wizard-abandoned` y `config-review-overdue` tenían las **conexiones indexadas
por el id de cada nodo en vez de por su nombre**, que es lo que n8n recorre.
Resultado: cada 6 horas el disparador se ejecutaba, no encontraba salida y la
ejecución terminaba "con éxito" sin llamar a nada. Cincuenta ejecuciones
seguidas en verde sin efecto ninguno.

Se reescribieron las 20 referencias de cada uno a nombres. A partir de ahora sí
recorren el flujo — y, mientras falte `PORTAL_API_URL`, fallarán de forma
visible en vez de mentir en verde. Eso es una mejora, no un empeoramiento.
