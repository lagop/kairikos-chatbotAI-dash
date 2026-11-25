# Widget web v2 (`embed.v2.js`)

El chat del Chatbot IA para webs que necesitan más que la burbuja estándar: las
webs Kairikos Signature (la primera, la demo dental *Alisio Dental Studio*).

- **Archivo:** `portal/public/widget/embed.v2.js`, servido en `{portal}/widget/embed.v2.js`.
- **v1 no cambia:** `embed.js` lo cargan todos los clientes desde la misma URL y
  está congelado; `tests/unit/widget-embed-files.test.ts` compara su hash.
- **Página de prueba:** `{portal}/widget/demo-v2.html` (modo simulado sin base de
  datos; `?token=wgt_…` usa las rutas reales).

## Etiqueta

```html
<script src="https://portal.kairikos.com/widget/embed.v2.js" data-space-token="wgt_…" async
  data-launcher="none"
  data-lang="en"
  data-theme="auto"
  data-font="'Albert Sans', sans-serif"
  data-accent="#1f7f77"
  data-links="same-origin"
  data-offset="88"
  data-privacy-url="/privacidad"
></script>
```

| Atributo | Valores | Por defecto | Qué hace |
|---|---|---|---|
| `data-space-token` | `wgt_…` | — (obligatorio) | El widget del cliente. |
| `data-launcher` | `bubble` \| `none` | `bubble` | `none`: sin burbuja; la web lo abre con la API. |
| `data-lang` | `es` \| `en` \| `de` | `es` | Textos de la interfaz. Con `en` o `de` también pide la configuración con `?lang=en` / `?lang=de` (aviso de salud y saludo por defecto en ese idioma) y traduce las respuestas de reserva del servidor. Ver «Idiomas». |
| `data-theme` | `light` \| `dark` \| `auto` | `light` | `auto` sigue `prefers-color-scheme`, también si cambia en vivo. |
| `data-font` | `font-family` CSS | sistema | La fuente tiene que estar cargada en la página (las `@font-face` del documento valen dentro del Shadow DOM). |
| `data-accent` | color CSS | `primaryColor` del portal | El texto sobre el acento se elige por contraste (blanco o casi negro). Con el color del portal, blanco como en v1. |
| `data-links` | `none` \| `same-origin` | `none` | Enlaces en las respuestas del bot (ver abajo). |
| `data-offset` | entero 0–1000 (px) | 88 con burbuja, 20 sin ella; 0 en móvil | Distancia del panel al borde inferior, para barras fijas de la web. |
| `data-privacy-url` | URL o ruta | la del paso 10 | La política de privacidad que enlaza la casilla del formulario de contacto. Se resuelve contra la página (`/privacidad` vale) y solo se acepta `http(s)`. Gana a la del paso 10. Ver «Formulario de contacto: aviso y consentimiento». |

Los atributos se leen **una vez**, al ejecutarse el script.

Sin ningún atributo nuevo, v2 se ve como v1 salvo en cinco cosas: el aviso de IA,
un botón de cerrar en la cabecera, el panel a pantalla completa en móvil, botones
de 44 px de alto y el aviso de privacidad con casilla obligatoria en el formulario
de contacto.

## API: `window.KairikosChat`

Existe en cuanto se ejecuta el script (de forma síncrona). Lo que pida abrir o
cerrar antes de que llegue la configuración se encola y se ejecuta después, en
orden; `setContext`, `setTheme` y `configure` se aplican al momento.

| Método | Qué hace |
|---|---|
| `open({ message? })` | Abre el panel y pone el foco en el campo. Con `message`, lo envía como si lo escribiera el visitante (si hay un turno en curso, sale al terminar). |
| `close()` | Cierra y devuelve el foco a lo que lo tenía al abrir. |
| `toggle()` | Abre o cierra. |
| `isOpen()` | `true` / `false`. Antes de la configuración, `false`. |
| `setContext({ page?, topic?, lang? })` | Como mucho 5 claves de texto (nombre `[A-Za-z][A-Za-z0-9_-]{0,31}`), valores recortados a 120 caracteres. Viaja como `context` en cada mensaje. `setContext(null)` lo borra. |
| `setTheme('light' \| 'dark')` | Fija el tema (deja de seguir `auto`). |
| `configure({ welcome?, prompts? })` | Sustituye en local el saludo y las sugerencias (hasta 6). Si el saludo ya está en pantalla y nadie ha escrito, se cambia ahí también. |

