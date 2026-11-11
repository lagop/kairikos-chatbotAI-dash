/**
 * Kairikos — widget de chat embebible, versión 2.
 *
 * Contrato completo en docs/widget-v2.md. Resumen:
 *
 *   <script src="https://portal.kairikos.com/widget/embed.v2.js" data-space-token="wgt_..." async
 *     data-launcher="bubble|none" data-lang="es|en" data-theme="light|dark|auto"
 *     data-font="..." data-accent="#1f7f77" data-links="none|same-origin" data-offset="88"></script>
 *
 * Por qué un archivo nuevo y no cambios en embed.js: todos los clientes cargan
 * embed.js desde la misma URL, así que cualquier cambio en él les llega a la
 * vez y sin aviso. v2 nace para las webs Kairikos Signature (abrir el chat
 * desde su propio botón, marca, inglés, contexto de página, enlaces, eventos
 * de conversión) y embed.js queda congelado — hay un test que compara su hash.
 *
 * Sin ningún atributo nuevo, v2 se ve como v1 salvo en cuatro cosas, todas a
 * propósito:
 *   - el aviso de IA bajo la cabecera (art. 50 del Reglamento de IA de la UE);
 *   - un botón de cerrar en la cabecera (sin él, el panel a pantalla completa
 *     del móvil no se podría cerrar, y un diálogo necesita uno);
 *   - en móvil (< 480 px) el panel ocupa la pantalla;
 *   - botones de 44 px de alto (objetivos táctiles).
 *
 * Igual que v1: dos llamadas de red (configuración y un POST por mensaje),
 * Shadow DOM para aislar el CSS en los dos sentidos, y si la configuración
 * falla no se pinta nada — mejor nada que un widget roto en la web de un
 * cliente.
 *
 * Nunca se usa innerHTML con texto que venga del servidor: el texto del bot
 * se convierte en nodos uno a uno (ver renderBotText). Los eventos que se
 * emiten en window nunca llevan el texto de los mensajes ni datos de
 * contacto: los escucha la analítica de la web, y eso no puede acabar en
 * Google Analytics.
 */
