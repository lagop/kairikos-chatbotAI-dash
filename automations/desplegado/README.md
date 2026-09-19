# Lo que hay DESPLEGADO en n8n — foto del 20/09/2026

Esta carpeta no es un diseño ni un objetivo: es **lo que estaba corriendo** en la
instancia real (`n8n.srv1170607.hstgr.cloud`) el día que se auditó, bajado por su
API. Existe porque el resto de `automations/` describía flujos que no son los que
se ejecutan, y sobre esa ficción se estaban tomando decisiones.

Regla: cuando se cambie un flujo en n8n, se vuelve a exportar aquí. Si esta
carpeta y la instancia se separan, esta carpeta miente y vuelve a empezar el
problema.

## Los siete flujos

| Archivo | Estado | Qué hace |
|---|---|---|
| `webchat-multi-tenant.json` | activo | Widget web: pide configuración al portal, **arma el prompt y llama a OpenAI dentro de n8n**, responde al widget y registra los turnos en el portal |
| `telegram-multi-tenant.json` | activo | Igual, para Telegram, enviando por `/channels/telegram/send` |
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

## Fase 1 propuesta, todavía SIN aplicar

`telegram-multi-tenant.fase-1-propuesta.json` es el flujo de Telegram con el
cerebro movido al portal:

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

Para aplicarlo: importarlo en n8n sobre el flujo `SpbahgfJqf5FA56o`, o dejar
que se envíe por la API. La copia de lo que hay ahora está en
`telegram-multi-tenant.json`, y n8n guarda además su propio historial.
