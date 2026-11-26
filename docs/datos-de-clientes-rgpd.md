# Datos de los clientes: exportación, conservación y baja (RGPD)

Creado el 25/11/2026 con el PR 1 del plan «que el portal haga lo que promete el encargo del
tratamiento». Recoge, producto por producto, lo que el portal hace con los datos personales que
Kairikos trata **por cuenta del cliente** (art. 28 RGPD): los de las personas que escriben al chat,
llaman a su número o le dejan una solicitud. Crece con cada PR del plan; si cambias una de estas
reglas en el código, cámbiala aquí.

La cláusula 10 del contrato de encargo promete que, al acabar el servicio, el cliente puede llevarse
esos datos en CSV o JSON, y que después Kairikos los borra. Este documento dice dónde está cada una
de las dos mitades.

## Reglas comunes

- **Exportar va antes que borrar.** Ningún borrado de datos del cliente (retención, baja) se activa
  si el cliente no puede llevarse antes esos mismos datos.
- **Las exportaciones del cliente funcionan también con el producto cancelado**, para que pueda
  llevarse sus datos durante el plazo de una baja. El cliente siempre sale de la sesión, nunca de un
  parámetro.
- **El operador puede exportar en cualquier estado**, mientras los datos existan (antes de la purga),
  para entregárselos a un cliente que no consigue entrar.
- **Toda exportación, retención o baja deja una fila en `ClientDataAudit`** (`client_data_audit`),
  escrita *antes* de mandar el fichero o de borrar: si la auditoría falla, no hay fichero.
  - `product_code`: `chatbot` · `recall` · `leads`.
  - `action`: `exported` · `retention_dry_run` · `retention_purged` · `exit_notified` · `exit_purged`.
  - `actor`: `client:<id>` · `operator:<id>` · `system:<job>`.
  - `metadata`: solo recuentos, formato, fechas y cortes. **Nunca datos personales**: una auditoría
    que copia lo que se exportó o se borró deja una copia más que nadie va a purgar.
  - `client_product_id` va sin clave foránea a propósito: la fila tiene que sobrevivir a la purga de
    la contratación que describe.
- **CSV**: con BOM (Excel en Windows), filas en CRLF, fechas ISO 8601, y cada celda por
  `escapeCsvValue` (`lib/lead-export.ts`): los textos los escriben desconocidos y una celda que
  empieza por `=` es una fórmula al abrirla en Excel.
- **Baja**: sola, desde el cron `retention-purge` (PR 5b del plan, `lib/client-data-exit-auto.ts`),
  como villas y cartera: cuando todas las contrataciones que deciden están dadas de baja y hay datos,
  avisa al cliente; pasado el plazo, borra. Los plazos son los de villas y cartera: 30 días desde
  la baja, nunca menos de 7 desde el aviso, y sin aviso nunca. Un aviso o un borrado de una baja
  anterior (el cliente volvió y se ha vuelto a ir) no valen para la nueva. Lo que el cron no
  resuelve solo (el correo al cliente no sale, el número de llamadas sigue asignado, Twilio falla)
  se le dice al operador en un correo por cliente y día (`client-data-exit`), y ese cliente no se
  reintenta hasta el día siguiente. El operador puede adelantarse con
  `scripts/baja-datos-cliente.sh` (PR 5a). Procedimiento: `portal/docs/runbooks/baja-datos-cliente.md`.
  No hay botones de borrar en el portal.
- **Supresión a petición del cliente con el servicio activo**: todavía a mano (ver el final del
  procedimiento).

## Por producto

### Chatbot — conversaciones (`ChatbotConversation`)

| | |
| --- | --- |
| Qué se exporta | Todas las conversaciones del cliente, de todos sus chatbots. **CSV**: una fila por turno (conversación, chatbot, canal, inicio, última actividad, resultado, derivación, quién atendió, turno, fecha del turno, quién habla, mensaje); una conversación sin turnos sale en una fila con el turno vacío. **JSON**: un objeto por conversación con sus turnos dentro. |
| Cliente | `/portal/conversations` → «Exportar todas las conversaciones» · `GET /api/portal/conversations/export?formato=csv\|json` |
| Operador | Ficha del cliente en el admin, pestaña del chatbot → «CSV · JSON» · `GET /api/admin/portal/conversations/export?clientId=…&formato=csv\|json` |
| Acceso del cliente | Con conversaciones o con un chatbot contratado alguna vez (en cualquier estado). Sin nada de eso, 403. |
| Auditoría | `chatbot` / `exported`, con `{ format, count }` (número de conversaciones). |
| Conservación | El campo «Retención» del paso 10 del asistente (`retencion_leads_dias`): días desde la última actividad. Vacío o 0: 12 meses. Menos de 30 no se aplica (12 meses) y el operador recibe un correo al día (`chat-retention-short`) mientras siga así. Con la conversación caen los resúmenes (`ConversationDigest`) cuya ventana acabó antes del mismo corte; las solicitudes se quedan, sin conversación. **En modo de prueba desde el 25/11/2026 (PR 4a): cuenta, no borra.** Ver «Retención del chat» abajo. |
| Baja | Automática, o `scripts/baja-datos-cliente.sh … --producto chatbot`: conversaciones, resúmenes y mensajes salientes del chat. Las solicitudes se quedan. |