### Cargarlo solo al abrir

```js
let carga;
function chat() {
  if (window.KairikosChat) return Promise.resolve(window.KairikosChat);
  return (carga ??= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://portal.kairikos.com/widget/embed.v2.js';
    s.async = true;
    s.dataset.spaceToken = 'wgt_…';
    s.dataset.launcher = 'none';
    s.dataset.lang = 'en';
    s.dataset.links = 'same-origin';
    s.onload = () => ok(window.KairikosChat);
    s.onerror = ko;
    document.head.appendChild(s);
  }));
}
botonChat.addEventListener('click', () => chat().then((c) => c.open()));
```

Si la configuración falla (token inválido, widget apagado, portal caído), no se
pinta nada y **no llega `kairikos:chat_ready`**: la web puede usarlo para decidir
qué hace su botón.

## Eventos (`CustomEvent` en `window`)

Nunca llevan el texto de los mensajes ni datos de contacto.

| Evento | `detail` |
|---|---|
| `kairikos:chat_ready` | `{}` — configuración recibida, widget pintado. |
| `kairikos:chat_open` | `{}` — no se emite al reabrirse solo tras navegar (ver abajo). |
| `kairikos:chat_close` | `{}` |
| `kairikos:chat_message` | `{ role: 'user', mode: 'typed' \| 'prompt' \| 'api' }` — cómo lo envió: escrito, sugerencia o `open({ message })`.<br>`{ role: 'bot', mode }` — el `mode` del servidor: `portal` (respuesta del motor), `human`, `cap`, `fallback`, `unavailable`; `error` si falló la red. |
| `kairikos:chat_contact` | `{}` — formulario de contacto enviado y guardado. |
| `kairikos:chat_link` | `{ href }` — el visitante pulsó un enlace del bot. |

```js
window.addEventListener('kairikos:chat_link', (e) => gtag('event', 'chat_link', { link_url: e.detail.href }));
```

## Enlaces (`data-links="same-origin"`)

En las respuestas del bot se convierten en `<a>` los enlaces markdown `[texto](url)`,
las URL `http(s)` sueltas y las rutas sueltas (`/reserva/?origen=chat`), **solo si**
son rutas que empiezan por `/` (no `//`) o tienen el mismo origen que
`location.origin`. Una ruta suelta cuenta si va al principio o tras un espacio o un
signo de apertura y sigue una letra o un número: «y/o» o «24/7» no son enlaces. Es
la forma en la que el bot da las rutas de verdad: las copia de las preguntas
frecuentes tal cual, sin markdown. Todo lo demás (otro dominio,
`javascript:`, `mailto:`…) queda como el texto que era. La puntuación final de una
URL suelta no forma parte del enlace. El DOM se construye nodo a nodo: nunca
`innerHTML` con texto del servidor.

Al pulsar, se emite `kairikos:chat_link` y navega el propio `<a>` en la misma
pestaña (Ctrl/Cmd+clic sigue abriendo otra).

**Continuidad al navegar.** Solo con `data-links="same-origin"`, el widget guarda en
`sessionStorage` de la pestaña (`kairikos-chat-v2:<token>`) el id de sesión, lo que
se ve del hilo (hasta 60 mensajes) y si el panel estaba abierto. En la página
siguiente, cuando el script se carga, restaura el hilo y reabre el panel sin robar
el foco ni emitir `chat_open`. Con carga perezosa, la web tiene que cargarlo ya si
había un chat abierto:

```js
try {
  const s = JSON.parse(sessionStorage.getItem('kairikos-chat-v2:wgt_…') || 'null');
  if (s?.open) chat();
} catch {}
```

Sin `data-links`, cada página es una conversación nueva, como en v1.

> El bot solo da enlaces que estén en su configuración o en su base de conocimiento:
> el prompt no le pide enlazar. Para que enlace a `/reservar`, esa ruta tiene que
> aparecer en las preguntas frecuentes o en el material del negocio.

## Avisos

- **IA** (siempre): bajo la cabecera, «Asistente con IA. Puede equivocarse.» /
  «AI assistant. It can make mistakes.» (art. 50 del Reglamento de IA de la UE).
- **Datos de salud**: si la configuración trae `sensitiveDataNotice` (no nulo), se
  muestra encima del campo de texto hasta el primer mensaje del visitante.

