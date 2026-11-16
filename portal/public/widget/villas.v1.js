/**
 * Kairikos — reserva propia para villas, widget v1.
 *
 * Plan y decisiones: docs/plan-reserva-villas.md. Uso:
 *
 *   <div data-kairikos-villas="vil_..." data-lang="es|en"
 *        data-villa="alcornoque" data-privacy-url="/privacidad"
 *        data-fallback-email="reservas@ejemplo.es"></div>
 *   <script src="https://portal.kairikos.cloud/widget/villas.v1.js" async></script>
 *
 * Sin servicio (el token no existe o la contratación ya no está activa, la
 * API responde 404): en vez de un error en la web del cliente, se enseña el
 * contacto que el dueño dejó en el fragmento —data-fallback-url (otro sistema
 * de reservas), data-fallback-email o data-fallback-phone— y, sin ninguno, el
 * bloque desaparece. Un fallo puntual (red, 5xx) sigue diciendo que no se ha
 * podido cargar, porque ahí reintentar sí tiene sentido.
 *
 * Lo que hace: calendario por villa con el precio de cada noche, huéspedes,
 * precio TOTAL con IVA y su desglose antes de enviar nada, y el formulario de
 * SOLICITUD. No reserva ni cobra: el dueño confirma y, entonces, el huésped
 * recibe por correo el enlace para pagar el depósito en Stripe. La web del
 * cliente nunca ve una tarjeta.
 *
 * Lee los parámetros de la URL del motor del hotel (docs/reserva.md de la demo):
 * ?entrada=2026-12-14&salida=2026-12-21&adultos=2&ninos=0&unidad=<slug>&origen=google
 *
 * Por qué en el DOM de la página y no en Shadow DOM (al revés que embed.v2.js):
 * esto no es una burbuja flotante sino un bloque más de la web, y tiene que
 * heredar su tipografía y colores. Todas las clases llevan el prefijo kv- y el
 * aspecto se ajusta con variables CSS (--kv-accent, --kv-ink, --kv-muted,
 * --kv-line, --kv-surface, --kv-radius) desde la hoja de estilos de la web.
 *
 * Accesibilidad: la rejilla del calendario se recorre con las flechas (Inicio
 * y Fin para la semana, RePág/AvPág para el mes) y cada día se lee entero al
 * lector de pantalla: fecha, precio por noche y si está libre. Los cambios de
 * precio se anuncian en una región aria-live.
 *
 * Nunca innerHTML con texto que venga del servidor. Los eventos que se emiten
 * en window (kairikos:booking_*, el contrato del sector hotel) nunca llevan
 * nombre, email ni teléfono.
 */
