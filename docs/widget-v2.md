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
></script>
```

| Atributo | Valores | Por defecto | Qué hace |
|---|---|---|---|
| `data-space-token` | `wgt_…` | — (obligatorio) | El widget del cliente. |
| `data-launcher` | `bubble` \| `none` | `bubble` | `none`: sin burbuja; la web lo abre con la API. |
| `data-lang` | `es` \| `en` | `es` | Textos de la interfaz. Con `en` también pide la configuración con `?lang=en` (aviso de salud en inglés) y traduce las respuestas de reserva del servidor. |
| `data-theme` | `light` \| `dark` \| `auto` | `light` | `auto` sigue `prefers-color-scheme`, también si cambia en vivo. |
| `data-font` | `font-family` CSS | sistema | La fuente tiene que estar cargada en la página (las `@font-face` del documento valen dentro del Shadow DOM). |
| `data-accent` | color CSS | `primaryColor` del portal | El texto sobre el acento se elige por contraste (blanco o casi negro). Con el color del portal, blanco como en v1. |
| `data-links` | `none` \| `same-origin` | `none` | Enlaces en las respuestas del bot (ver abajo). |
| `data-offset` | entero 0–1000 (px) | 88 con burbuja, 20 sin ella; 0 en móvil | Distancia del panel al borde inferior, para barras fijas de la web. |

Los atributos se leen **una vez**, al ejecutarse el script.

Sin ningún atributo nuevo, v2 se ve como v1 salvo en cuatro cosas: el aviso de IA,
un botón de cerrar en la cabecera, el panel a pantalla completa en móvil y botones
de 44 px de alto.

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
| `GET /api/public/channels/web/config` | Añade `sensitiveDataNotice`: texto cuando el paso 1 aprobado del chatbot tiene `vertical: 'clinica'`, `null` en otro caso. `?lang=en` lo da en inglés. |

## Limitaciones conocidas

- Las respuestas de reserva del servidor (`human`, `cap`, `fallback`,
  `unavailable`) están en español en la ruta; con `data-lang="en"` las traduce el
  widget según `mode`. Las respuestas del motor salen en inglés solo si el negocio
  tiene `EN` en los idiomas del paso 1.
- El contexto lo puede falsear cualquiera que llame a la ruta, igual que el
  mensaje. No da más poder que el mensaje: es orientación, no autorización.
- Sin enlaces activados no hay continuidad entre páginas (como v1).