## Accesibilidad

Panel con `role="dialog"` y nombre («Chat con {negocio}»); foco al campo al abrir y
de vuelta al disparador al cerrar; Esc cierra; lo que dice el bot se anuncia en una
región `aria-live="polite"` aparte (para no repetir lo que escribe la persona); foco
visible; objetivos de 44 px; sin animación con `prefers-reduced-motion`. Por debajo
de 480 px de ancho el panel ocupa la pantalla, dejando `data-offset` libre abajo.
No atrapa el foco (no es modal).

## Servidor

| Ruta | Cambio (compatible con v1) |
|---|---|
| `POST /api/public/channels/web/message` | Acepta `context` opcional. Se valida aparte (`src/lib/web-widget-context.ts`): todo o nada, uno inválido se ignora sin 400. Llega al motor como una línea («El visitante está en la página «/x» (tema: y)»), rotulada en el prompt como dato de la visita y no instrucciones. No se guarda en el transcript. |
| `GET /api/public/channels/web/config` | Añade `privacy: { url, controller }` desde el paso 10 **aprobado** (`url_politica_privacidad`, `responsable_tratamiento`), o `null` si no lo hay. Añade `sensitiveDataNotice`: texto cuando el paso 1 aprobado del chatbot tiene `vertical: 'clinica'`, `null` en otro caso. `?lang=en` o `?lang=de` lo da en ese idioma (otro valor, español). Con `?lang=`, el saludo **por defecto** (el negocio no escribió el suyo en el paso 9) sale traducido; un saludo propio del negocio no se toca. |

| `POST /api/public/channels/web/contact` | Acepta `consent`, `noticeVersion` y `privacyLinkShown`. Ver la sección siguiente. Además actualiza `duration` de la conversación, que antes no tocaba. |

## Formulario de contacto: aviso y consentimiento

Desde el 25/11/2026 (contrato de encargo del tratamiento de Web Premium, PR 3 de
`plan-portal-encargo-tratamiento.md`). Cuando el bot deriva, el formulario que pide
nombre y teléfono o correo enseña:

1. **Aviso de primera capa:** «Responsable: {responsable}. Finalidad: responder a
   esta consulta.» El responsable es `privacy.controller` (paso 10) y, sin él, el
   nombre del negocio.
2. **Casilla obligatoria:** «He leído la política de privacidad y acepto que se usen
   mis datos para responder a mi consulta.» con el enlace «Política de privacidad»
   (nueva pestaña, `rel="noopener noreferrer"`). Sin marcarla, el widget no envía y
   dice «Falta aceptar la política de privacidad.».

Los textos van en primera persona o impersonales para que valgan igual en una web
de tú o de usted, en `es`, `en` y `de`.

**URL de la política, por orden:** `data-privacy-url` del `<script>`; si no, la del
paso 10 (`privacy.url` de la configuración); si no hay ninguna, el aviso y la casilla
salen **sin enlace**, el widget escribe un `console.warn`, el envío lleva
`privacyLinkShown: false` y el servidor registra `widget.privacy_url_missing`.
El negocio ve además un aviso en **Portal → Canales → Web** (el portal solo conoce el
paso 10, no el atributo de la web).

**Versión del aviso.** El envío lleva `consent: true` y `noticeVersion`
(`2026-12-v1`). Los textos de cada versión, en los tres idiomas, quedan escritos en
`WIDGET_CONTACT_NOTICES` (`src/lib/web-widget-context.ts`), **append-only**: para
cambiar una palabra se crea versión nueva allí y se sube `CONTACT_NOTICE_VERSION` en
el widget. Un test exige que los textos del widget sean idénticos a los de su versión.

**Servidor** (`/contact`):

| Envío | Respuesta | Conversación |
|---|---|---|
| `noticeVersion` conocida y `consent: true` | 200 | `contact_consent_at` = ahora, `contact_notice_version` = la versión |
| `noticeVersion` conocida sin `consent: true` | 400 `consent_required` | no se toca |
| `noticeVersion` desconocida | 400 `bad_request` | no se toca |
| sin `noticeVersion` (embed.js v1, o una pestaña abierta con el v2 anterior) | 200 | columnas sin tocar (NULL); log `widget_contact.legacy_no_consent` |

La conversación del portal (`/portal/conversations/<id>`) enseña «Consentimiento:
fecha (versión …)» cuando lo hay.