(function () {
  'use strict';

  var currentScript = document.currentScript;
  var apiBase = (function () {
    try {
      return new URL(currentScript.src).origin;
    } catch (e) {
      return '';
    }
  })();

  var I18N = {
    es: {
      villa: 'Villa',
      adults: 'Adultos',
      children: 'Niños',
      checkIn: 'Llegada',
      checkOut: 'Salida',
      chooseIn: 'Elige el día de llegada',
      chooseOut: 'Ahora, el día de salida',
      prev: 'Mes anterior',
      next: 'Mes siguiente',
      free: 'libre',
      busy: 'no disponible',
      perNight: 'por noche',
      from: 'desde',
      minNights: function (n) { return 'Estancia mínima: ' + n + ' noches'; },
      nights: function (n) { return n + (n === 1 ? ' noche' : ' noches'); },
      base: 'Precio base',
      cleaning: 'Limpieza',
      tax: 'Tasa turística',
      total: 'Total, IVA incluido',
      vat: function (amount, pct) { return 'Incluye ' + amount + ' de IVA (' + pct + ')'; },
      deposit: function (pct) { return 'Depósito al confirmar (' + pct + ' %)'; },
      balance: 'Resto',
      noCharge: function (h) { return 'Esto es una solicitud: el anfitrión confirma en menos de ' + h + ' horas y hasta entonces no se cobra nada.'; },
      name: 'Nombre y apellidos',
      email: 'Email',
      phone: 'Teléfono (opcional)',
      message: 'Mensaje para el anfitrión (opcional)',
      consent: 'Acepto que mis datos se usen para gestionar esta solicitud.',
      privacy: 'Política de privacidad',
      send: 'Enviar solicitud',
      sending: 'Enviando…',
      sentTitle: 'Solicitud enviada',
      sentBody: function (ref, h) { return 'Tu referencia es ' + ref + '. El anfitrión confirma en menos de ' + h + ' horas; hasta entonces no se cobra nada. Te hemos enviado un correo con el resumen.'; },
      viewRequest: 'Ver tu solicitud',
      errors: {
        min_nights: function (n) { return 'Para esa llegada, la estancia mínima es de ' + n + ' noches.'; },
        too_many_guests: 'Sois más de los que caben en esta villa.',
        unavailable: 'Alguna de esas noches ya no está libre. Elige otras fechas.',
        past_dates: 'Esa fecha ya ha pasado.',
        too_far: 'Todavía no se puede reservar tan lejos.',
        too_long: 'Para estancias tan largas, escríbenos directamente.',
        invalid_dates: 'Revisa las fechas.',
        no_adults: 'Hace falta al menos un adulto.',
        too_many_requests: 'Demasiados intentos. Espera unos minutos.',
        generic: 'No se ha podido enviar. Inténtalo de nuevo.',
        load: 'No se ha podido cargar el calendario.',
      },
      fallback: { intro: 'Para reservar, contacta directamente con nosotros.', url: 'Reservar', email: 'Escríbenos', phone: 'Llámanos' },
      locale: 'es-ES',
    },
    en: {
      villa: 'Villa',
      adults: 'Adults',
      children: 'Children',
      checkIn: 'Arrival',
      checkOut: 'Departure',
      chooseIn: 'Choose your arrival day',
      chooseOut: 'Now choose your departure day',
      prev: 'Previous month',
      next: 'Next month',
      free: 'available',
      busy: 'not available',
      perNight: 'per night',
      from: 'from',
      minNights: function (n) { return 'Minimum stay: ' + n + ' nights'; },
      nights: function (n) { return n + (n === 1 ? ' night' : ' nights'); },
      base: 'Base rate',
      cleaning: 'Cleaning',
      tax: 'Tourist tax',
      total: 'Total, VAT included',
      vat: function (amount, pct) { return 'Includes ' + amount + ' VAT (' + pct + ')'; },
      deposit: function (pct) { return 'Deposit on confirmation (' + pct + ' %)'; },
      balance: 'Balance',
      noCharge: function (h) { return 'This is a request: the host confirms within ' + h + ' hours and nothing is charged until then.'; },
      name: 'Full name',
      email: 'Email',
      phone: 'Phone (optional)',
      message: 'Message for the host (optional)',
      consent: 'I agree to my data being used to handle this request.',
      privacy: 'Privacy policy',
      send: 'Send request',
      sending: 'Sending…',
      sentTitle: 'Request sent',
      sentBody: function (ref, h) { return 'Your reference is ' + ref + '. The host confirms within ' + h + ' hours; nothing is charged until then. We have emailed you a summary.'; },
      viewRequest: 'See your request',
      errors: {
        min_nights: function (n) { return 'For that arrival day, the minimum stay is ' + n + ' nights.'; },
        too_many_guests: 'That is more guests than this villa sleeps.',
        unavailable: 'Some of those nights are no longer available. Please choose other dates.',
        past_dates: 'That date has already passed.',
        too_far: 'Bookings are not open that far ahead yet.',
        too_long: 'For such long stays, please contact us directly.',
        invalid_dates: 'Please check the dates.',
        no_adults: 'At least one adult is required.',
        too_many_requests: 'Too many attempts. Please wait a few minutes.',
        generic: 'The request could not be sent. Please try again.',
        load: 'The calendar could not be loaded.',
      },
      fallback: { intro: 'To book, please contact us directly.', url: 'Book now', email: 'Email us', phone: 'Call us' },
      locale: 'en-GB',
    },
  };

  var CSS = [
    '.kv{--kv-accent:#1f7f77;--kv-ink:inherit;--kv-muted:#5b6b69;--kv-line:#d5e1df;--kv-surface:transparent;--kv-sel:var(--kv-accent);--kv-radius:10px;color:var(--kv-ink);font:inherit;max-width:44rem}',
    '.kv *{box-sizing:border-box}',
    '.kv-row{display:flex;flex-wrap:wrap;gap:.75rem;margin:0 0 1rem}',
    '.kv-field{display:flex;flex-direction:column;gap:.25rem;min-width:7rem;flex:1}',
    '.kv-field label,.kv-label{font-size:.85em;color:var(--kv-muted)}',
    '.kv select,.kv input,.kv textarea{font:inherit;color:inherit;background:var(--kv-surface);border:1px solid var(--kv-line);border-radius:calc(var(--kv-radius)*.6);padding:.55rem .65rem;min-height:44px;width:100%}',
    '.kv textarea{min-height:5rem}',
    '.kv-cal{border:1px solid var(--kv-line);border-radius:var(--kv-radius);padding:.75rem;background:var(--kv-surface)}',
    '.kv-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem}',
    '.kv-cal-title{font-weight:600}',
    // Solo la primera letra: «capitalize» daría «Noviembre De 2026».
    '.kv-cal-title::first-letter{text-transform:uppercase}',
    '.kv-nav{font:inherit;background:none;border:1px solid var(--kv-line);border-radius:999px;width:44px;height:44px;cursor:pointer;color:inherit}',
    '.kv-nav:disabled{opacity:.35;cursor:default}',
    '.kv-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;width:100%}',
    '.kv-dow{font-size:.75em;color:var(--kv-muted);text-align:center;padding:.25rem 0}',
    '.kv-day{font:inherit;color:inherit;background:none;border:1px solid transparent;border-radius:calc(var(--kv-radius)*.6);min-height:48px;padding:.2rem 0;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;line-height:1.1}',
    '.kv-day small{font-size:.68em;color:var(--kv-muted)}',
    '.kv-day[aria-disabled="true"]{cursor:default;opacity:.38;text-decoration:line-through}',
    '.kv-day.kv-in-range{background:color-mix(in srgb,var(--kv-accent) 14%,transparent)}',
    '.kv-day.kv-edge{background:var(--kv-sel);color:#fff}',
    '.kv-day.kv-edge small{color:inherit}',
    '.kv-day:focus-visible,.kv-nav:focus-visible,.kv-btn:focus-visible,.kv input:focus-visible,.kv select:focus-visible,.kv textarea:focus-visible{outline:3px solid var(--kv-accent);outline-offset:2px}',
    '.kv-hint{margin:.5rem 0 0;font-size:.9em;color:var(--kv-muted)}',
    '.kv-err{color:#b3261e;margin:.5rem 0 0}',
    '.kv-sum{margin:1rem 0;border-top:1px solid var(--kv-line)}',
    '.kv-sum div{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--kv-line)}',
    '.kv-sum .kv-total{font-weight:700;font-size:1.1em}',
    '.kv-sum .kv-note{display:block;border:0;color:var(--kv-muted);font-size:.85em;padding-top:0}',
    '.kv-btn{font:inherit;font-weight:600;background:var(--kv-accent);color:#fff;border:0;border-radius:var(--kv-radius);padding:.8rem 1.2rem;min-height:48px;cursor:pointer;width:100%}',
    '.kv-btn[disabled]{opacity:.6;cursor:default}',
    '.kv-fallback p{margin:0 0 .5rem}',
    '.kv-fallback a.kv-btn{display:inline-block;width:auto;text-decoration:none;text-align:center}',
    '.kv-check{display:flex;gap:.5rem;align-items:flex-start;font-size:.9em;margin:.75rem 0}',
    '.kv-check input{width:auto;min-height:0;margin-top:.2rem}',
    '.kv-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
    '.kv-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '.kv-done{border:1px solid var(--kv-line);border-radius:var(--kv-radius);padding:1rem}',
    '@media (prefers-reduced-motion:no-preference){.kv-day{transition:background-color .12s}}',
  ].join('');

  function injectCss() {
    if (document.getElementById('kv-styles')) return;
    var style = document.createElement('style');
    style.id = 'kv-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** h('div', {class: 'x', onclick: fn}, [hijos]) — texto siempre como nodo de texto. */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // --- Fechas: cadenas ISO y aritmética UTC, como lib/villas/dates.ts ---------
  function toDate(iso) { return new Date(iso + 'T00:00:00Z'); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(s, n) { return iso(new Date(toDate(s).getTime() + n * 86400000)); }
  function nightsBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function addMonths(s, n) { var d = toDate(s); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))); }
  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(toDate(s)) === s; }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('kairikos:' + name, { detail: detail }));
    } catch (e) { /* navegadores muy viejos: sin eventos, el widget sigue */ }
  }

  function Widget(root) {
    this.root = root;
    this.token = root.getAttribute('data-kairikos-villas');
    var lang = (root.getAttribute('data-lang') || document.documentElement.lang || 'es').slice(0, 2);
    this.lang = lang === 'en' ? 'en' : 'es';
    this.t = I18N[this.lang];
    this.api = (root.getAttribute('data-api') || apiBase).replace(/\/+$/, '');
    this.privacyUrl = root.getAttribute('data-privacy-url');
    var q = new URLSearchParams(window.location.search);
    this.source = q.get('origen') || root.getAttribute('data-source') || null;
    this.state = {
      info: null,
      villa: q.get('unidad') || root.getAttribute('data-villa') || null,
      adults: Math.max(1, parseInt(q.get('adultos') || '2', 10) || 2),
      children: Math.max(0, parseInt(q.get('ninos') || '0', 10) || 0),
      checkIn: isIso(q.get('entrada')) ? q.get('entrada') : null,
      checkOut: isIso(q.get('salida')) ? q.get('salida') : null,
      month: null,
      days: {},
      focus: null,
      quote: null,
      error: null,
      sending: false,
      done: null,
    };
    this.money = new Intl.NumberFormat(this.t.locale, { style: 'currency', currency: 'EUR' });
    this.moneyShort = new Intl.NumberFormat(this.t.locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
    this.init();
  }

  Widget.prototype.fetchJson = function (path, opts) {
    return fetch(this.api + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    });
  };

  Widget.prototype.init = function () {
    var self = this;
    injectCss();
    this.root.classList.add('kv');
    this.root.setAttribute('lang', this.lang);
    this.fetchJson('/api/public/villas/' + encodeURIComponent(this.token)).then(function (r) {
      // 404 (not_found / not_contracted) o sin villas que enseñar: no hay
      // servicio, y eso no se arregla reintentando.
      if (r.status === 404 || (r.status === 200 && (!r.body.villas || r.body.villas.length === 0))) {
        self.renderFallback();
        return;
      }
      if (r.status !== 200) {
        self.root.replaceChildren(h('p', { class: 'kv-err', text: self.t.errors.load }));
        return;
      }
      var info = r.body;
      self.state.info = info;
      var slugs = info.villas.map(function (v) { return v.slug; });
      if (slugs.indexOf(self.state.villa) === -1) self.state.villa = slugs[0];
      var today = info.today;
      if (self.state.checkIn && self.state.checkIn < today) { self.state.checkIn = null; self.state.checkOut = null; }
      if (self.state.checkIn && (!self.state.checkOut || self.state.checkOut <= self.state.checkIn)) self.state.checkOut = null;
      self.state.month = monthStart(self.state.checkIn || today);
      self.state.focus = self.state.checkIn || today;
      emit('booking_start', { source: self.source, unit: new URLSearchParams(window.location.search).get('unidad') || null });
      self.loadMonth().then(function () { if (self.state.checkIn && self.state.checkOut) self.loadQuote(false); });
    }).catch(function () {
      self.root.replaceChildren(h('p', { class: 'kv-err', text: self.t.errors.load }));
    });
  };

  /** Salida digna sin servicio: el contacto del fragmento o nada. Los valores
   *  vienen del HTML del propio dueño, pero se validan igual: solo http(s),
   *  un email con forma de email y un teléfono con dígitos. */
  Widget.prototype.renderFallback = function () {
    var root = this.root;
    var t = this.t.fallback;
    var links = [];
    var url = (root.getAttribute('data-fallback-url') || '').trim();
    if (url) {
      try {
        var parsed = new URL(url, window.location.href);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') links.push(h('a', { class: 'kv-btn', href: parsed.href, text: t.url }));
      } catch (e) { /* URL rota: se ignora */ }
    }
    var email = (root.getAttribute('data-fallback-email') || '').trim();
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) links.push(h('a', { href: 'mailto:' + email, text: t.email + ': ' + email }));
    var phone = (root.getAttribute('data-fallback-phone') || '').trim();
    var tel = phone.replace(/[^\d+]/g, '');
    if (tel.replace(/\D/g, '').length >= 6) links.push(h('a', { href: 'tel:' + tel, text: t.phone + ': ' + phone }));
    emit('booking_unavailable', { fallback: links.length > 0 });
    if (links.length === 0) {
      root.replaceChildren();
      root.hidden = true;
      return;
    }
    root.replaceChildren(h('div', { class: 'kv-fallback' }, [h('p', { text: t.intro })].concat(links.map(function (a) { return h('p', null, [a]); }))));
  };

  Widget.prototype.villaInfo = function () {
    var slug = this.state.villa;
    return this.state.info.villas.filter(function (v) { return v.slug === slug; })[0];
  };

  Widget.prototype.loadMonth = function () {
    var self = this;
    var s = this.state;
    var key = s.villa + ':' + s.month;
    if (s.days[key]) { self.render(); return Promise.resolve(); }
    return this.fetchJson('/api/public/villas/' + encodeURIComponent(this.token) + '/calendar?villa=' + encodeURIComponent(s.villa) + '&desde=' + s.month.slice(0, 7) + '&meses=2')
      .then(function (r) {
        var map = {};
        (r.body.days || []).forEach(function (d) { map[d.date] = d; });
        s.days[key] = map;
        // El segundo mes también viene: se guarda para no pedirlo otra vez.
        s.days[s.villa + ':' + addMonths(s.month, 1)] = map;
        self.render();
      })
      .catch(function () { s.error = self.t.errors.load; self.render(); });
  };

  Widget.prototype.day = function (date) {
    var map = this.state.days[this.state.villa + ':' + monthStart(date)];
    return map ? map[date] : null;
  };

  /** ¿Todas las noches de [a, b) libres? (el día de salida no hace falta). */
  Widget.prototype.rangeFree = function (a, b) {
    for (var d = a; d < b; d = addDays(d, 1)) {
      var info = this.day(d);
      if (!info || !info.available) return false;
    }
    return true;
  };

  Widget.prototype.pick = function (date) {
    var s = this.state;
    var info = this.day(date);
    s.error = null;
    if (s.checkIn && !s.checkOut && date > s.checkIn) {
      if (this.rangeFree(s.checkIn, date)) {
        s.checkOut = date;
        emit('booking_dates', { lead: nightsBetween(s.info.today, s.checkIn), nights: nightsBetween(s.checkIn, date), source: this.source });
        this.loadQuote(true);
        this.render();
        return;
      }
    }
    if (!info || !info.available) return;
    s.checkIn = date;
    s.checkOut = null;
    s.quote = null;
    this.render();
  };

  Widget.prototype.loadQuote = function (emitUnit) {
    var self = this;
    var s = this.state;
    var path = '/api/public/villas/' + encodeURIComponent(this.token) + '/quote?villa=' + encodeURIComponent(s.villa) +
      '&entrada=' + s.checkIn + '&salida=' + s.checkOut + '&adultos=' + s.adults + '&ninos=' + s.children;
    this.updateUrl();
    return this.fetchJson(path).then(function (r) {
      if (!r.body.ok) {
        s.quote = null;
        var e = self.t.errors[r.body.error];
        s.error = typeof e === 'function' ? e(r.body.minNights) : (e || self.t.errors.generic);
      } else if (!r.body.available) {
        s.quote = null;
        s.error = self.t.errors.unavailable;
      } else {
        s.quote = r.body.quote;
        s.error = null;
        if (emitUnit) emit('booking_unit', { unit: s.villa, kind: 'villa', rate: 'standard', total: s.quote.totalCents / 100, source: self.source });
      }
      self.render();
    });
  };

  Widget.prototype.updateUrl = function () {
    try {
      var s = this.state;
      var url = new URL(window.location.href);
      url.searchParams.set('entrada', s.checkIn);
      url.searchParams.set('salida', s.checkOut);
      url.searchParams.set('adultos', String(s.adults));
      url.searchParams.set('ninos', String(s.children));
      url.searchParams.set('unidad', s.villa);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch (e) { /* sin history: no pasa nada */ }
  };

  Widget.prototype.render = function () {
    var s = this.state;
    if (!s.info) return;
    var active = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.getAttribute('data-kv-id') : null;
    var t = this.t;
    var nodes = [];
    if (s.done) {
      nodes.push(this.renderDone());
    } else {
      nodes.push(this.renderControls());
      nodes.push(this.renderCalendar());
      var inInfo = s.checkIn ? this.day(s.checkIn) : null;
      nodes.push(h('p', { class: 'kv-hint', id: this.id('hint') }, [s.checkIn && !s.checkOut ? t.chooseOut + (inInfo && inInfo.minNights > 1 ? ' · ' + t.minNights(inInfo.minNights) : '') : !s.checkIn ? t.chooseIn : '']));
      // La región viva es SIEMPRE el mismo nodo: si se recreara en cada
      // repintado, el lector de pantalla no anunciaría el cambio de precio.
      if (!this.live) this.live = h('div', { class: 'kv-sr', 'aria-live': 'polite' });
      nodes.push(this.live);
      if (s.error) nodes.push(h('p', { class: 'kv-err', role: 'alert', text: s.error }));
      if (s.quote) {
        nodes.push(this.renderSummary());
        nodes.push(this.renderForm());
      }
    }
    // Lo escrito en el formulario sobrevive al repintado (cambiar los
    // huéspedes después de rellenarlo no lo borra).
    var typed = {};
    Array.prototype.forEach.call(this.root.querySelectorAll('form [name]'), function (el) {
      typed[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    // Se repinta entero; el foco vuelve al mismo control (por data-kv-id).
    this.root.replaceChildren.apply(this.root, nodes);
    Array.prototype.forEach.call(this.root.querySelectorAll('form [name]'), function (el) {
      if (!(el.name in typed)) return;
      if (el.type === 'checkbox') el.checked = typed[el.name]; else el.value = typed[el.name];
    });
    if (this.live) {
      var liveText = s.quote ? t.total + ': ' + this.money.format(s.quote.totalCents / 100) : '';
      if (this.live.textContent !== liveText) this.live.textContent = liveText;
    }
    if (active) {
      var el = this.root.querySelector('[data-kv-id="' + active + '"]');
      if (el) el.focus();
    }
  };

  Widget.prototype.id = function (name) {
    if (!this._uid) this._uid = 'kv' + Math.random().toString(36).slice(2, 8);
    return this._uid + '-' + name;
  };

  Widget.prototype.renderControls = function () {
    var self = this;
    var s = this.state;
    var t = this.t;
    var villa = this.villaInfo();
    var row = h('div', { class: 'kv-row' });
    if (s.info.villas.length > 1) {
      row.appendChild(h('div', { class: 'kv-field' }, [
        h('label', { for: this.id('villa'), text: t.villa }),
        h('select', {
          id: this.id('villa'), 'data-kv-id': 'villa',
          onchange: function (e) { s.villa = e.target.value; s.checkIn = null; s.checkOut = null; s.quote = null; s.error = null; self.loadMonth(); },
        }, s.info.villas.map(function (v) {
          return h('option', { value: v.slug, selected: v.slug === s.villa, text: v.name + ' · ' + t.from + ' ' + self.moneyShort.format(v.fromNightlyCents / 100) });
        })),
      ]));
    }
    function guests(name, label, min, value) {
      var max = villa.maxGuests;
      var opts = [];
      for (var i = min; i <= max; i++) opts.push(h('option', { value: String(i), selected: i === value, text: String(i) }));
      return h('div', { class: 'kv-field' }, [
        h('label', { for: self.id(name), text: label }),
        h('select', {
          id: self.id(name), 'data-kv-id': name,
          onchange: function (e) {
            s[name] = parseInt(e.target.value, 10);
            if (s.checkIn && s.checkOut) self.loadQuote(false); else self.render();
          },
        }, opts),
      ]);
    }
    row.appendChild(guests('adults', t.adults, 1, s.adults));
    row.appendChild(guests('children', t.children, 0, s.children));
    return row;
  };

  Widget.prototype.renderCalendar = function () {
    var self = this;
    var s = this.state;
    var t = this.t;
    var monthDate = toDate(s.month);
    var title = new Intl.DateTimeFormat(t.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate);
    var canPrev = s.month > monthStart(s.info.today);
    var head = h('div', { class: 'kv-cal-head' }, [
      h('button', { type: 'button', class: 'kv-nav', 'aria-label': t.prev, 'data-kv-id': 'prev', disabled: !canPrev, onclick: function () { self.moveMonth(-1); } }, ['‹']),
      h('div', { class: 'kv-cal-title', id: this.id('title'), 'aria-live': 'polite', text: title }),
      h('button', { type: 'button', class: 'kv-nav', 'aria-label': t.next, 'data-kv-id': 'next', onclick: function () { self.moveMonth(1); } }, ['›']),
    ]);
    var grid = h('div', { class: 'kv-grid', role: 'grid', 'aria-labelledby': this.id('title') });
    var dowFmt = new Intl.DateTimeFormat(t.locale, { weekday: 'short', timeZone: 'UTC' });
    var headRow = h('div', { role: 'row', style: 'display:contents' });
    for (var i = 0; i < 7; i++) {
      // 2024-01-01 fue lunes.
      headRow.appendChild(h('div', { class: 'kv-dow', role: 'columnheader', text: dowFmt.format(toDate('2024-01-0' + (i + 1))) }));
    }
    grid.appendChild(headRow);

    var first = s.month;
    var offset = (toDate(first).getUTCDay() + 6) % 7;
    var daysInMonth = nightsBetween(first, addMonths(first, 1));
    var cells = [];
    for (var b = 0; b < offset; b++) cells.push(h('div', { role: 'gridcell' }));
    var longFmt = new Intl.DateTimeFormat(t.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    for (var d = 0; d < daysInMonth; d++) {
      cells.push(this.renderDay(addDays(first, d), longFmt));
    }
    for (var r = 0; r < cells.length; r += 7) {
      grid.appendChild(h('div', { role: 'row', style: 'display:contents' }, cells.slice(r, r + 7)));
    }
    grid.addEventListener('keydown', function (e) { self.onKey(e); });
    return h('div', { class: 'kv-cal' }, [head, grid]);
  };

  Widget.prototype.renderDay = function (date, longFmt) {
    var self = this;
    var s = this.state;
    var t = this.t;
    var info = this.day(date);
    var free = !!(info && info.available);
    // Un día ocupado puede ser día de SALIDA si las noches anteriores están libres.
    var asCheckout = !free && s.checkIn && !s.checkOut && date > s.checkIn && this.rangeFree(s.checkIn, date);
    var selectable = free || asCheckout;
    var inRange = s.checkIn && s.checkOut && date > s.checkIn && date < s.checkOut;
    var edge = date === s.checkIn || date === s.checkOut;
    var label = longFmt.format(toDate(date)) + ', ' + (info ? this.money.format(info.nightlyCents / 100) + ' ' + t.perNight + ', ' : '') +
      (free ? t.free : t.busy) + (date === s.checkIn ? ', ' + t.checkIn : '') + (date === s.checkOut ? ', ' + t.checkOut : '');
    return h('div', { role: 'gridcell', 'aria-selected': edge ? 'true' : 'false' }, [
      h('button', {
        type: 'button',
        class: 'kv-day' + (inRange ? ' kv-in-range' : '') + (edge ? ' kv-edge' : ''),
        'data-kv-id': 'd' + date,
        'data-date': date,
        tabindex: date === s.focus ? '0' : '-1',
        'aria-disabled': selectable ? 'false' : 'true',
        'aria-label': label,
        onclick: function () { if (selectable) { s.focus = date; self.pick(date); } },
      }, [
        h('span', { 'aria-hidden': 'true', text: String(parseInt(date.slice(8), 10)) }),
        info && free ? h('small', { 'aria-hidden': 'true', text: self.moneyShort.format(info.nightlyCents / 100) }) : null,
      ]),
    ]);
  };

  Widget.prototype.moveMonth = function (delta) {
    var s = this.state;
    var target = addMonths(s.month, delta);
    if (target < monthStart(s.info.today)) return;
    s.month = target;
    if (monthStart(s.focus) !== target) s.focus = target === monthStart(s.info.today) ? s.info.today : target;
    this.loadMonth();
  };

  Widget.prototype.onKey = function (e) {
    var s = this.state;
    var steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    var target = null;
    if (steps[e.key] !== undefined) target = addDays(s.focus, steps[e.key]);
    else if (e.key === 'Home') target = addDays(s.focus, -((toDate(s.focus).getUTCDay() + 6) % 7));
    else if (e.key === 'End') target = addDays(s.focus, 6 - ((toDate(s.focus).getUTCDay() + 6) % 7));
    else if (e.key === 'PageUp') target = addMonths(monthStart(s.focus), -1);
    else if (e.key === 'PageDown') target = addMonths(monthStart(s.focus), 1);
    if (!target) return;
    e.preventDefault();
    if (target < s.info.today) target = s.info.today;
    s.focus = target;
    var month = monthStart(target);
    if (month !== s.month) {
      s.month = month;
      this.loadMonth().then(function () { focusDay(); });
    } else {
      this.render();
      focusDay();
    }
    var root = this.root;
    function focusDay() {
      var el = root.querySelector('[data-date="' + target + '"]');
      if (el) el.focus();
    }
  };

  Widget.prototype.renderSummary = function () {
    var t = this.t;
    var q = this.state.quote;
    var m = this.money;
    var self = this;
    function row(label, cents, cls) {
      return h('div', cls ? { class: cls } : null, [h('span', { text: label }), h('span', { text: m.format(cents / 100) })]);
    }
    var rows = q.lines.map(function (l) {
      return row((l.season || t.base) + ' · ' + l.nights + ' × ' + m.format(l.nightlyCents / 100), l.subtotalCents);
    });
    if (q.cleaningFeeCents) rows.push(row(t.cleaning, q.cleaningFeeCents));
    if (q.touristTaxCents) rows.push(row(t.tax, q.touristTaxCents));
    rows.push(row(t.total + ' · ' + t.nights(q.nights), q.totalCents, 'kv-total'));
    rows.push(h('span', { class: 'kv-note', text: t.vat(m.format(q.vatCents / 100), (q.vatRateBps / 100) + ' %') }));
    rows.push(row(t.deposit(q.depositPercent), q.depositCents));
    rows.push(row(t.balance, q.balanceCents));
    var info = this.state.info;
    var notes = [h('p', { class: 'kv-hint', text: t.noCharge(info.confirmHours) })];
    if (info.balanceNote) notes.push(h('p', { class: 'kv-hint', text: info.balanceNote }));
    if (info.cancellationNote) notes.push(h('p', { class: 'kv-hint', text: info.cancellationNote }));
    return h('div', null, [h('div', { class: 'kv-sum' }, rows)].concat(notes));
  };

  Widget.prototype.renderForm = function () {
    var self = this;
    var t = this.t;
    var s = this.state;
    function field(name, label, type, required, autocomplete) {
      var input = type === 'textarea'
        ? h('textarea', { id: self.id(name), name: name, 'data-kv-id': name, maxlength: '1500' })
        : h('input', { id: self.id(name), name: name, type: type, 'data-kv-id': name, required: required, autocomplete: autocomplete, maxlength: '200' });
      return h('div', { class: 'kv-field' }, [h('label', { for: self.id(name), text: label }), input]);
    }
    var consentLabel = h('label', { for: this.id('consent') }, [t.consent + ' ']);
    if (this.privacyUrl) consentLabel.appendChild(h('a', { href: this.privacyUrl, target: '_blank', rel: 'noopener', text: t.privacy }));
    var form = h('form', { novalidate: false, onsubmit: function (e) { e.preventDefault(); self.submit(form); } }, [
      h('div', { class: 'kv-row' }, [field('name', t.name, 'text', true, 'name'), field('email', t.email, 'email', true, 'email')]),
      h('div', { class: 'kv-row' }, [field('phone', t.phone, 'tel', false, 'tel')]),
      h('div', { class: 'kv-row' }, [field('message', t.message, 'textarea', false)]),
      h('div', { class: 'kv-hp', 'aria-hidden': 'true' }, [h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })]),
      h('div', { class: 'kv-check' }, [h('input', { type: 'checkbox', id: this.id('consent'), name: 'consent', required: true, 'data-kv-id': 'consent' }), consentLabel]),
      h('button', { type: 'submit', class: 'kv-btn', 'data-kv-id': 'send', disabled: s.sending, text: s.sending ? t.sending : t.send }),
    ]);
    return form;
  };

  Widget.prototype.submit = function (form) {
    var self = this;
    var s = this.state;
    if (s.sending) return;
    var data = new FormData(form);
    s.sending = true;
    var btn = form.querySelector('.kv-btn');
    if (btn) { btn.disabled = true; btn.textContent = this.t.sending; }
    var payload = {
      villa: s.villa,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      adults: s.adults,
      children: s.children,
      name: String(data.get('name') || ''),
      email: String(data.get('email') || ''),
      phone: String(data.get('phone') || '') || null,
      message: String(data.get('message') || '') || null,
      lang: this.lang,
      consent: data.get('consent') === 'on',
      source: this.source,
      website: String(data.get('website') || ''),
    };
    this.fetchJson('/api/public/villas/' + encodeURIComponent(this.token) + '/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      s.sending = false;
      if (r.status === 201 && r.body.ok) {
        emit('booking_submit', {
          unit: s.villa, kind: 'villa', rate: 'standard',
          lead: nightsBetween(s.info.today, s.checkIn), nights: nightsBetween(s.checkIn, s.checkOut),
          adults: s.adults, children: s.children, extras: [], total: s.quote.totalCents / 100, source: self.source,
        });
        s.done = r.body;
        self.render();
        var title = self.root.querySelector('[data-kv-id="done"]');
        if (title) title.focus();
        return;
      }
      var e = self.t.errors[r.body.error];
      s.error = typeof e === 'function' ? e(r.body.minNights) : (e || self.t.errors.generic);
      if (r.body.error === 'unavailable') { s.days = {}; s.checkIn = null; s.checkOut = null; s.quote = null; self.loadMonth(); return; }
      self.render();
    }).catch(function () {
      s.sending = false;
      s.error = self.t.errors.generic;
      self.render();
    });
  };

  Widget.prototype.renderDone = function () {
    var t = this.t;
    var d = this.state.done;
    return h('div', { class: 'kv-done', role: 'status' }, [
      h('h3', { tabindex: '-1', 'data-kv-id': 'done', text: t.sentTitle }),
      h('p', { text: d.reference ? t.sentBody(d.reference, d.confirmHours || this.state.info.confirmHours) : t.sentTitle }),
      d.statusUrl ? h('p', null, [h('a', { href: d.statusUrl, text: t.viewRequest })]) : null,
    ]);
  };

  function mountAll() {
    var roots = document.querySelectorAll('[data-kairikos-villas]:not([data-kv-ready])');
    for (var i = 0; i < roots.length; i++) {
      roots[i].setAttribute('data-kv-ready', '');
      new Widget(roots[i]);
    }
  }

  window.KairikosVillas = { mount: mountAll, version: '1.0.0' };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