«Última actividad» es la mayor entre `startedAt + duration` y las fechas de la derivación a una
persona (`conversationLastActivity` en `lib/chatbot-export.ts`); la retención cuenta desde ahí.

#### Retención del chat (`lib/chat-retention.ts`)

- La llama el cron `/api/cron/retention-purge` (cada 5 minutos) después del borrado de los datos de
  los que Kairikos es responsable; su recuento sale en la respuesta, bajo `chat`, y por tanto en el
  log del scheduler (`docker logs kairikos-portal-scheduler`).
- Plazo por chatbot: el paso 10 aprobado (`activeForBot`) de esa contratación. Las conversaciones
  sin contratación (anteriores a la multi-instancia) usan el plazo **más largo** de los chatbots del
  cliente: ante la duda, se conserva.
- Modo en la constante `CHAT_RETENTION_MODE`, no en una variable de entorno: pasar a borrar es un
  PR revisado (el 4b del plan), no un valor que se cambia en el servidor.
  - `dry_run` (desde el 25/11/2026): no borra; una fila `retention_dry_run` por chatbot y día con
    `{ count, digests, cutoff, retentionDays }` de lo que borraría.
  - `purge`: borra resúmenes y conversaciones vencidos y escribe `retention_purged` con los mismos
    campos, en la misma transacción.
- Por tandas de 1.000 conversaciones por grupo, de la más antigua a la más reciente; `truncated`
  en la respuesta dice que quedan más para la pasada siguiente.
- Antes de activar el borrado: al menos 7 días de modo de prueba, revisar sus filas, y comprobar
  que la copia del día existe. El 25/11/2026 había 4 conversaciones en producción (la más antigua,
  del 24/10/2026); las cuatro demos tienen 90 días en el paso 10 y la cuenta de pruebas del
  propietario, 1.095.
- Prueba contra un Postgres real: `tests/real/chat-retention.test.ts` (cómo correrla, en su
  cabecera).

Se lee por páginas de 200 con cursor sobre `(startedAt, id)` y se manda en streaming: las
conversaciones no tienen techo y cada una lleva su transcript entero.

### Solicitudes — leads (`Lead`)

| | |
| --- | --- |
| Qué se exporta | Las solicitudes del cliente en CSV (`lib/lead-export.ts`). |
| Cliente | `/portal/leads` · `GET /api/portal/leads/export` (con `leads` o `prospecting` contratado: `hasLeadsInboxAccess`). |
| Operador | Sin ruta propia todavía. |
| Acceso del cliente | Con el buzón contratado (`hasLeadsInboxAccess`) **o con alguna solicitud guardada**: desde el 25/11/2026 (PR 5a), una baja ya no cierra la descarga. En `/portal/leads`, sin buzón y con solicitudes, sale una tarjeta «Tus solicitudes guardadas» con el enlace. |
| Auditoría | `leads` / `exported`, con `{ format: 'csv', count }`. Desde el 25/11/2026; antes no dejaba rastro. |
| Conservación | Sin cambios en este plan. `retention-purge.ts` solo toca los datos de los que Kairikos es responsable (prospección propia), no estos. |
| Baja | Automática, o `--producto leads`: solicitudes, su auditoría y los mensajes salientes de captación y prospección. Solo con leads, prospecting, chatbot, recall y cartera dados de baja. |

### Llamadas — recall (`CallEvent`)

