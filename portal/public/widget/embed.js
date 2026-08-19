/**
 * Kairikos — widget de chat embebible (Canales Fase 4).
 *
 * Vanilla JS, sin dependencias, en un único archivo. Se pega así en la
 * web de un cliente:
 *
 *   <script src="https://portal.kairikos.com/widget/embed.js" data-space-token="wgt_..."></script>
 *
 * Dos llamadas de red, nunca más:
 *   1. GET  {origin del propio script}/api/public/channels/web/config?token=...
 *      — trae nombre del negocio, copy de bienvenida/despedida, prompts
 *      sugeridos, color/posición, y la URL del webhook de n8n.
 *   2. POST directo a esa URL de n8n por cada mensaje — el tráfico de
 *      chat NO pasa por el portal (ver el plan de Canales, Fase 4: "el
 *      portal no está diseñado para eso").
 *
 * Aislado en Shadow DOM para que ni el CSS del sitio anfitrión rompa el
 * widget, ni el widget rompa el CSS del sitio anfitrión.
 */
(function () {
  'use strict';

  var currentScript = document.currentScript;
  if (!currentScript) return;

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

  var sessionId = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  var STATE = {
    config: null,
    open: false,
    sending: false,
    history: [],
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'style') {
          node.style.cssText = attrs[key];
        } else if (key === 'text') {
          node.textContent = attrs[key];
        } else {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach(function (child) {
      node.appendChild(child);
    });
    return node;
  }

  function buildStyles() {
    return (
      '.kw-bubble{position:fixed;bottom:20px;width:56px;height:56px;border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;}' +
      '.kw-bubble svg{width:26px;height:26px;fill:#fff;}' +
      '.kw-window{position:fixed;bottom:88px;width:340px;max-width:calc(100vw - 32px);' +
      'height:480px;max-height:calc(100vh - 140px);background:#fff;border-radius:14px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;z-index:2147483000;}' +
      '.kw-header{padding:14px 16px;color:#fff;font-weight:600;font-size:14px;flex-shrink:0;}' +
      '.kw-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8;}' +
      '.kw-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;}' +
      '.kw-msg-bot{align-self:flex-start;background:#eceef1;color:#1a1a1a;border-bottom-left-radius:4px;}' +
      '.kw-msg-user{align-self:flex-end;color:#fff;border-bottom-right-radius:4px;}' +
      '.kw-prompts{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px;flex-shrink:0;}' +
      '.kw-prompt-btn{border:1px solid #d8d8dd;background:#fff;border-radius:999px;padding:5px 10px;' +
      'font-size:12px;cursor:pointer;color:#333;}' +
      '.kw-inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid #e6e6ea;flex-shrink:0;}' +
      '.kw-input{flex:1;border:1px solid #d8d8dd;border-radius:10px;padding:8px 10px;font-size:13px;' +
      'resize:none;font-family:inherit;}' +
      '.kw-send{border:none;border-radius:10px;padding:0 14px;color:#fff;font-size:13px;cursor:pointer;font-weight:600;}' +
      '.kw-send:disabled{opacity:.5;cursor:default;}' +
      '.kw-typing{font-size:12px;color:#888;padding:0 12px 6px;}'
    );
  }

  function positionStyle(position, offsets) {
    return position === 'bottom-left' ? 'left:' + offsets + ';' : 'right:' + offsets + ';';
  }

  function renderShell(config) {
    var host = el('div', { style: 'all:initial;' });
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = buildStyles();
    shadow.appendChild(style);

    var bubble = el(
      'button',
      { class: 'kw-bubble', type: 'button', style: 'background:' + config.primaryColor + ';' + positionStyle(config.position, '20px'), 'aria-label': 'Abrir chat' },
      [
        (function () {
          var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.innerHTML = '<path d="M4 4h16v12H7l-3 3V4z"/>';
          return svg;
        })(),
      ],
    );

    var header = el('div', { class: 'kw-header', style: 'background:' + config.primaryColor + ';', text: config.businessName });
    var messages = el('div', { class: 'kw-messages' });
    var typing = el('div', { class: 'kw-typing', style: 'display:none;', text: 'Escribiendo…' });
    var promptsRow = el('div', { class: 'kw-prompts' });
    (config.suggestedPrompts || []).forEach(function (prompt) {
      var btn = el('button', { class: 'kw-prompt-btn', type: 'button', text: prompt });
      btn.addEventListener('click', function () {
        sendMessage(prompt);
      });
      promptsRow.appendChild(btn);
    });

    var input = el('textarea', { class: 'kw-input', rows: '1', placeholder: 'Escribe un mensaje…' });
    var sendBtn = el('button', { class: 'kw-send', type: 'button', style: 'background:' + config.primaryColor + ';', text: 'Enviar' });
    var inputRow = el('div', { class: 'kw-inputrow' }, [input, sendBtn]);

    var win = el('div', { class: 'kw-window', style: positionStyle(config.position, '20px') + 'display:none;' }, [
      header,
      messages,
      typing,
      promptsRow,
      inputRow,
    ]);

    shadow.appendChild(win);
    shadow.appendChild(bubble);
    document.body.appendChild(host);

    function appendMessage(role, text) {
      var msg = el('div', { class: role === 'user' ? 'kw-msg kw-msg-user' : 'kw-msg kw-msg-bot', text: text });
      if (role === 'user') msg.style.background = config.primaryColor;
      messages.appendChild(msg);
      messages.scrollTop = messages.scrollHeight;
    }

    function setTyping(isTyping) {
      typing.style.display = isTyping ? 'block' : 'none';
    }

    function sendMessage(text) {
      var trimmed = (text || input.value || '').trim();
      if (!trimmed || STATE.sending || !config.chatEndpoint) return;
      appendMessage('user', trimmed);
      input.value = '';
      STATE.sending = true;
      sendBtn.disabled = true;
      setTyping(true);

      fetch(config.chatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'kairikos_chatbot',
          publicToken: publicToken,
          sessionId: sessionId,
          message: trimmed,
          timestamp: new Date().toISOString(),
        }),
      })
        .then(function (res) {
          return res.json();
        })
        .then(function (json) {
          var reply = json && json.data && json.data.reply;
          appendMessage('bot', reply || 'Lo siento, no he podido procesar tu mensaje. Inténtalo de nuevo en un momento.');
        })
        .catch(function () {
          appendMessage('bot', 'Lo siento, hubo un problema de conexión. Inténtalo de nuevo en un momento.');
        })
        .finally(function () {
          STATE.sending = false;
          sendBtn.disabled = false;
          setTyping(false);
        });
    }

    sendBtn.addEventListener('click', function () {
      sendMessage();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    bubble.addEventListener('click', function () {
      STATE.open = !STATE.open;
      win.style.display = STATE.open ? 'flex' : 'none';
      if (STATE.open && messages.children.length === 0) {
        appendMessage('bot', config.welcomeMessage);
      }
    });
  }

  function init() {
    if (!portalOrigin) return;
    fetch(portalOrigin + '/api/public/channels/web/config?token=' + encodeURIComponent(publicToken))
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
        renderShell(config);
      })
      .catch(function () {
        // Widget desactivado, token inválido, o error de red — no
        // mostramos nada en la web del cliente antes que un widget roto.
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
