# Baja de los datos de un cliente: chat, llamadas y solicitudes

Creado el 25/11/2026 (PR 5a del plan del encargo del tratamiento). Qué pasa cuando un cliente se da
de baja de un producto con datos de terceros que Kairikos trata por su cuenta: las conversaciones
del chat, el registro de llamadas o las solicitudes.

**Desde el 26/11/2026 (PR 5b) es automático**, como villas y cartera: el cron `retention-purge`
(cada 5 minutos) avisa al cliente cuando todas las contrataciones que deciden están dadas de baja y
hay datos, y borra pasado el plazo. Deja las mismas filas `exit_notified` y `exit_purged`, con el
actor `system:client-data-exit`. Lo que tienes que hacer tú:

- **Dar de baja la contratación** en el admin, como siempre, y en llamadas **liberar el número**
  (paso 1 de abajo).
- **Atender el correo «Baja de datos de …: hace falta que mires algo»**, que llega cuando el cron
  se para: el correo al cliente no sale, el número sigue asignado o Twilio falla. Llega uno por
  cliente y día, y ese cliente no se reintenta hasta el día siguiente.

Los pasos de abajo siguen valiendo para mirar el estado o para adelantarse al cron (por ejemplo,
avisar en cuanto se corrige un email); el cron ve lo que hiciste y sigue desde ahí.

Reglas de fondo en `docs/datos-de-clientes-rgpd.md`. Código: `src/lib/client-data-exit.ts` (reglas y
borrados), `src/lib/client-data-exit-auto.ts` (el cron), ruta `POST /api/internal/client-data-exit`
y `scripts/baja-datos-cliente.sh` (en la raíz del repo).

## El plazo

- **30 días desde la baja**, y **nunca menos de 7 desde el aviso**. Son las reglas de villas y
  cartera (`lib/villas/exit-rules.ts`).
- **Sin aviso no se borra nunca.** El aviso es el correo al cliente y la fila `exit_notified` que
  deja en `ClientDataAudit`. Solo cuenta un aviso posterior a la última baja: si el cliente volvió
  y se ha vuelto a ir, se le avisa otra vez.
- **Sin datos no se avisa:** si no hay nada guardado, no hay nada que devolver ni que borrar.
- Durante el plazo el cliente entra al portal y descarga sus datos aunque el servicio esté dado de
  baja (chat y llamadas en CSV o JSON; solicitudes en CSV).

## Qué contrataciones deciden

| Producto | Tienen que estar todas dadas de baja (`cancelled`) |
| --- | --- |
| `chatbot` | las de chatbot |
| `recall` | las de llamadas |
| `leads` | leads, prospecting, chatbot, recall y cartera: todo lo que llena el buzón de solicitudes |

Si una sigue activa, pausada o pendiente de pago, la baja se bloquea (`contract_not_cancelled`). Un
cliente con dos chatbots que da de baja solo uno no se puede tratar con esto: sus conversaciones no
se separan por chatbot en todas las tablas. Se resuelve a mano.

## Pasos

Desde tu equipo, con la clave SSH de la VPS. `--operador` es tu email: queda en la auditoría.

```sh
export VPS=root@<ip de la VPS>
export SSH_KEY=~/.ssh/kairikos_vps
```

1. **Dar de baja la contratación** en el admin del portal, como siempre. Para llamadas, **liberar
   también el número**: con el número asignado, el borrado se bloquea (`number_still_assigned`),
   porque Twilio seguiría cobrándolo sin nada que lo enlace. **Hoy no hay botón para eso** en el
   admin: está la ruta `POST /api/admin/portal/recall/numbers/<id del número>/release`, que pide
   sesión de operador (por ejemplo, un `fetch` desde la consola del navegador con el admin abierto).
   El id del número sale de la tabla `VirtualNumber` (`subscription_id` = la suscripción del
   cliente).
2. **Ver el estado**. Solo lee: qué hay (recuentos), en qué punto está la baja y qué la bloquea.

   ```sh
   scripts/baja-datos-cliente.sh estado --cliente <clientId> --producto chatbot
   ```

3. **Avisar al cliente**. Le llega un correo con la fecha de borrado y el enlace a la página del
   portal donde descargar sus datos. Solo se avisa una vez por producto y baja. Si el correo no
   sale (sin clave de Resend, cliente sin email o Resend caído), no se apunta el aviso y el plazo no
   empieza: arréglalo y repite.

   ```sh
   scripts/baja-datos-cliente.sh avisar --cliente <clientId> --producto chatbot --operador tu@kairikos.com
   ```

4. **Esperar al plazo.** La respuesta del aviso trae `graceEndsAt`; `estado` lo repite.
5. **Borrar, primero en modo de prueba.** Sin `--confirmar` no escribe nada: devuelve lo que borraría
   y los bloqueos que quedan.

   ```sh
   scripts/baja-datos-cliente.sh borrar --cliente <clientId> --producto chatbot --operador tu@kairikos.com
   ```

6. **Borrar de verdad.** Pide escribir «borrar». Antes, comprueba que la copia de seguridad del día
   existe (`docker logs kairikos-portal-backup`). Lo borrado no se puede recuperar salvo desde esa
   copia.

   ```sh
   scripts/baja-datos-cliente.sh borrar --cliente <clientId> --producto chatbot --operador tu@kairikos.com --confirmar
   ```

Para los tres productos, repite los pasos con `--producto recall` y `--producto leads`. Las
solicitudes van al final: solo se pueden borrar cuando ya no queda nada que las genere.

## Qué se borra

| Producto | Se borra | Se queda |
| --- | --- | --- |
| `chatbot` | Conversaciones, sus resúmenes y los mensajes salientes del chat | Las solicitudes que salieron de ellas (sin conversación); la configuración del bot |
| `recall` | Primero, en Twilio, las grabaciones que queden. Después la suscripción de llamadas entera (llamadas, transcripciones, citas, presupuestos, bloqueos, resúmenes, uso y saludo grabado) y sus mensajes salientes | La contratación y las facturas |
| `leads` | Solicitudes, su auditoría y los mensajes salientes de captación y prospección | La contratación |

En los tres casos caen también los contactos (`Contact`) que se quedan sin nada que los use. Queda
una fila `exit_purged` en `ClientDataAudit`, con recuentos y fechas, escrita en la misma transacción
que el borrado.

Si Twilio falla al borrar una grabación, se para ahí y no se borra nada en la base de datos. Las
grabaciones que sí se borraron quedan marcadas. Repite el paso 6 más tarde.

## Respuestas

`HTTP 200` cuando todo va bien; `409` con un bloqueo (`error` dice cuál); `502` si falla el correo o
Twilio; `404` si el cliente no existe. Los bloqueos:

| `error` / `blockers` | Qué significa |
| --- | --- |
| `no_contract` | El cliente no tiene contrataciones de ese producto |
| `contract_not_cancelled` | Alguna sigue sin dar de baja |
| `not_notified` | Falta el aviso (paso 3) |
| `grace_not_over` | Aún no ha pasado el plazo |
| `number_still_assigned` | Llamadas: libera el número antes (paso 1) |
| `twilio_not_configured` | Llamadas: hay grabaciones en Twilio y el portal no tiene credenciales |
| `already_notified` | Ya se avisó; el plazo cuenta desde ese aviso |

## Supresión a petición del cliente con el servicio activo

Esto no la cubre: aquí solo se borra lo que está dado de baja y fuera de plazo, para que el secreto
de los crons no pueda borrar datos de un cliente activo. Si un cliente pide borrar sus datos sin
darse de baja, hoy se hace a mano, con una consulta revisada y una fila en `ClientDataAudit`.