| | |
| --- | --- |
| Qué se exporta | Todas las llamadas de una línea (`lib/recall-export.ts`): fecha y fin, número de quien llamó (u «Oculto»), número marcado, resultado en castellano, duración del recado, transcripción, estado de la grabación («disponible», «borrada el AAAA-MM-DD» o «sin grabación»), canal del aviso a quien llamó, versión y fecha del aviso legal, idioma y devolución agendada. **CSV** y **JSON** (un objeto por llamada). |
| Lo que no sale | La grabación y su URL (es de Twilio, autenticada con nuestra cuenta: en un fichero que se reenvía no debe viajar), los identificadores de Twilio y los errores internos de envío y transcripción. |
| Cliente | `/portal/llamadas` (y `/portal/llamadas/[clientProductId]`) → «Exportar todas las llamadas» · `GET /api/portal/recall/calls/export?formato=csv\|json[&clientProductId=…]`. La línea la resuelve `resolveClientTarget` desde la sesión; con varias líneas y sin id, 409. Con el servicio pausado o cancelado también. |
| Operador | Ficha del cliente en el admin, sección de llamadas → «CSV · JSON» · `GET /api/admin/portal/recall/[subscriptionId]/export?formato=csv\|json` |
| Auditoría | `recall` / `exported`, con `{ format, count }` y la contratación de la línea. |
| Conservación | La grabación se borra en Twilio a los 30 días (`RECORDING_RETENTION_DAYS`, `lib/recall-retention.ts`). La transcripción, el número y el resultado se guardan mientras el servicio esté contratado. |
| Baja | Automática, o `--producto recall`: primero las grabaciones que queden en Twilio (si falla una, no se borra nada más); después la suscripción de llamadas entera y sus mensajes salientes. Bloqueada mientras el número siga asignado. |

### Villas y cartera (ya existían)

- **Villas**: `GET /api/portal/villas/export` y `/api/admin/portal/villas/export?clientId=…`,
  auditadas en su propia tabla. Baja con 30 días de gracia y purga automática
  (`docs/plan-reserva-villas.md`, «Baja del cliente»).
- **Cartera**: `GET /api/portal/cartera/exportar` (ZIP) y
  `/api/admin/portal/cartera/[siteId]/exportar`, auditadas. Baja con las mismas reglas de plazo que
  villas (`lib/cartera/exit.ts`).
- Las rutas de operador de estos dos todavía no tienen botón en el admin.

### Datos de contacto que se piden en el chat (desde el 26/11/2026)

Antes, la regla 7 del prompt le pedía al modelo que enseñara el `texto_consentimiento` del paso 6
antes de pedir los datos. Nada lo comprobaba y no quedaba constancia. Ahora el aviso no depende del
modelo:

- **Chat de la web (widget, `contactCapture: 'form'`)**: el bot no pide datos en el texto. Cuando
  toca (según `momento_captura`, al derivar, fuera de horario o porque la persona escribe un
  teléfono o un correo), la ruta devuelve `askContact: true` y el widget abre el formulario, que
  tiene aviso, casilla obligatoria y guarda `contactConsentAt` y `contactNoticeVersion`. Las
  respuestas de reserva de la ruta (tope, fallo de la IA) también invitan al formulario y lo abren,
  en los tres idiomas de `embed.v2.js`.
- **WhatsApp, Instagram, Messenger y Telegram (`'text'`)**: no hay formulario. Si el bot pide los
  datos (`askContact` en su JSON) o la persona los escribe por su cuenta (`containsContactData`), el
  servidor añade el aviso detrás de la respuesta (`lib/contact-notice.ts`): el nombre del negocio y
  el `texto_consentimiento` aprobado, o uno genérico si no hay. Una vez por conversación. Queda
  `ChatbotConversation.contactNoticeShownAt`, y el texto exacto en el transcript, en ese turno.
- Límites conocidos: el aviso va en el idioma de la configuración (español), aunque la persona
  escriba en otro. El widget v1 (`embed.js`, congelado) abre su formulario de siempre, sin casilla:
  la ruta de contacto lo cuenta como `widget_contact.legacy_no_consent`.
- Redacción del marco del aviso pendiente de revisión jurídica. La base del tratamiento es atender
  la consulta; el aviso cumple el deber de información (art. 13 RGPD, primera capa).

### Envíos al CRM y mensajes enviados (`lib/processor-retention.ts`, desde el 26/11/2026)

Corre con el cron `retention-purge`, después del chat; su recuento sale bajo `processor`.

| Dato | Plazo | Qué queda |
| --- | --- | --- |
| `ChannelWebhookDelivery.payload` (lo que se manda al CRM del cliente o a n8n: nombre, teléfono, mensaje) | 30 días desde el envío | La fila, con el payload vacío (`{}`): tipo, estado, intentos y error. Si a los 30 días seguía sin entregarse (`pending` o `failed`), pasa a `expired` y ya no se puede reintentar, ni a mano. |
| `OutboundMessage.toE164` (número al que se mandó cada WhatsApp o SMS) | 12 meses desde el envío | La fila, con el número a `NULL`: coste, canal, plantilla, fecha. Pasado un año, una campaña de recuperación ya no sabe que se escribió a ese número. |

Prueba contra un Postgres real: `tests/real/processor-retention.test.ts`.

### Contactos (`Contact`)

Sin plazo propio, a propósito: es la agenda del cliente (mucha la importa él mismo) y se rige como
sus solicitudes: se conserva mientras el servicio esté contratado o hasta que el cliente pida la
supresión (por operador). En la baja automática se borran los contactos que se quedan sin nada
enlazado (`lib/client-data-exit.ts`).