**v1 no cambia:** `embed.js` está congelado y no tiene casilla; sus envíos se
aceptan como siempre y se cuentan con el log de arriba.

## Dominios permitidos

Desde el 16/11/2026 cada widget puede tener una lista de webs desde las que
funciona (`ChatWebEmbed.allowedOrigins`, hasta 10). Vale para v1 y v2: ninguno de
los dos archivos cambia, lo comprueba el servidor.

- **Vacía** (lo que tienen todos los widgets hasta que alguien la rellena): sin
  restricción, como siempre.
- **Con algo**: `config`, `message` y `contact` miran la cabecera `Origin` (o, si
  falta, el origen del `Referer`) y, si no está en la lista, contestan lo mismo que
  a un widget apagado, con las cabeceras CORS de siempre. `message` no llega a
  llamar al motor, que es lo que gasta el tope mensual. Sin `Origin` ni `Referer`
  tampoco contesta. Hay que poner cada variante que se use: `https://www.x.com` y
  `https://x.com` son orígenes distintos, y `http://localhost:4321` para probar en
  local.

La edita el cliente en **Portal → Canales → Web** («Webs donde funciona el chat»,
una por línea; se guarda normalizada: `www.x.com/contacto` queda
`https://www.x.com`). Ruta: `PUT /api/portal/channels/web/origins`. Cada cambio
deja una fila en `chat_web_embed_audit` con la lista de antes y la de después.

El operador la edita desde la ficha del cliente (`/admin/portal/<cliente>?product=chatbot`
→ Canales → «Widget web: webs permitidas»), que enseña también los últimos cambios
y quién los hizo. Ruta: `PUT /api/admin/portal/clients/<id>/web-widget-origins`
(`?clientProductId=` con varios chatbots); la auditoría queda a nombre del operador.

**Limitación aceptada:** `Origin` lo pone el navegador, pero cualquiera lo falsea
desde curl. La lista impide reutilizar el snippet en otra web —el abuso fácil—, no
un script. Contra eso siguen los frenos por minuto de cada ruta y el tope mensual.

## Idiomas

`es` (por defecto), `en` y `de` (desde el 15/11/2026). Se mira la parte principal
de la etiqueta sin mayúsculas: `de-AT` o `EN` valen. Un idioma que no está cae en
español, como antes.

Lo que traduce el idioma: los textos del widget (botones, aviso de IA, campo,
formulario de contacto con su aviso de privacidad y casilla, errores), el aviso de datos de salud y el saludo por
defecto (los da el servidor con `?lang=`) y las respuestas de reserva del servidor
(las traduce el widget). Lo que **no**: el saludo y las sugerencias que escribió el
negocio — la web los pone en su idioma con `configure()` — y las respuestas del
bot, que salen en el idioma del visitante si el negocio lo tiene en el paso 1.

Para añadir otro idioma: un bloque más en `TEXTS` y en `SERVER_REPLIES` de
`embed.v2.js` (un test exige las mismas claves que el español), y el idioma en
`WIDGET_LANGS`, `SENSITIVE_DATA_NOTICE` y `DEFAULT_WELCOME` de
`src/lib/web-widget-context.ts`, y una **versión nueva** de `WIDGET_CONTACT_NOTICES`
con los tres textos del aviso de privacidad en todos los idiomas (las publicadas no
se editan).

## Limitaciones conocidas

- Las respuestas de reserva del servidor (`human`, `cap`, `fallback`,
  `unavailable`) están en español en la ruta; con `data-lang="en"` o `"de"` las
  traduce el widget según `mode`. Las respuestas del motor salen en inglés o
  alemán solo si el negocio tiene `EN` o `DE` en los idiomas del paso 1.
- El contexto lo puede falsear cualquiera que llame a la ruta, igual que el
  mensaje. No da más poder que el mensaje: es orientación, no autorización.
- Sin enlaces activados no hay continuidad entre páginas (como v1).
- El consentimiento solo cubre el formulario de contacto. Si el visitante escribe
  su teléfono o correo directamente en el chat (el bot también los pide), eso no
  pasa por la casilla y no queda registrado.
- `embed.v2.js` se sirve sin versión en la URL: un cambio llega a todas las webs v2
  al desplegar, y una pestaña ya abierta sigue con el script anterior (por eso se
  aceptan los envíos sin `noticeVersion`).
