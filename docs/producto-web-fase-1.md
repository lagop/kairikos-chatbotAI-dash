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

## Probado contra servidores de verdad (24/09/2026)

**La subida por SFTP ya ha hablado con un servidor real.** Se probó contra un
servidor de usar y tirar (`atmoz/sftp` en la VPS, puerto 2222) y la prueba vive
en `portal/tests/real/sftp-publish.test.ts`, que se salta sola si no hay
servidor configurado. Se comprobó que sube, que crea el subdirectorio
`assets/` que todavía no existe, que la segunda publicación sobreescribe, y
que una credencial mala devuelve `{ok:false}` en vez de lanzar.

Salieron dos fallos que ninguna suite verde habría enseñado:

1. **`readyTimeout` de `ssh2` no sirve para el caso que de verdad pasa.** Solo
   empieza a contar cuando el socket TCP ya está abierto, porque mide el saludo
   SSH. Con un host mal tecleado —donde nadie contesta el SYN— el socket se
   queda reintentando lo que decida el sistema operativo: la prueba se colgó
   60 segundos enteros con `readyTimeout: 20000` puesto. Y el host lo escribe
   un cliente en un formulario, así que «mal tecleado» no es el caso raro. Hay
   ahora un tope propio (`withDeadline`) en la conexión, en cada subida y en el
   cierre.
2. **Los archivos quedaban en 666**, world-writable: en un alojamiento
   compartido, cualquiera con una cuenta allí podría reescribir el
   `index.html` del cliente. Manda el umask de la sesión SFTP, y el `mode` de
   `put` no lo pisa (probado: sale 666 incluso creando el archivo de cero). Se
   corrige con un `chmod` explícito después de subir, que se ignora si el
   alojamiento no deja cambiar permisos.

**El alojamiento propio también se ha servido de verdad.** Se publicó un sitio
de prueba en producción y se comprobó que `/sitios/<slug>` devuelve 200 con su
`content-type`, que un archivo en `assets/` sale como `image/svg+xml`, y que
tanto un archivo inexistente como un slug inexistente dan 404. Las filas de
prueba se borraron después.

## Lo que sigue sin probarse

El dominio propio sobre nuestro alojamiento, que no es código sino la
configuración de proxy descrita arriba, y que necesita un dominio real
apuntando a la VPS.

## Variables de entorno nuevas

`WEBSITE_PUBLISH_CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex) cifra la contraseña
de SFTP de cada cliente. Está en los cuatro sitios: `portal/.env.example`,
`docker-compose.yml`, `deploy.yml` y la VPS. El secret de GitHub se creó el
24/09/2026 — hasta entonces la pantalla de credenciales habría fallado con
500, igual que falló la de Google Places. **No se rota a la ligera**: cambiarlo
deja ilegible la contraseña SFTP de todos los clientes, que tendrían que
volver a escribirla.

`PUBLIC_DRAFT_IP_SALT` es opcional: si no está, se usa una sal por defecto.
Solo afecta al hash con el que se cuentan las peticiones por IP.
