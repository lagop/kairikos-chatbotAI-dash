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
- **Supresión a petición del cliente**: la hace el operador con un script auditado (PR 5 del plan).
  No hay botones de borrar en el portal.

## Por producto

### Chatbot — conversaciones (`ChatbotConversation`)

| | |
| --- | --- |
| Qué se exporta | Todas las conversaciones del cliente, de todos sus chatbots. **CSV**: una fila por turno (conversación, chatbot, canal, inicio, última actividad, resultado, derivación, quién atendió, turno, fecha del turno, quién habla, mensaje); una conversación sin turnos sale en una fila con el turno vacío. **JSON**: un objeto por conversación con sus turnos dentro. |
| Cliente | `/portal/conversations` → «Exportar todas las conversaciones» · `GET /api/portal/conversations/export?formato=csv\|json` |
| Operador | Ficha del cliente en el admin, pestaña del chatbot → «CSV · JSON» · `GET /api/admin/portal/conversations/export?clientId=…&formato=csv\|json` |
| Acceso del cliente | Con conversaciones o con un chatbot contratado alguna vez (en cualquier estado). Sin nada de eso, 403. |
| Auditoría | `chatbot` / `exported`, con `{ format, count }` (número de conversaciones). |
| Conservación | Hoy, sin límite. PR 4 del plan: el campo «Retención» del paso 10 del asistente fija los días desde la última actividad; vacío o 0, 12 meses; menos de 30 no se aplica. |
| Baja | Pendiente (PR 5 del plan). |

«Última actividad» es la mayor entre `startedAt + duration` y las fechas de la derivación a una
persona (`conversationLastActivity` en `lib/chatbot-export.ts`); la retención contará desde ahí.

Se lee por páginas de 200 con cursor sobre `(startedAt, id)` y se manda en streaming: las
conversaciones no tienen techo y cada una lleva su transcript entero.

### Solicitudes — leads (`Lead`)

| | |
| --- | --- |
| Qué se exporta | Las solicitudes del cliente en CSV (`lib/lead-export.ts`). |
| Cliente | `/portal/leads` · `GET /api/portal/leads/export` (con `leads` o `prospecting` contratado: `hasLeadsInboxAccess`). |
| Operador | Sin ruta propia todavía. |
| Auditoría | `leads` / `exported`, con `{ format: 'csv', count }`. Desde el 25/11/2026; antes no dejaba rastro. |
| Conservación | Sin cambios en este plan. `retention-purge.ts` solo toca los datos de los que Kairikos es responsable (prospección propia), no estos. |
| Baja | Pendiente (PR 5 del plan): solo si no queda activo ningún producto que las genere. |

### Llamadas — recall (`CallEvent`)

Pendiente (PR 2 del plan). Hoy: la grabación se borra en Twilio a los 30 días
(`RECORDING_RETENTION_DAYS`, `lib/recall-retention.ts`); la transcripción, el número y el resultado
se guardan mientras el servicio esté contratado.

### Villas y cartera (ya existían)

- **Villas**: `GET /api/portal/villas/export` y `/api/admin/portal/villas/export?clientId=…`,
  auditadas en su propia tabla. Baja con 30 días de gracia y purga automática
  (`docs/plan-reserva-villas.md`, «Baja del cliente»).
- **Cartera**: `GET /api/portal/cartera/exportar` (ZIP) y
  `/api/admin/portal/cartera/[siteId]/exportar`, auditadas. Baja con las mismas reglas de plazo que
  villas (`lib/cartera/exit.ts`).
- Las rutas de operador de estos dos todavía no tienen botón en el admin.

## Fuera de este documento (anotado en el plan)

- El bot también pide datos de contacto dentro de la conversación, sin registrar consentimiento.
- Sin regla de conservación propia: `OutboundMessage.toE164`, `ChannelWebhookDelivery.payload`,
  `Contact`.
