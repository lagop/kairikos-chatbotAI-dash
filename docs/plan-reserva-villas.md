# Reserva propia para villas (nivel 3 del motor de reservas)

15/11/2026. Producto nuevo del portal, vendido en el presupuestador de Signature
(«desde 1.800 €, según número de villas») para villas y alquiler vacacional sin
sistema de gestión. Concepto: brief del hotel §3.6.1 y `docs/reserva.md` del
repositorio `kairikos-signature-hotel`; decisión del propietario del 15/11/2026:
vive como módulo del portal y cobra con Stripe.

## Qué es y qué no es

Es: calendario por villa con precios por temporada y estancia mínima,
sincronización iCal con Airbnb y Booking (entrada y salida), **solicitud que el
dueño confirma o rechaza** antes de cobrar, depósito con Stripe Checkout solo
tras la confirmación, avisos por correo al dueño y al huésped, y un widget para
la web del cliente.

No es un PMS ni un channel manager: no hay precios por canal, ni pagos del
resto, ni reembolsos automáticos (el dueño reembolsa desde su Stripe), ni
mensajería con el huésped. Si un cliente necesita eso, es nivel 1 o 2 con su
propio sistema.

## Por qué una solicitud y no una reserva en firme

iCal no es tiempo real: Airbnb y Booking refrescan los calendarios importados
cada 1–3 horas. Si la web cobrara al momento, una reserva de Airbnb de hace diez
minutos podría acabar en doble reserva con dinero ya cobrado. Con la solicitud,
el dueño mira sus calendarios antes de aceptar y el portal además vuelve a leer
los iCal de esa villa en el momento de aceptar: si aparece un solape, la
aceptación se rechaza. Nada se cobra hasta entonces.

## Ciclo de una solicitud

```
pending ──aceptar──▶ accepted ──pago──▶ confirmed ──cancelar──▶ cancelled
   │                    │  └──cancelar──▶ cancelled
   ├─rechazar─▶ declined └──sin pago en plazo──▶ expired
   └─sin respuesta en plazo─▶ expired
```

- `pending` no bloquea fechas: varias personas pueden pedir las mismas; el dueño elige.
- `accepted` (esperando el depósito, `paymentHours`, 48 h por defecto) y `confirmed` bloquean fechas y salen en el iCal de salida.
- Al confirmarse una, las `pending` que se solapan se rechazan solas (`dates_taken`) y se avisa a esos huéspedes.
- Plazos por defecto: el dueño contesta en 24 h (`confirmHours`); el huésped paga en 48 h.
- Las transiciones viven en `lib/villas/request-rules.ts`, no en cada ruta.

## Precio

- Precios por noche **con IVA incluido** (es lo que ve el huésped); el IVA se desglosa (10 % por defecto, por villa).
- Temporadas por rango de fechas (última noche incluida). Si dos se solapan, **gana la más corta** (Navidad dentro de invierno). Sin temporada, el precio base.
- Estancia mínima: la de la temporada de la noche de llegada.
- Limpieza por estancia y tasa turística opcional por adulto y noche (fuera de la base del IVA). Hoy 0 en Canarias y Andalucía.
- Depósito = porcentaje del total (30 % por defecto). El resto y cuándo se paga lo dice el dueño en una frase (`balanceNote`).
- Sin ofertas ni precios tachados. El total con IVA se ve antes de enviar la solicitud y otra vez antes de pagar.
- El precio queda congelado en la solicitud (`quote`): cambiar una temporada después no cambia lo que se aceptó.

## Stripe

**Decisión de esta versión: la clave restringida del dueño, cifrada.** El dinero
del depósito es del dueño, no de Kairikos, así que el pago no puede ir a la cuenta
de Stripe del portal. El dueño crea en su Stripe una clave restringida (solo
*Checkout Sessions: escritura*) y la pega en el panel; se guarda con AES-256-GCM y
clave propia (`VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY`).

- **Solo modo test**: el código rechaza claves `sk_live_`/`rk_live_` mientras `VILLAS_STRIPE_LIVE_ENABLED` no sea `true`. Activar cobros reales es una decisión del propietario.
- Sin webhooks por dueño: el pago se comprueba al volver de Checkout (se lee la sesión con la clave del dueño) y el cron repasa las sesiones abiertas. Así no hay que configurar un endpoint en cada cuenta.
- La sesión de Checkout caduca antes que el plazo de pago, así que no se puede pagar una solicitud ya caducada.
- La web del cliente nunca ve una tarjeta: el huésped paga en la página de Stripe.