(function () {
  'use strict';

  var currentScript = document.currentScript;
  if (!currentScript) return;

  // Dos <script> de v2 en la misma página (pasa al cargarlo de forma perezosa
  // desde dos botones): el segundo no hace nada, el primero ya tiene la API.
  if (window.KairikosChat && window.KairikosChat.__v2) return;

  var publicToken = currentScript.getAttribute('data-space-token');
  if (!publicToken) {
    console.error('[Kairikos widget] falta data-space-token en el <script>.');
    return;
  }

  var portalOrigin = (function () {
    try {
      return new URL(currentScript.src).origin;
    } catch (e) {
      return '';
    }
  })();

  function attr(name) {
    var value = currentScript.getAttribute(name);
    return value == null ? '' : String(value).trim();
  }

  var OPTIONS = {
    launcher: attr('data-launcher') === 'none' ? 'none' : 'bubble',
    lang: attr('data-lang') === 'en' ? 'en' : 'es',
    theme: attr('data-theme') === 'dark' || attr('data-theme') === 'auto' ? attr('data-theme') : 'light',
    font: attr('data-font'),
    accent: attr('data-accent'),
    links: attr('data-links') === 'same-origin' ? 'same-origin' : 'none',
    offset: (function () {
      var raw = attr('data-offset');
      if (!raw) return null;
      var n = parseInt(raw, 10);
      return isFinite(n) && n >= 0 && n <= 1000 ? n : null;
    })(),
  };

  var TEXTS = {
    es: {
      open: 'Abrir chat',
      close: 'Cerrar chat',
      dialog: 'Chat con ',
      aiNotice: 'Asistente con IA. Puede equivocarse.',
      placeholder: 'Escribe un mensaje…',
      send: 'Enviar',
      typing: 'Escribiendo…',
      prompts: 'Sugerencias',
      fallbackReply: 'Lo siento, no he podido procesar tu mensaje. Inténtalo de nuevo en un momento.',
      connError: 'Lo siento, hubo un problema de conexión. Inténtalo de nuevo en un momento.',
      contactTitle: 'Déjame tu teléfono o tu correo y el equipo te contesta.',
      contactName: 'Tu nombre (opcional)',
      contactValue: 'Teléfono o correo',
      contactSend: 'Enviar mis datos',
      contactShort: 'Escribe un teléfono o un correo.',
      contactFail: 'No he podido guardarlo. Inténtalo otra vez.',
      contactThanks: 'Gracias. El equipo te escribirá en cuanto pueda.',
    },
    en: {
      open: 'Open chat',
      close: 'Close chat',
      dialog: 'Chat with ',
      aiNotice: 'AI assistant. It can make mistakes.',
      placeholder: 'Type a message…',
      send: 'Send',
      typing: 'Typing…',
      prompts: 'Suggestions',
      fallbackReply: "Sorry, I couldn't process your message. Please try again in a moment.",
      connError: 'Sorry, there was a connection problem. Please try again in a moment.',
      contactTitle: 'Leave your phone or email and the team will get back to you.',
      contactName: 'Your name (optional)',
      contactValue: 'Phone or email',
      contactSend: 'Send my details',
      contactShort: 'Please enter a phone number or an email.',
      contactFail: "I couldn't save it. Please try again.",
      contactThanks: 'Thanks. The team will write to you as soon as they can.',
    },
  };
  var T = TEXTS[OPTIONS.lang];

  // Las respuestas de reserva del servidor (traspaso, tope, fallo de la IA)
  // están escritas en español en la ruta /message. En una web en inglés se
  // sustituyen aquí por su traducción, según `mode`. Las respuestas normales
  // del bot (`mode: 'portal'`) no se tocan: el motor ya contesta en el idioma
  // del visitante si el negocio tiene el inglés en el paso 1.
  var EN_SERVER_REPLIES = {
    human: 'Someone from the team is with you now. Write your message here and they will see it shortly.',
    cap: "I can't reply here right now. Leave your question with an email or phone number and the team will get back to you shortly.",
    fallbackContact:
      'Thanks for writing. To help you better, tell me your name and an email or phone number, and the team will reply shortly.',
    fallback:
      "Thanks for your message. I can't give you a detailed answer right now, but the team will review it. If you like, leave me your contact details.",
    unavailable: 'This chat is not available right now.',
  };

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  // Con enlaces activos el visitante va a navegar desde el chat, y v1 empieza
  // una conversación nueva en cada página (el id de sesión es por pageview):
  // pulsar un enlace del bot borraría lo hablado. Por eso, solo con
  // data-links="same-origin", la sesión y lo que se ve del hilo se guardan en
  // sessionStorage de la pestaña. Sin enlaces, cada página es una
  // conversación nueva, igual que v1.
  var PERSIST = OPTIONS.links === 'same-origin';
  var STORAGE_KEY = 'kairikos-chat-v2:' + publicToken;
  var MAX_STORED_MESSAGES = 60;

  function readStored() {
    if (!PERSIST) return null;
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  var stored = readStored();

  var STATE = {
    config: null,
    rendered: false,
    open: false,
    sending: false,
    // Una sola vez por conversación, como en v1.
    contactAsked: stored ? !!stored.contactAsked : false,
    sessionId:
      (stored && stored.sessionId) ||
      'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    // Lo que se ve en el hilo: [{ role: 'user'|'bot', text }]. Solo se usa
    // para restaurarlo tras navegar (ver PERSIST).
    messages: stored ? stored.messages.slice(-MAX_STORED_MESSAGES) : [],
    wasOpen: stored ? !!stored.open : false,
    context: null,
    themeOverride: null,
    overrides: { welcome: null, prompts: null },
    queue: [],
    pendingApiMessage: null,
  };

  function persist() {
    if (!PERSIST) return;
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessionId: STATE.sessionId,
          messages: STATE.messages.slice(-MAX_STORED_MESSAGES),
          open: STATE.open,
          contactAsked: STATE.contactAsked,
        }),
      );
    } catch (e) {
      // Navegación privada o almacenamiento bloqueado: se sigue sin guardar.
    }
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('kairikos:' + name, { detail: detail || {} }));
    } catch (e) {
      // Un navegador sin CustomEvent como constructor no rompe el chat.
    }
  }

  // ---------------------------------------------------------------------------
  // Utilidades de DOM
  // ---------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') node.textContent = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      node.appendChild(child);
    });
    return node;
  }

  function svgIcon(pathD) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  function isValidColor(value) {
    if (!value) return false;
    try {
      return !!(window.CSS && CSS.supports && CSS.supports('color', value));
    } catch (e) {
      return false;
    }
  }

  /** Blanco o casi negro sobre el color de acento, el que contraste más. Solo
   *  sabe leer #rgb y #rrggbb; con cualquier otro formato, blanco (como v1). */
  function textOn(color) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || '');
    if (!m) return '#fff';
    var hex = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
    var rgb = [0, 2, 4].map(function (i) {
      var c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    // Contraste contra blanco vs. contra #111.
    return (1.05 / (lum + 0.05)) >= ((lum + 0.05) / 0.0559) ? '#fff' : '#111';
  }

  // ---------------------------------------------------------------------------
  // Enlaces en las respuestas del bot
  //
  // Solo con data-links="same-origin". Se aceptan rutas relativas que empiezan
  // por "/" (no "//", que es otro dominio) y URL absolutas http(s) con el
  // mismo origen que la página. Todo lo demás —otro dominio, javascript:,
  // mailto:, data:…— se queda como el texto que era. Nada pasa por innerHTML.
  //
  // Tres formas: markdown [texto](url), URL absoluta suelta y ruta suelta
  // («reserva aquí: /reserva/?origen=chat»). La tercera se añadió el 11/11/2026
  // al probar contra producción: el bot copia las rutas de las preguntas
  // frecuentes tal cual, sin markdown, y quedaban como texto. Solo cuenta si va
  // al principio o tras un espacio o signo de apertura, y si sigue una letra,
  // un número, «_» o «-»: así «y/o», «24/7» o «//otro-dominio» no son enlaces.
  // Sin lookbehind a propósito: Safari anterior a 16.4 no lo entiende y la
  // regex rompería el script entero.
  // ---------------------------------------------------------------------------

  var LINK_RE =
    /\[([^\]\n]{1,200})\]\(([^()\s]{1,500})\)|(https?:\/\/[^\s<>"'()\[\]]+)|(^|[\s(«"'¿¡:])(\/[A-Za-z0-9_\-][^\s<>"'()\[\]«»]*)/g;

  function safeHref(raw) {
    if (!raw) return null;
    var value = String(raw).trim();
    try {
      if (value.charAt(0) === '/' && value.charAt(1) !== '/' && value.charAt(1) !== '\\') {
        var rel = new URL(value, window.location.origin);
        return rel.origin === window.location.origin ? rel.href : null;
      }
      var abs = new URL(value);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
      return abs.origin === window.location.origin ? abs.href : null;
    } catch (e) {
      return null;
    }
  }

  function makeLink(text, href) {
    var a = el('a', { href: href, class: 'kw-link', text: text });
    a.addEventListener('click', function () {
      // Solo el destino, nunca el texto de la conversación.
      emit('chat_link', { href: href });
      STATE.open = true;
      persist();
      // La navegación la hace el propio <a>, en la misma pestaña. Así siguen
      // funcionando Ctrl/Cmd+clic y el botón central.
    });
    return a;
  }

  /** El texto del bot como nodos: texto plano y, si se permiten, <a>. */
  function renderBotText(container, text) {
    if (OPTIONS.links !== 'same-origin') {
      container.textContent = text;
      return;
    }
    var last = 0;
    var match;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(text)) !== null) {
      var whole = match[0];
      var label;
      var target;
      var trailing = '';
      // Dónde empieza el enlace: en una ruta suelta, después del espacio o
      // signo que la precede (que se queda como texto).
      var start = match.index;
      if (match[1] !== undefined) {
        label = match[1];
        target = match[2];
      } else {
        // URL o ruta suelta: la puntuación final es de la frase, no del enlace.
        var url = match[3] !== undefined ? match[3] : match[5];
        if (match[3] === undefined) start = match.index + match[4].length;
        var punct = /[.,;:!?…]+$/.exec(url);
        if (punct) {
          trailing = punct[0];
          url = url.slice(0, url.length - trailing.length);
        }
        label = url;
        target = url;
        whole = url;
      }
      var href = safeHref(target);
      if (!href) continue;
      if (start > last) container.appendChild(document.createTextNode(text.slice(last, start)));
      container.appendChild(makeLink(label, href));
      last = start + whole.length;
      // La puntuación que se separó vuelve como texto en la siguiente vuelta.
      LINK_RE.lastIndex = last;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  // ---------------------------------------------------------------------------
  // Estilos
  // ---------------------------------------------------------------------------

  function buildStyles() {
    return (
      '.kw-root{' +
      '--kw-on-accent:#fff;--kw-bg:#fff;--kw-surface:#f7f7f8;--kw-bot-bg:#eceef1;--kw-bot-fg:#1a1a1a;' +
      '--kw-fg:#1a1a1a;--kw-muted:#5f6368;--kw-border:#d8d8dd;--kw-border-soft:#e6e6ea;--kw-input-bg:#fff;' +
      '--kw-chip-fg:#333;--kw-error:#b3261e;--kw-notice-bg:#fff6e0;--kw-notice-fg:#5c4300;--kw-focus:var(--kw-accent);' +
      '--kw-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
      '.kw-root.kw-dark{' +
      '--kw-bg:#17191e;--kw-surface:#0f1114;--kw-bot-bg:#262a31;--kw-bot-fg:#ececf0;--kw-fg:#ececf0;' +
      '--kw-muted:#a7abb4;--kw-border:#3a3f48;--kw-border-soft:#2a2e35;--kw-input-bg:#1d2026;--kw-chip-fg:#e2e3e7;' +
      '--kw-error:#ff8a80;--kw-notice-bg:#2b2410;--kw-notice-fg:#f3d9a4;--kw-focus:#e8eaed;}' +
      '.kw-bubble{position:fixed;bottom:20px;width:56px;height:56px;border-radius:50%;background:var(--kw-accent);' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;padding:0;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;}' +
      '.kw-bubble svg{width:26px;height:26px;fill:var(--kw-on-accent);}' +
      '.kw-window{position:fixed;bottom:var(--kw-offset);width:340px;max-width:calc(100vw - 32px);' +
      'height:480px;max-height:calc(100vh - var(--kw-offset) - 52px);background:var(--kw-bg);color:var(--kw-fg);' +
      'border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;' +
      'font-family:var(--kw-font);z-index:2147483000;animation:kw-in .16s ease-out;}' +
      // `hidden` tiene que ganar a las clases que fijan display (flex).
      '.kw-root [hidden]{display:none !important;}' +
      '@keyframes kw-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}' +
      '.kw-header{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 16px;min-height:44px;' +
      'background:var(--kw-accent);color:var(--kw-on-accent);flex-shrink:0;}' +
      '.kw-title{flex:1;font-weight:600;font-size:14px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.kw-close{width:44px;height:44px;border:none;background:transparent;color:inherit;border-radius:10px;' +
      'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;}' +
      '.kw-close svg{width:20px;height:20px;fill:currentColor;}' +
      '.kw-ai{font-size:11.5px;line-height:1.35;color:var(--kw-muted);padding:6px 16px;' +
      'border-bottom:1px solid var(--kw-border-soft);background:var(--kw-bg);flex-shrink:0;}' +
      '.kw-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--kw-surface);}' +
      '.kw-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;' +
      'overflow-wrap:anywhere;}' +
      '.kw-msg-bot{align-self:flex-start;background:var(--kw-bot-bg);color:var(--kw-bot-fg);border-bottom-left-radius:4px;}' +
      '.kw-msg-user{align-self:flex-end;background:var(--kw-accent);color:var(--kw-on-accent);border-bottom-right-radius:4px;}' +
      '.kw-link{color:inherit;text-decoration:underline;text-underline-offset:2px;font-weight:600;border-radius:3px;}' +
      '.kw-prompts{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;flex-shrink:0;}' +
      '.kw-prompt-btn{border:1px solid var(--kw-border);background:var(--kw-input-bg);border-radius:999px;' +
      'padding:6px 12px;min-height:44px;font-size:12px;cursor:pointer;color:var(--kw-chip-fg);font-family:inherit;}' +
      '.kw-sensitive{margin:0 12px 8px;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.4;' +
      'background:var(--kw-notice-bg);color:var(--kw-notice-fg);flex-shrink:0;}' +
      '.kw-inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid var(--kw-border-soft);flex-shrink:0;}' +
      '.kw-input{flex:1;border:1px solid var(--kw-border);border-radius:10px;padding:11px 10px;font-size:13px;' +
      'min-height:44px;box-sizing:border-box;resize:none;font-family:inherit;background:var(--kw-input-bg);color:var(--kw-fg);}' +
      '.kw-input::placeholder{color:var(--kw-muted);opacity:1;}' +
      '.kw-send{border:none;border-radius:10px;padding:0 14px;min-height:44px;min-width:44px;background:var(--kw-accent);' +
      'color:var(--kw-on-accent);font-size:13px;cursor:pointer;font-weight:600;font-family:inherit;}' +
      '.kw-send:disabled{opacity:.5;cursor:default;}' +
      '.kw-typing{font-size:12px;color:var(--kw-muted);padding:6px 12px 0;}' +
      '.kw-contact{align-self:stretch;background:var(--kw-bg);border:1px solid var(--kw-border);border-radius:12px;' +
      'padding:10px;display:flex;flex-direction:column;gap:6px;}' +
      '.kw-contact-title{font-size:12px;color:var(--kw-fg);line-height:1.4;}' +
      '.kw-contact-input{border:1px solid var(--kw-border);border-radius:8px;padding:7px 9px;min-height:44px;' +
      'box-sizing:border-box;font-size:13px;font-family:inherit;background:var(--kw-input-bg);color:var(--kw-fg);}' +
      '.kw-contact-send{border:none;border-radius:8px;padding:8px 10px;min-height:44px;background:var(--kw-accent);' +
      'color:var(--kw-on-accent);font-size:13px;cursor:pointer;font-weight:600;font-family:inherit;}' +
      '.kw-contact-send:disabled{opacity:.5;cursor:default;}' +
      '.kw-contact-error{font-size:12px;color:var(--kw-error);}' +
      '.kw-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);' +
      'white-space:nowrap;border:0;}' +
      // Foco visible en todo lo que se puede pulsar.
      '.kw-root :focus{outline:none;}' +
      '.kw-root :focus-visible{outline:2px solid var(--kw-focus);outline-offset:2px;}' +
      '.kw-input:focus-visible,.kw-contact-input:focus-visible{outline-offset:0;}' +
      '.kw-header :focus-visible{outline-color:var(--kw-on-accent);outline-offset:-4px;}' +
      // Móvil: el panel ocupa la pantalla, respetando data-offset por abajo
      // (barras fijas de la web, como un «Reservar» pegado al borde).
      '@media (max-width:479.98px){' +
      '.kw-window{top:0;left:0 !important;right:0 !important;bottom:var(--kw-offset-mobile);width:auto;max-width:none;' +
      'height:auto;max-height:none;border-radius:0;}' +
      '.kw-root.kw-is-open .kw-bubble{display:none;}' +
      '}' +
      '@media (prefers-reduced-motion:reduce){.kw-window{animation:none;}}'
    );
  }

  // ---------------------------------------------------------------------------
  // Interfaz
  // ---------------------------------------------------------------------------

  var UI = null;

  function currentWelcome() {
    return STATE.overrides.welcome || (STATE.config && STATE.config.welcomeMessage) || '';
  }

  function currentPrompts() {
    return STATE.overrides.prompts || (STATE.config && STATE.config.suggestedPrompts) || [];
  }

  function effectiveTheme() {
    if (STATE.themeOverride) return STATE.themeOverride;
    if (OPTIONS.theme === 'auto') {
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (e) {
        return 'light';
      }
    }
    return OPTIONS.theme;
  }

  function applyTheme() {
    if (!UI) return;
    if (effectiveTheme() === 'dark') UI.root.classList.add('kw-dark');
    else UI.root.classList.remove('kw-dark');
  }

  function render(config) {
    var host = el('div', { style: 'all:initial;', 'data-kairikos-chat': 'v2' });
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = buildStyles();
    shadow.appendChild(style);

    var accent = isValidColor(OPTIONS.accent) ? OPTIONS.accent : config.primaryColor || '#0E6B5E';
    var side = config.position === 'bottom-left' ? 'left' : 'right';
    var deskOffset = OPTIONS.offset != null ? OPTIONS.offset : OPTIONS.launcher === 'bubble' ? 88 : 20;

    var root = el('div', { class: 'kw-root', lang: OPTIONS.lang });
    root.style.setProperty('--kw-accent', accent);
    // Con el color del portal, texto blanco como en v1; con data-accent, el
    // que contraste (un acento claro con texto blanco no se lee).
    if (isValidColor(OPTIONS.accent)) root.style.setProperty('--kw-on-accent', textOn(OPTIONS.accent));
    if (OPTIONS.font) root.style.setProperty('--kw-font', OPTIONS.font);
    root.style.setProperty('--kw-offset', deskOffset + 'px');
    root.style.setProperty('--kw-offset-mobile', (OPTIONS.offset || 0) + 'px');

    var title = el('div', { class: 'kw-title', id: 'kw-title', text: config.businessName });
    var closeBtn = el('button', { class: 'kw-close', type: 'button', 'aria-label': T.close }, [
      svgIcon('M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z'),
    ]);
    var header = el('div', { class: 'kw-header' }, [title, closeBtn]);
    var aiNotice = el('div', { class: 'kw-ai', text: T.aiNotice });
    var messages = el('div', { class: 'kw-messages' });
    // Lo que dice el bot se anuncia desde aquí, no desde el hilo: así el
    // lector de pantalla no repite también lo que acaba de escribir la persona.
    var live = el('div', { class: 'kw-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
    var typing = el('div', { class: 'kw-typing', hidden: '', text: T.typing });
    var promptsRow = el('div', { class: 'kw-prompts', role: 'group', 'aria-label': T.prompts });
    var sensitive = el('div', { class: 'kw-sensitive', hidden: '' });
    var input = el('textarea', { class: 'kw-input', rows: '1', placeholder: T.placeholder, 'aria-label': T.placeholder });
    var sendBtn = el('button', { class: 'kw-send', type: 'button', text: T.send });
    var inputRow = el('div', { class: 'kw-inputrow' }, [input, sendBtn]);

    var win = el(
      'div',
      { class: 'kw-window', role: 'dialog', 'aria-label': T.dialog + config.businessName, hidden: '', id: 'kw-window' },
      [header, aiNotice, messages, typing, promptsRow, sensitive, inputRow, live],
    );
    win.style[side] = '20px';
    root.appendChild(win);

    var bubble = null;
    if (OPTIONS.launcher === 'bubble') {
      bubble = el(
        'button',
        { class: 'kw-bubble', type: 'button', 'aria-label': T.open, 'aria-expanded': 'false', 'aria-controls': 'kw-window' },
        [svgIcon('M4 4h16v12H7l-3 3V4z')],
      );
      bubble.style[side] = '20px';
      bubble.addEventListener('click', function () {
        toggle(bubble);
      });
      root.appendChild(bubble);
    }

    shadow.appendChild(root);
    document.body.appendChild(host);

    UI = {
      host: host,
      shadow: shadow,
      root: root,
      win: win,
      bubble: bubble,
      messages: messages,
      live: live,
      typing: typing,
      promptsRow: promptsRow,
      sensitive: sensitive,
      input: input,
      sendBtn: sendBtn,
      welcomeNode: null,
      trigger: null,
    };

    applyTheme();
    if (OPTIONS.theme === 'auto') {
      try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () {
          applyTheme();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) {
        // Sin matchMedia: se queda en claro.
      }
    }

    renderPrompts();
    renderSensitiveNotice();

    // El hilo de la página anterior (solo con PERSIST).
    STATE.messages.forEach(function (m) {
      appendMessageNode(m.role, m.text);
    });

    closeBtn.addEventListener('click', function () {
      close();
    });
    win.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    sendBtn.addEventListener('click', function () {
      sendMessage(null, 'typed');
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage(null, 'typed');
      }
    });

    STATE.rendered = true;
  }

  function renderPrompts() {
    if (!UI) return;
    while (UI.promptsRow.firstChild) UI.promptsRow.removeChild(UI.promptsRow.firstChild);
    var prompts = currentPrompts();
    prompts.forEach(function (prompt) {
      var btn = el('button', { class: 'kw-prompt-btn', type: 'button', text: prompt });
      btn.addEventListener('click', function () {
        sendMessage(prompt, 'prompt');
      });
      UI.promptsRow.appendChild(btn);
    });
    if (prompts.length === 0) UI.promptsRow.setAttribute('hidden', '');
    else UI.promptsRow.removeAttribute('hidden');
  }

  function hasUserMessage() {
    for (var i = 0; i < STATE.messages.length; i++) if (STATE.messages[i].role === 'user') return true;
    return false;
  }

  /** El aviso de datos sensibles, encima del campo, hasta el primer mensaje
   *  del visitante: después ya no sirve de aviso. */
  function renderSensitiveNotice() {
    if (!UI) return;
    var notice = STATE.config && STATE.config.sensitiveDataNotice;
    if (typeof notice === 'string' && notice.trim() && !hasUserMessage()) {
      UI.sensitive.textContent = notice;
      UI.sensitive.removeAttribute('hidden');
    } else {
      UI.sensitive.setAttribute('hidden', '');
    }
  }

  function appendMessageNode(role, text) {
    var msg = el('div', { class: role === 'user' ? 'kw-msg kw-msg-user' : 'kw-msg kw-msg-bot' });
    if (role === 'user') msg.textContent = text;
    else renderBotText(msg, text);
    UI.messages.appendChild(msg);
    UI.messages.scrollTop = UI.messages.scrollHeight;
    return msg;
  }

  function announce(text) {
    if (!UI) return;
    UI.live.textContent = '';
    // Un tick después, para que el lector detecte el cambio aunque el texto
    // se repita.
    setTimeout(function () {
      UI.live.textContent = text;
    }, 60);
  }

  function addMessage(role, text) {
    var node = appendMessageNode(role, text);
    STATE.messages.push({ role: role, text: text });
    if (role === 'bot') announce(text);
    persist();
    return node;
  }

  function setTyping(isTyping) {
    if (isTyping) UI.typing.removeAttribute('hidden');
    else UI.typing.setAttribute('hidden', '');
  }

  // Pide un teléfono o un correo, una vez por conversación, cuando el bot
  // deriva — por este canal nadie puede contestar al visitante. Igual que v1,
  // ver /api/public/channels/web/contact.
  function appendContactForm() {
    if (STATE.contactAsked) return;
    STATE.contactAsked = true;
    persist();

    var formTitle = el('div', { class: 'kw-contact-title', text: T.contactTitle });
    var nameInput = el('input', {
      class: 'kw-contact-input',
      type: 'text',
      placeholder: T.contactName,
      'aria-label': T.contactName,
      autocomplete: 'name',
    });
    var contactInput = el('input', {
      class: 'kw-contact-input',
      type: 'text',
      placeholder: T.contactValue,
      'aria-label': T.contactValue,
    });
    var error = el('div', { class: 'kw-contact-error', role: 'alert', hidden: '' });
    var submit = el('button', { class: 'kw-contact-send', type: 'button', text: T.contactSend });
    var form = el('div', { class: 'kw-contact', role: 'group', 'aria-label': T.contactTitle }, [
      formTitle,
      nameInput,
      contactInput,
      error,
      submit,
    ]);

    function showError(text) {
      error.textContent = text;
      error.removeAttribute('hidden');
    }

    function send() {
      var value = (contactInput.value || '').trim();
      if (value.length < 3) {
        showError(T.contactShort);
        return;
      }
      error.setAttribute('hidden', '');
      submit.disabled = true;
      fetch(portalOrigin + '/api/public/channels/web/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicToken: publicToken,
          sessionId: STATE.sessionId,
          name: (nameInput.value || '').trim(),
          contact: value,
        }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return null;
          });
        })
        .then(function (json) {
          if (json && json.success) {
            form.remove();
            addMessage('bot', T.contactThanks);
            // Sin el teléfono ni el correo: solo que ocurrió.
            emit('chat_contact', {});
            if (UI) UI.input.focus();
          } else {
            showError(T.contactFail);
            submit.disabled = false;
          }
        })
        .catch(function () {
          showError(T.contactFail);
          submit.disabled = false;
        });
    }

    submit.addEventListener('click', send);
    contactInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    UI.messages.appendChild(form);
    UI.messages.scrollTop = UI.messages.scrollHeight;
  }

  function serverReplyText(json) {
    var data = (json && json.data) || {};
    var mode = typeof data.mode === 'string' ? data.mode : 'error';
    if (OPTIONS.lang === 'en' && mode !== 'portal') {
      if (mode === 'fallback') return data.contactIntent ? EN_SERVER_REPLIES.fallbackContact : EN_SERVER_REPLIES.fallback;
      if (EN_SERVER_REPLIES[mode]) return EN_SERVER_REPLIES[mode];
      return T.fallbackReply;
    }
    return data.reply || T.fallbackReply;
  }

  /** source: 'typed' (campo de texto), 'prompt' (sugerencia) o 'api'
   *  (KairikosChat.open({ message })). Va en el evento como `mode` del turno
   *  del visitante, para que la web distinga cómo empezó la conversación. */
  function sendMessage(text, source) {
    if (!UI) return;
    var fromInput = text == null;
    var trimmed = String(fromInput ? UI.input.value || '' : text).trim();
    if (!trimmed || !STATE.config.chatEndpoint) return;
    if (STATE.sending) {
      // Lo que manda la web por la API no se pierde: sale al terminar el
      // turno en curso. Lo tecleado espera en el campo, como en v1.
      if (source === 'api') STATE.pendingApiMessage = trimmed;
      return;
    }
    addMessage('user', trimmed);
    emit('chat_message', { role: 'user', mode: source || 'typed' });
    if (fromInput) UI.input.value = '';
    STATE.sending = true;
    UI.sendBtn.disabled = true;
    setTyping(true);
    renderSensitiveNotice();

    var payload = {
      action: 'kairikos_chatbot',
      publicToken: publicToken,
      sessionId: STATE.sessionId,
      message: trimmed,
      timestamp: new Date().toISOString(),
    };
    if (STATE.context) payload.context = STATE.context;

    fetch(STATE.config.chatEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        var mode = json && json.data && typeof json.data.mode === 'string' ? json.data.mode : 'error';
        addMessage('bot', serverReplyText(json));
        emit('chat_message', { role: 'bot', mode: mode });
        if (json && json.data && json.data.askContact) appendContactForm();
      })
      .catch(function () {
        addMessage('bot', T.connError);
        emit('chat_message', { role: 'bot', mode: 'error' });
      })
      .then(function () {
        STATE.sending = false;
        UI.sendBtn.disabled = false;
        setTyping(false);
        var pending = STATE.pendingApiMessage;
        STATE.pendingApiMessage = null;
        if (pending) sendMessage(pending, 'api');
      });
  }

  // ---------------------------------------------------------------------------
  // Abrir y cerrar
  // ---------------------------------------------------------------------------

  /** Lo que tenía el foco al abrir, para devolvérselo al cerrar. Si el foco
   *  estaba dentro del propio widget (la burbuja), se mira dentro del shadow. */
  function focusedElement() {
    var active = document.activeElement;
    if (UI && active === UI.host) return UI.shadow.activeElement || UI.bubble;
    return active && active !== document.body ? active : null;
  }

  /** restoring: reabrir al volver de un enlace del chat. Ni roba el foco (en
   *  móvil sacaría el teclado al cargar la página) ni cuenta como apertura
   *  para la analítica: el visitante no ha abierto nada. */
  function doOpen(opts, trigger, restoring) {
    if (!UI) return;
    if (!STATE.open) {
      UI.trigger = trigger || focusedElement() || UI.bubble;
      STATE.open = true;
      UI.win.removeAttribute('hidden');
      UI.root.classList.add('kw-is-open');
      if (UI.bubble) {
        UI.bubble.setAttribute('aria-expanded', 'true');
        UI.bubble.setAttribute('aria-label', T.close);
      }
      if (STATE.messages.length === 0 && currentWelcome()) {
        UI.welcomeNode = addMessage('bot', currentWelcome());
      }
      persist();
      if (restoring) return;
      emit('chat_open');
    }
    try {
      UI.input.focus({ preventScroll: true });
    } catch (e) {
      UI.input.focus();
    }
    if (opts && typeof opts.message === 'string' && opts.message.trim()) {
      sendMessage(opts.message, 'api');
    }
  }

  function doClose() {
    if (!UI || !STATE.open) return;
    STATE.open = false;
    UI.win.setAttribute('hidden', '');
    UI.root.classList.remove('kw-is-open');
    if (UI.bubble) {
      UI.bubble.setAttribute('aria-expanded', 'false');
      UI.bubble.setAttribute('aria-label', T.open);
    }
    persist();
    emit('chat_close');
    var trigger = UI.trigger;
    UI.trigger = null;
    if (trigger && trigger.isConnected !== false && typeof trigger.focus === 'function') {
      try {
        trigger.focus({ preventScroll: true });
      } catch (e) {
        trigger.focus();
      }
    }
  }

  // Hasta que llega la configuración, abrir/cerrar se encolan (con el
  // elemento que tenía el foco EN EL MOMENTO de la llamada, que es al que hay
  // que volver) y se ejecutan en orden después.
  function whenReady(fn) {
    if (STATE.rendered) fn();
    else STATE.queue.push(fn);
  }

  function open(opts) {
    var trigger = STATE.rendered ? null : focusedElement();
    whenReady(function () {
      doOpen(opts, trigger);
    });
  }

  function close() {
    whenReady(doClose);
  }

  function toggle(trigger) {
    var t = trigger && trigger.nodeType === 1 ? trigger : STATE.rendered ? null : focusedElement();
    whenReady(function () {
      if (STATE.open) doClose();
      else doOpen(null, t);
    });
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------

  /** Como mucho 5 claves de texto, cada valor recortado a 120 caracteres. El
   *  servidor vuelve a comprobarlo (web-widget-context.ts) e ignora lo que no
   *  cumpla; recortar aquí evita que una página con un título largo pierda
   *  todo el contexto. */
  function setContext(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      STATE.context = null;
      return;
    }
    var out = {};
    var count = 0;
    Object.keys(ctx).forEach(function (key) {
      if (count >= 5) return;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) return;
      var value = ctx[key];
      if (typeof value !== 'string') return;
      value = value.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!value) return;
      out[key] = value;
      count += 1;
    });
    STATE.context = count > 0 ? out : null;
  }

  function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    STATE.themeOverride = theme;
    applyTheme();
  }

  /** Saludo y sugerencias locales (p. ej. en las páginas en inglés). Si el
   *  saludo ya está en pantalla y nadie ha escrito todavía, se cambia ahí
   *  también. */
  function configure(opts) {
    if (!opts || typeof opts !== 'object') return;
    if (typeof opts.welcome === 'string' && opts.welcome.trim()) {
      STATE.overrides.welcome = opts.welcome.trim();
      if (UI && UI.welcomeNode && STATE.messages.length === 1 && STATE.messages[0].role === 'bot') {
        UI.welcomeNode.textContent = '';
        renderBotText(UI.welcomeNode, STATE.overrides.welcome);
        STATE.messages[0].text = STATE.overrides.welcome;
        persist();
      }
    }
    if (Array.isArray(opts.prompts)) {
      STATE.overrides.prompts = opts.prompts
        .filter(function (p) {
          return typeof p === 'string' && p.trim();
        })
        .map(function (p) {
          return p.trim();
        })
        .slice(0, 6);
      renderPrompts();
    }
  }

  window.KairikosChat = {
    __v2: true,
    version: '2',
    open: function (opts) {
      open(opts);
    },
    close: function () {
      close();
    },
    toggle: function () {
      toggle(null);
    },
    isOpen: function () {
      return STATE.open;
    },
    setContext: setContext,
    setTheme: setTheme,
    configure: configure,
  };

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------

  function init() {
    if (!portalOrigin) return;
    var url = portalOrigin + '/api/public/channels/web/config?token=' + encodeURIComponent(publicToken);
    // Solo con data-lang="en": así una petición de v2 sin atributos es la
    // misma que la de v1.
    if (OPTIONS.lang === 'en') url += '&lang=en';
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('config_not_ok');
        return res.json();
      })
      .then(function (config) {
        if (!config.chatEndpoint) {
          console.warn('[Kairikos widget] chatEndpoint no configurado — el widget no se muestra.');
          return;
        }
        STATE.config = config;
        render(config);
        emit('chat_ready');
        var queued = STATE.queue;
        STATE.queue = [];
        queued.forEach(function (fn) {
          fn();
        });
        // Volver de un enlace del chat con el panel abierto (solo con PERSIST),
        // salvo que la web ya lo haya abierto o cerrado por la API.
        if (STATE.wasOpen && !STATE.open && queued.length === 0) doOpen(null, null, true);
      })
      .catch(function () {
        // Widget desactivado, token inválido o error de red: no se pinta nada
        // y no se emite chat_ready. Las llamadas encoladas se descartan.
        STATE.queue = [];
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
