// =============================================================================
// embed.v2.js — el formulario de contacto con aviso de privacidad y casilla
// obligatoria (25/11/2026, plan del encargo del tratamiento, PR 3).
//
// Los tests corren en Node, sin DOM y sin jsdom instalado. Para no quedarse en
// buscar texto en el fuente, el script se ejecuta DE VERDAD en un contexto de
// node:vm con un DOM mínimo hecho aquí abajo: lo justo para que arranque,
// pinte, abra el chat, reciba una derivación (askContact) y pinte el
// formulario. Así se comprueba lo que importa: que sin la casilla no sale
// nada, qué enlace se pinta y qué viaja en el POST.
//
// Si el widget empieza a usar una API del DOM que FakeNode no tiene, estos
// tests fallan con un TypeError: añádela aquí, no la quites del widget.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import path from 'node:path';
import { WIDGET_CONTACT_NOTICE_VERSION, WIDGET_CONTACT_NOTICES } from '@/lib/web-widget-context';

const SOURCE = readFileSync(path.resolve(__dirname, '../../public/widget/embed.v2.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;

class FakeNode {
  tagName: string;
  nodeType: number;
  attributes = new Map<string, string>();
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  listeners: Record<string, Listener[]> = {};
  style: Record<string, unknown> = { setProperty: () => {} };
  classList = { add: () => {}, remove: () => {}, contains: () => false };
  value = '';
  checked = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  private text = '';

  constructor(
    tag: string,
    private doc: { activeElement: FakeNode | null; shadows: FakeNode[] },
  ) {
    this.tagName = tag.toUpperCase();
    this.nodeType = tag === '#text' ? 3 : 1;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  appendChild(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
    return child;
  }
  remove() {
    this.parent?.removeChild(this);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...extra });
  }
  attachShadow() {
    const shadow = new FakeNode('#shadow', this.doc);
    this.doc.shadows.push(shadow);
    return shadow;
  }
  focus() {
    this.doc.activeElement = this;
  }
}

function all(root: FakeNode, pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (pred(root)) out.push(root);
  for (const c of root.children) all(c, pred, out);
  return out;
}

const hasClass = (name: string) => (n: FakeNode) => (n.getAttribute('class') ?? '').split(' ').includes(name);

interface Setup {
  attrs?: Record<string, string>;
  privacy?: { url: string | null; controller: string | null } | null;
  businessName?: string;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

/** Arranca el widget, abre el chat con un mensaje y devuelve el formulario
 *  de contacto que pinta cuando el servidor contesta con askContact. */
async function contactForm({ attrs = {}, privacy = null, businessName = 'Clínica Orly' }: Setup) {
  const doc = { activeElement: null as FakeNode | null, shadows: [] as FakeNode[] };
  const make = (tag: string) => new FakeNode(tag, doc);
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const warnings: string[] = [];

  const config = {
    businessName,
    welcomeMessage: '¡Hola!',
    farewellMessage: null,
    suggestedPrompts: [],
    primaryColor: '#0E6B5E',
    position: 'bottom-right',
    chatEndpoint: 'https://portal.example/api/public/channels/web/message',
    sensitiveDataNotice: null,
    privacy,
  };

  const ctx: Record<string, unknown> = {
    document: {
      readyState: 'complete',
      currentScript: {
        src: 'https://portal.example/widget/embed.v2.js',
        getAttribute: (name: string) => ({ 'data-space-token': 'wgt_test', ...attrs })[name] ?? null,
      },
      createElement: make,
      createElementNS: (_ns: string, tag: string) => make(tag),
      createTextNode: (text: string) => {
        const node = make('#text');
        node.textContent = text;
        return node;
      },
      body: make('body'),
      get activeElement() {
        return doc.activeElement;
      },
    },
    location: { href: 'https://www.clinica.example/tratamientos/implantes', origin: 'https://www.clinica.example' },
    fetch: (url: string, init?: { body?: string }) => {
      if (url.includes('/config?')) return Promise.resolve({ ok: true, json: async () => config });
      const body = init?.body ? JSON.parse(init.body) : {};
      posts.push({ url, body });
      if (url.endsWith('/message')) {
        return Promise.resolve({
          json: async () => ({ success: true, data: { mode: 'portal', reply: 'Te paso con el equipo.', askContact: true } }),
        });
      }
      return Promise.resolve({ json: async () => ({ success: true }) });
    },
    setTimeout,
    URL,
    console: { ...console, warn: (msg: string) => warnings.push(msg) },
  };
  ctx.window = ctx;
  new Script(SOURCE, { filename: 'embed.v2.js' }).runInNewContext(ctx);
  await flush();

  (ctx.KairikosChat as { open: (o: unknown) => void }).open({ message: 'Quiero cita' });
  await flush();

  const shadow = doc.shadows[0];
  expect(shadow, 'el widget no se pintó').toBeDefined();
  const form = all(shadow, hasClass('kw-contact'))[0];
  expect(form, 'no apareció el formulario de contacto').toBeDefined();

  const inputs = all(form, (n) => n.tagName === 'INPUT');
  const checkbox = inputs.find((n) => n.getAttribute('type') === 'checkbox')!;
  const textInputs = inputs.filter((n) => n.getAttribute('type') === 'text');
  const submit = all(form, hasClass('kw-contact-send'))[0];
  const error = all(form, hasClass('kw-contact-error'))[0];
  const notice = all(form, hasClass('kw-contact-notice'))[0];
  const links = all(form, (n) => n.tagName === 'A');
  const contactPosts = () => posts.filter((p) => p.url.endsWith('/contact'));

  return { form, checkbox, nameInput: textInputs[0], contactInput: textInputs[1], submit, error, notice, links, contactPosts, warnings, shadow };
}

describe('embed.v2.js — formulario de contacto con consentimiento', () => {
  it('pinta el aviso de primera capa con el responsable del paso 10', async () => {
    const f = await contactForm({ privacy: { url: 'https://www.clinica.example/privacidad', controller: 'Clínica Orly, S.L.' } });
    // El punto de «S.L.» no se duplica.
    expect(f.notice.textContent).toBe('Responsable: Clínica Orly, S.L. Finalidad: responder a esta consulta.');
  });

  it('sin responsable en el paso 10, el aviso nombra al negocio', async () => {
    const f = await contactForm({ privacy: null, businessName: 'Clínica Orly' });
    expect(f.notice.textContent).toBe('Responsable: Clínica Orly. Finalidad: responder a esta consulta.');
  });

  it('la casilla es obligatoria: sin marcarla no sale ninguna petición y se dice por qué', async () => {
    const f = await contactForm({ privacy: { url: 'https://www.clinica.example/privacidad', controller: 'Clínica Orly' } });
    expect(f.checkbox.hasAttribute('required')).toBe(true);
    expect(f.checkbox.checked).toBe(false);

    f.contactInput.value = '600 123 123';
    f.submit.dispatch('click');
    await flush();

    expect(f.contactPosts()).toHaveLength(0);
    expect(f.error.hasAttribute('hidden')).toBe(false);
    expect(f.error.textContent).toBe('Falta aceptar la política de privacidad.');
  });

  it('con la casilla marcada, el POST lleva consent: true y la versión del aviso', async () => {
    const f = await contactForm({ privacy: { url: 'https://www.clinica.example/privacidad', controller: 'Clínica Orly' } });
    f.nameInput.value = 'Marta';
    f.contactInput.value = '600 123 123';
    f.checkbox.checked = true;
    f.submit.dispatch('click');
    await flush();

    expect(f.contactPosts()).toHaveLength(1);
    expect(f.contactPosts()[0].body).toEqual({
      publicToken: 'wgt_test',
      sessionId: expect.stringMatching(/^web-/),
      name: 'Marta',
      contact: '600 123 123',
      consent: true,
      noticeVersion: WIDGET_CONTACT_NOTICE_VERSION,
      privacyLinkShown: true,
    });
    // Enviado: el formulario desaparece.
    expect(all(f.shadow, hasClass('kw-contact'))).toHaveLength(0);
  });

  it('data-privacy-url gana a la URL del paso 10 y se resuelve contra la página', async () => {
    const f = await contactForm({
      attrs: { 'data-privacy-url': '/privacidad' },
      privacy: { url: 'https://otra.example/privacy', controller: 'Clínica Orly' },
    });
    expect(f.links).toHaveLength(1);
    expect(f.links[0].getAttribute('href')).toBe('https://www.clinica.example/privacidad');
    expect(f.links[0].getAttribute('target')).toBe('_blank');
    expect(f.links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(f.links[0].textContent).toBe('Política de privacidad');
  });

  it('sin atributo, el enlace es el del paso 10', async () => {
    const f = await contactForm({ privacy: { url: 'https://www.clinica.example/aviso', controller: null } });
    expect(f.links.map((l) => l.getAttribute('href'))).toEqual(['https://www.clinica.example/aviso']);
  });

  it('solo enlaza http(s): javascript:, data: o mailto: no se pintan como enlace', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'mailto:a@b.example', ' JaVaScRiPt:alert(1)']) {
      const f = await contactForm({ attrs: { 'data-privacy-url': bad }, privacy: { url: bad, controller: 'X' } });
      expect(f.links, bad).toHaveLength(0);
    }
  });

  it('sin ninguna URL: aviso y casilla igual, sin enlace, y el POST dice privacyLinkShown: false', async () => {
    const f = await contactForm({ privacy: null });
    expect(f.links).toHaveLength(0);
    expect(f.notice).toBeDefined();
    expect(f.checkbox).toBeDefined();
    expect(f.warnings.some((w) => w.includes('política de privacidad'))).toBe(true);

    f.contactInput.value = 'marta@example.com';
    f.checkbox.checked = true;
    f.submit.dispatch('click');
    await flush();
    expect(f.contactPosts()[0].body).toMatchObject({ consent: true, privacyLinkShown: false });
  });

  it('en alemán, los textos del aviso son los de la versión publicada', async () => {
    const f = await contactForm({
      attrs: { 'data-lang': 'de' },
      privacy: { url: 'https://www.hotel.example/datenschutz', controller: 'Hotel Sol GmbH' },
    });
    const de = WIDGET_CONTACT_NOTICES[WIDGET_CONTACT_NOTICE_VERSION].de;
    expect(f.notice.textContent).toBe(de.notice.replace('{controller}', 'Hotel Sol GmbH'));
    expect(f.links[0].textContent).toBe(de.privacyLink);
    expect(f.form.textContent).toContain(de.consent);
  });
});