Alternativa para más adelante: **Stripe Connect** (cuentas conectadas Standard).
Evita guardar claves de terceros y da un único webhook, pero obliga a activar
Connect en la cuenta de Kairikos y a revisar sus condiciones. Queda como decisión
del propietario; el módulo aísla Stripe en `lib/villas/stripe.ts` para cambiarlo.

## iCal

- **Entrada**: por villa, las URL de exportación de Airbnb, Booking u otra. El cron las lee cada 30 min (y al aceptar una solicitud). Cada lectura sustituye los bloqueos de ese calendario. URL filtradas como cualquier URL que escribe el cliente (solo `https`, sin hosts internos), con tiempo y tamaño máximos.
- **Salida**: `/api/public/villas/ical/<token>.ics` por villa, con las solicitudes aceptadas y confirmadas, los bloqueos manuales y los importados (así Airbnb se entera de lo de Booking y al revés). El dueño la pega en Airbnb y Booking. Solo dice «Reservado»: ni nombres ni correos.
- Limitación conocida: un bloqueo importado de Booking vuelve a salir en el calendario que lee Airbnb (y al revés). Es lo que se quiere (que Airbnb sepa lo de Booking), pero una cancelación tarda dos refrescos en desaparecer del todo.

## Dónde vive en el portal

- Producto `villas` (`Product.kind = 'addon'`, sin precio de catálogo: se vende dentro del presupuesto de Signature). Una contratación por cliente; dentro, de una a varias villas. Lo activa el operador (`POST /api/admin/portal/villas`), no hay autoservicio.
- Tablas: `VillaRental` (la configuración de la contratación), `Villa`, `VillaSeason`, `VillaCalendarFeed`, `VillaBlock`, `VillaBookingRequest`, `VillaRentalAudit` (append-only, `actor` = `client:<id>`, `operator:<id>`, `guest`, `system`).
- Lógica pura y testeable en `lib/villas/` (fechas, precios, disponibilidad, iCal, reglas); lo que toca base de datos, Stripe o correo, en módulos `server-only` al lado.
- Panel del dueño: `/portal/villas` (solicitudes, villas, temporadas, calendarios, Stripe).
- Página del huésped: `/reserva-villa/<token>` (estado, resumen y botón de pagar el depósito). El token es largo y aleatorio; no hace falta cuenta.
- Rutas públicas con CORS abierto en `/api/public/villas/<token>/…` (ficha, calendario, presupuesto, solicitud), con límite por token.
- Widget: `public/widget/villas.v1.js`, JS sin dependencias, en el DOM de la página con clases `kv-` y variables CSS para que la web Signature lo vista. Emite los eventos `kairikos:booking_*` del contrato del hotel, sin datos personales. Demo: `/widget/demo-villas.html`.
- Cron: `/api/cron/villas-tick` (lee iCal, caduca plazos, repasa pagos), añadido a `scripts/scheduler.sh`.
- Avisos por correo (Resend, mismo molde que el resto; nunca lanzan): al dueño por solicitud nueva y por depósito pagado; al huésped al recibirla, al aceptarla (con el enlace de pago), al rechazarla o caducar, y al confirmarse.

## Baja del cliente

Aprobado por el propietario el 16/11/2026. La web Signature es del cliente
(«código y contenidos en propiedad»); este módulo es un servicio del portal
ligado a la suscripción. Al darse de baja, `ClientProduct.status` pasa a
`cancelled` y no entra nada nuevo, pero el dueño no se queda sin sus datos ni
con un calendario que de repente miente.

**Plazo de gracia: 30 días desde la baja** (`EXIT_GRACE_DAYS`,
`lib/villas/exit-rules.ts`), y nunca menos de 7 días desde el aviso al dueño
(si el aviso sale tarde, el plazo se alarga). Treinta días es lo habitual para
la devolución de datos al terminar un encargo y da para pasar un ciclo de
facturación; pasado ese tiempo los datos de los huéspedes no deben seguir aquí.

| Estado de la contratación | Widget | Panel | iCal público | Exportar |
| --- | --- | --- | --- | --- |
| `active` | normal | completo | en vivo | sí |
| `paused` | sin servicio | completo | congelado | sí |
| impago u otros | sin servicio | solo lectura | congelado | sí |
| `cancelled`, dentro del plazo | sin servicio | solo lectura | congelado | sí |
| `cancelled`, fuera del plazo | sin servicio | «no está activa» | 404 | solo el operador, hasta la purga |

