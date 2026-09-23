# Producto Web, Fase 1 — qué hay construido y qué falta

Escrito el 24/09/2026, al cerrar el desarrollo de las capas 1–4 del borrador
de web (A11 del plan de marketing).

## El recorrido completo, de prospecto a web publicada

1. **El barrido encuentra un negocio** (`prospecting`) y le genera su borrador
   automáticamente si no tiene web propia o la suya es una ficha de directorio
   (`web-draft-sweep.ts`, tope de 20 al día).
2. **El comercial llama** con dos enlaces públicos en la mano: el informe
   comparativo (`/informe/<testigo>`) y el borrador (`/borrador/<testigo>`).
   Los dos se abren sin sesión, porque el prospecto no tiene ninguna.
3. **El negocio dice que sí.** El operador le contrata `web` y crea el sitio
   desde su borrador: los textos y la plantilla se copian tal cual, así que lo
   que compró es lo que vio.
4. **Se publica**, en su alojamiento por SFTP o en el nuestro.
5. **El cliente lo mantiene** desde `/portal/web/<proyecto>`: cambia textos,
   servicios y teléfono, y publica cuando quiere.

## Las dos formas de alojar

| | En su servidor (`sftp`, por defecto) | En el nuestro (`kairikos`) |
|---|---|---|
| Quién lo sirve | Su alojamiento | El portal, en `/sitios/<slug>` |
| Qué hace falta | Credencial SFTP suya | Nada |
| Dominio propio | El suyo, ya configurado | `customDomain` + DNS + proxy |
| Si cae nuestra VPS | Su web sigue en pie | Su web cae con nosotros |
| Coste para nosotros | Cero | Casi cero (dos archivos en Postgres) |

El destino por defecto es el suyo a propósito: no queremos ser el único punto
de fallo de webs ajenas, y hace verdad la promesa del contrato ("si te vas, tu
web es tuya"). El nuestro existe para quien no tiene alojamiento, que es justo
el caso en el que no se le puede vender de otra manera.

## Lo que falta para el dominio propio sobre nuestro alojamiento

El código ya guarda `customDomain` y sabe servir por él. Falta **configuración
de la VPS, no código**:

1. El cliente apunta su dominio (registro A) a la IP de la VPS.
2. El proxy (Caddy o Traefik) emite el certificado para ese dominio y pasa la
   petición al portal.
3. El portal resuelve el sitio por la cabecera `Host` contra `customDomain`.

Mientras eso no esté, la dirección provisional `/sitios/<slug>` funciona y
permite enseñar la web el mismo día.

## Frenos de gasto, todos en un sitio

| Dónde | Freno | Por qué |
|---|---|---|
| Barrido de borradores | 20 al día | Cada uno son ~2 céntimos de Sonnet |
| Formulario público | 50 al día en total | Único tope que acota el gasto pase lo que pase |
| Formulario público | 3 por IP y día | El goteo de un curioso |
| Formulario de las webs | 20 envíos por hora y sitio | Un bot llenando la bandeja del cliente |
| Informe comparativo | Bajo demanda, caché 30 días | Cada uno es una búsqueda de pago en Google |

## Lo que NO está probado

**La subida por SFTP nunca ha hablado con un servidor real.** La forma sale de
la documentación de `ssh2-sftp-client`, igual que `google-places.ts` y
`telephony/twilio.ts` salieron de sus documentaciones. La primera publicación
de verdad es la prueba que falta, y conviene hacerla contra un alojamiento de
pruebas antes que contra el de un cliente.

Lo mismo, en menor medida, para el alojamiento propio: está probado con tests
pero no se ha servido una web real todavía.

## Variables de entorno nuevas

`WEBSITE_PUBLISH_CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex) cifra la contraseña
de SFTP de cada cliente. Está en los cuatro sitios: `portal/.env.example`,
`docker-compose.yml`, `deploy.yml` y la VPS. **Sin el secret en GitHub, la
pantalla de credenciales fallará con 500**, igual que falló la de Google
Places.

`PUBLIC_DRAFT_IP_SALT` es opcional: si no está, se usa una sal por defecto.
Solo afecta al hash con el que se cuentan las peticiones por IP.