- **Exportación** (RGPD art. 28.3.g). Desde el panel (`/api/portal/villas/export`) y desde el operador (`/api/admin/portal/villas/export?clientId=…`):
  - Solicitudes y reservas (CSV): fechas, villa, estado, importes con IVA, depósito y resto, datos del huésped, mensaje, consentimiento y pago.
  - Villas, precios y temporadas (CSV), con las URL de los calendarios importados.
  - Un `.ics` por villa con lo confirmado y los bloqueos. Este sí lleva referencia y nombre, porque es del dueño.
  - El registro de cambios (CSV).
  - Cada descarga queda auditada (`exported`, con quién la hizo). Los CSV llevan BOM para Excel, importes con punto decimal y fechas ISO, y protegen contra fórmulas (`lib/lead-export.ts`).
- **Aviso al dueño.** No se engancha a los distintos sitios donde se cancela una contratación. Lo da el cron (`lib/villas/exit.ts`): ve la contratación `cancelled`, marca `exit_notified_at` y manda un correo con tres pasos:
  1. Quitar de Airbnb y Booking la URL iCal de cada villa.
  2. Descargar los datos.
  3. Quitar el widget de la web.

  El correo dice también la fecha límite y cuántas reservas confirmadas siguen valiendo. El panel en solo lectura enseña lo mismo. Mientras el servicio está activo, «Tus datos» en el panel ya avisa de lo que pasará.
- **iCal congelado, no vacío.** Durante el plazo, el `.ics` público sigue sirviendo el último estado, con `X-WR-CALDESC`, que dice desde cuándo no se actualiza y que hay que quitar la URL.
  - Por qué es lo más seguro: las reservas directas ya confirmadas siguen valiendo después de la baja. Si el calendario diera 404 o saliera vacío, Airbnb o Booking podrían soltar esas fechas y venderlas otra vez, y eso es una reserva doble.
  - Congelado, lo peor que pasa es que se bloquee de más hasta que el dueño quite la URL, que es justo lo que se le pide.
  - Al acabar el plazo, 404.
- **Widget sin servicio.** Si la carga inicial devuelve 404 (`not_found` o `not_contracted`), `villas.v1.js` no enseña ningún error.
  - Enseña el contacto que el dueño dejó en el fragmento: `data-fallback-url` (otro sistema de reservas), `data-fallback-email` o `data-fallback-phone`.
  - Sin ninguno de los tres, el bloque desaparece.
  - Un fallo de red o un 5xx sigue enseñando «No se ha podido cargar el calendario».
  - Emite `kairikos:booking_unavailable` (sin datos personales).
- **Solicitudes en curso.**
  - Las pendientes caducan solas en su plazo (como mucho 72 h) y se avisa al huésped. Ya no se pueden aceptar, porque el panel es de solo lectura.
  - Las aceptadas pueden pagarse hasta su plazo: el dueño ya se comprometió. El cron sigue conciliándolas antes de purgar nada.
- **Purga.** Al acabar el plazo, el cron borra la `VillaRental`, y con ella, en cascada: villas, temporadas, calendarios, bloqueos, solicitudes, la clave de Stripe cifrada y su auditoría.
  - Queda una fila `villas_data_purged` en `clientProductAudit`, que no se borra, para poder responder cuándo y por qué ya no están.
  - Sin aviso previo no se purga nunca.
  - Reactivar dentro del plazo (`POST /api/admin/portal/villas`) anula la baja y pone `exit_notified_at` a null.
- Migración: `20261116090000_reserva_villas_baja` (`villa_rental.exit_notified_at`).

## Variables de entorno nuevas

`VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex) y
`VILLAS_STRIPE_LIVE_ENABLED` (vacía = solo test). En `.env.example`,
`docker-compose.yml` y `deploy.yml`; el valor real en la VPS lo pone el
propietario al desplegar.

## Fuera de esta versión

Reembolsos y cancelación con política automática; pago del resto; varias
divisas; tarifas «flexible / sin cambios» por villa (el widget del hotel las
enseña; aquí hay una sola condición escrita por el dueño); extras; idiomas del
correo más allá de español e inglés; Stripe Connect.
