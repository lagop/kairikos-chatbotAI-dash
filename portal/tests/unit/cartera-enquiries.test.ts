// =============================================================================
// Cartera — los contactos de la web (PR 5): el endpoint único de los siete
// formularios, los correos, la copia como Lead, la pestaña Contactos y la purga
// a los 24 meses. Con la base de datos falsa en memoria
// (tests/fixtures/cartera/fake-db.ts) y Resend simulado: aquí no sale nada.
//
// Al final, la prueba de cierre del brief: los cuerpos exactos que monta la web
// (src/scripts/lead.ts: `{ kind, ...payload(), name, contact, consent: true,
// lang, website }`), uno por tipo, llegan a la pestaña Contactos.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeCarteraDb, type FakeCarteraDb } from '../fixtures/cartera/fake-db';
import { fullAlquiler, fullVenta } from '../fixtures/cartera/full-homes';

const state = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  leadsInbox: false,
  sent: [] as Array<{ from: string; to: string[]; replyTo?: string; subject: string; text: string; html: string }>,
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: new Proxy({}, { get: (_t, key) => state.db[key as string] }),
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ hasClientAccess: true }) }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => ({ source: 'database', clientId: 'client-1' }) }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/leads', () => ({ hasLeadsInboxAccess: async () => state.leadsInbox }));
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (m: { from: string; to: string[]; replyTo?: string; subject: string; text: string; html: string }) => {
        state.sent.push(m);
        return { data: { id: `msg-${state.sent.length}` }, error: null };
      },
    };
  },
}));

import { POST as contactPost, OPTIONS as contactOptions } from '@/app/api/public/cartera/[token]/contacto/route';
import { GET as enquiriesGet, PATCH as enquiriesPatch } from '@/app/api/portal/cartera/contactos/route';
import { createHome, saveHome } from '@/lib/cartera/homes';
import { purgeOldEnquiries } from '@/lib/cartera/enquiries';
import { sweepCartera } from '@/lib/cartera/publish';
import { ENQUIRIES_PER_HOUR, KIND_LABELS, SAVED_EMAILS_PER_DAY, enquirySchema, retentionCutoff } from '@/lib/cartera/enquiry-rules';

const ACTOR = 'client:client-1';
const DAY = 24 * 60 * 60 * 1000;

let f: FakeCarteraDb;

beforeEach(() => {
  f = fakeCarteraDb();
  state.db = f.db as never;
  state.sent.length = 0;
  state.leadsInbox = false;
  process.env.RESEND_API_KEY = 're_prueba';
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

const asPrisma = () => f.db as never;

/** Un sitio con una casa en venta (C-101) y una en alquiler (A-201), publicadas. */
async function siteWithHomes(over: Parameters<FakeCarteraDb['addSite']>[0] = {}) {
  const site = f.addSite(over);
  const venta = await createHome(asPrisma(), site, 'venta', ACTOR);
  const alquiler = await createHome(asPrisma(), site, 'alquiler', ACTOR);
  if (!venta.ok || !alquiler.ok) throw new Error('alta');
  await saveHome(asPrisma(), site, venta.id, { status: 'venta', data: fullVenta() }, ACTOR);
  await saveHome(asPrisma(), site, alquiler.id, { status: 'disponible', data: fullAlquiler() }, ACTOR);
  return { site, token: String(site.feedToken), ventaId: venta.id, alquilerId: alquiler.id };
}

function post(token: string, body: unknown, origin = 'https://agencia.example') {
  return contactPost(
    new NextRequest(`http://localhost/api/public/cartera/${token}/contacto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
}

const base = { name: 'Ana Pérez', contact: '+34 600 111 222', consent: true, lang: 'es', website: '' };

// Los cuerpos que monta la web, uno por tipo (docs/contactos.md y los payload() de cada página).
const WEB_BODIES = {
  visit: { kind: 'visit', ref: 'C-101', slots: ['lun-m', 'mie-t'], mode: 'presencial', situation: 'contado', origin: null, ...base },
  valuation: { kind: 'valuation', zone: 'golf', type: 'villa', usable: 240, state: 'buena', extras: ['vistas', 'piscina'], beds: 4, marketing: true, ...base, lang: 'en' },
  landlord: { kind: 'landlord', zone: 'costa', service: 'gestion', ...base, lang: 'de' },
  offmarket: { kind: 'offmarket', zone: '', budget: '3M-6M', ...base },
  report: { kind: 'report', ...base },
  // Sin nombre: la web no lo manda (el formulario no lo tiene y JSON quita el undefined).
  saved_email: { kind: 'saved_email', refs: ['C-101', 'A-201'], contact: 'comprador@example.com', consent: true, lang: 'en', website: '' },
  saved_agency: { kind: 'saved_agency', refs: ['C-101'], ...base, contact: 'ana@example.com' },
} as const;

// --- Validación ---------------------------------------------------------------------

describe('la validación por tipo', () => {
  it('acepta los siete cuerpos de la web tal cual', () => {
    for (const [kind, body] of Object.entries(WEB_BODIES)) expect(enquirySchema.safeParse(body).success, kind).toBe(true);
  });

  it('los vacíos y nulos de la web se guardan como null', () => {
    const v = enquirySchema.parse({ ...WEB_BODIES.visit, ref: '', situation: '', origin: 'newsletter' });
    expect(v).toMatchObject({ ref: null, situation: null, origin: null });
    const o = enquirySchema.parse(WEB_BODIES.offmarket);
    expect(o).toMatchObject({ zone: null, budget: '3M-6M' });
    const l = enquirySchema.parse({ ...WEB_BODIES.landlord, service: '' });
    expect(l).toMatchObject({ zone: 'costa', service: null });
    // `Number('x')` es NaN y JSON lo manda como null.
    expect(enquirySchema.parse({ ...WEB_BODIES.valuation, beds: null })).toMatchObject({ beds: null });
  });

  it('un campo que no está en el contrato se ignora, no se rechaza', () => {
    const r = enquirySchema.parse({ ...WEB_BODIES.report, utm: 'x', nuevo: { a: 1 } });
    expect(r).not.toHaveProperty('utm');
    expect(r).not.toHaveProperty('nuevo');
  });

  it('rechaza lo que no tiene forma', () => {
    const bad = [
      { ...WEB_BODIES.report, consent: false },
      { ...WEB_BODIES.report, consent: undefined },
      { ...WEB_BODIES.report, consent: 'true' },
      { ...WEB_BODIES.report, lang: 'fr' },
      { ...WEB_BODIES.report, kind: 'otro' },
      { ...WEB_BODIES.report, name: '' },
      { ...WEB_BODIES.report, contact: '' },
      { ...WEB_BODIES.visit, slots: ['lun-m', 'mar-m', 'mie-m', 'jue-m'] },
      { ...WEB_BODIES.visit, slots: ['dom-m'] },
      { ...WEB_BODIES.visit, ref: 'casa-1' },
      { ...WEB_BODIES.visit, mode: 'telefono' },
      { ...WEB_BODIES.valuation, usable: 20 },
      { ...WEB_BODIES.valuation, zone: 'Costa del Sol' },
      { ...WEB_BODIES.valuation, zone: undefined },
      { ...WEB_BODIES.offmarket, budget: '10M' },
      { ...WEB_BODIES.saved_email, refs: [] },
      { ...WEB_BODIES.saved_email, contact: 'no-es-un-email' },
      { ...WEB_BODIES.saved_agency, refs: Array.from({ length: 31 }, (_, i) => `C-${100 + i}`) },
    ];
    for (const body of bad) expect(enquirySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

// --- La ruta ------------------------------------------------------------------------

describe('POST /api/public/cartera/[token]/contacto', () => {
  it('guarda el contacto con su consentimiento y responde 201 con CORS para la web', async () => {
    const { site, token } = await siteWithHomes();
    const res = await post(token, WEB_BODIES.visit);
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://agencia.example');
    expect(f.enquiries).toHaveLength(1);
    expect(f.enquiries[0]).toMatchObject({
      siteId: site.id,
      clientId: 'client-1',
      kind: 'visit',
      refs: ['C-101'],
      name: 'Ana Pérez',
      contact: '+34 600 111 222',
      lang: 'es',
      status: 'nuevo',
      payload: { slots: ['lun-m', 'mie-t'], mode: 'presencial', situation: 'contado', origin: null },
    });
    expect(f.enquiries[0].consentAt).toBeInstanceOf(Date);
    // La auditoría, sin datos personales.
    expect(f.audits.at(-1)).toMatchObject({ entity: 'enquiry', action: 'enquiry_received', actor: 'buyer', metadata: { kind: 'visit', refs: ['C-101'], lang: 'es' } });
    expect(JSON.stringify(f.audits)).not.toMatch(/Ana|600 111|example\.com/);
  });

  it('CORS solo para el origen de siteUrl, también en el preflight', async () => {
    const { token } = await siteWithHomes();
    f.sites[0].siteUrl = 'https://www.agencia.example/inicio/';
    const pre = await contactOptions(new NextRequest(`http://localhost/api/public/cartera/${token}/contacto`, { method: 'OPTIONS' }), { params: Promise.resolve({ token }) });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://www.agencia.example');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-headers')).toBe('Content-Type');

    // Sin siteUrl, sin cabecera: el navegador no deja leer la respuesta.
    f.sites[0].siteUrl = null;
    expect((await post(token, WEB_BODIES.report)).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('token desconocido, de otra forma o con la contratación no activa: 404', async () => {
    await siteWithHomes();
    expect((await post('car_noexisteninguno000000', WEB_BODIES.report)).status).toBe(404);
    expect((await post('../../feed', WEB_BODIES.report)).status).toBe(404);
    const paused = f.addSite({ clientId: 'client-2', contractStatus: 'paused' });
    expect((await post(String(paused.feedToken), WEB_BODIES.report)).status).toBe(404);
    const cancelled = f.addSite({ clientId: 'client-3', contractStatus: 'cancelled' });
    expect((await post(String(cancelled.feedToken), WEB_BODIES.report)).status).toBe(404);
    expect(f.enquiries).toHaveLength(0);
  });

  it('el token de un sitio guarda en ESE sitio, aunque el cuerpo diga otra cosa', async () => {
    const a = await siteWithHomes();
    const b = f.addSite({ clientId: 'client-2' });
    const res = await post(String(b.feedToken), { ...WEB_BODIES.report, siteId: a.site.id, clientId: 'client-1' });
    expect(res.status).toBe(201);
    expect(f.enquiries[0]).toMatchObject({ siteId: b.id, clientId: 'client-2' });
  });

  it('no valida: 400', async () => {
    const { token } = await siteWithHomes();
    expect((await post(token, { ...WEB_BODIES.report, consent: false })).status).toBe(400);
    expect((await post(token, { ...WEB_BODIES.valuation, zone: 'ZONA MAL' })).status).toBe(400);
    expect((await post(token, 'no es un objeto')).status).toBe(400);
    expect(f.enquiries).toHaveLength(0);
  });

  it('trampa llena: 200, no guarda, no avisa y no cuenta para el límite', async () => {
    const { token } = await siteWithHomes();
    for (let i = 0; i < ENQUIRIES_PER_HOUR + 5; i++) {
      const res = await post(token, { ...WEB_BODIES.visit, website: 'https://spam.example' });
      expect(res.status).toBe(200);
    }
    expect(f.enquiries).toHaveLength(0);
    expect(state.sent).toHaveLength(0);
    expect((await post(token, WEB_BODIES.report)).status).toBe(201);
  });

  it('20 envíos por hora y token; el 21 da 429', async () => {
    const { token } = await siteWithHomes();
    for (let i = 0; i < ENQUIRIES_PER_HOUR; i++) expect((await post(token, WEB_BODIES.report)).status).toBe(201);
    const over = await post(token, WEB_BODIES.report);
    expect(over.status).toBe(429);
    expect(over.headers.get('access-control-allow-origin')).toBe('https://agencia.example');
    expect(f.enquiries).toHaveLength(ENQUIRIES_PER_HOUR);
  });
});

// --- Casas guardadas ------------------------------------------------------------------

describe('casas guardadas', () => {
  it('las referencias que no están en la cartera publicada se descartan; si no queda ninguna, 400', async () => {
    const { token } = await siteWithHomes();
    expect((await post(token, { ...WEB_BODIES.saved_agency, refs: ['C-101', 'C-999', 'A-777'] })).status).toBe(201);
    expect(f.enquiries[0].refs).toEqual(['C-101']);

    // Una casa que existe pero es borrador tampoco está publicada.
    const site = f.sites[0] as never;
    const draft = await createHome(asPrisma(), site, 'venta', ACTOR);
    expect(draft.ok).toBe(true);
    const res = await post(token, { ...WEB_BODIES.saved_email, refs: ['C-102', 'C-999'] });
    expect(res.status).toBe(400);
    expect(f.enquiries).toHaveLength(1);
    expect(state.sent.filter((m) => m.to[0] === 'comprador@example.com')).toHaveLength(0);
  });

  it('«mándamela por email»: 3 al día al mismo destino, contando todas las webs', async () => {
    const a = await siteWithHomes();
    for (let i = 0; i < SAVED_EMAILS_PER_DAY; i++) expect((await post(a.token, WEB_BODIES.saved_email)).status).toBe(201);
    expect((await post(a.token, { ...WEB_BODIES.saved_email, contact: 'COMPRADOR@example.com' })).status).toBe(429);

    // Desde la web de otra agencia, al mismo destino, tampoco.
    const b = await siteWithHomes({ clientId: 'client-2' });
    expect((await post(b.token, WEB_BODIES.saved_email)).status).toBe(429);
    // A otro destino, sí.
    expect((await post(b.token, { ...WEB_BODIES.saved_email, contact: 'otra@example.com' })).status).toBe(201);
    // Pasado un día, otra vez.
    for (const e of f.enquiries) e.createdAt = new Date(Date.now() - DAY - 1000);
    expect((await post(a.token, WEB_BODIES.saved_email)).status).toBe(201);
  });
});

// --- Correos ------------------------------------------------------------------------

describe('los correos', () => {
  it('a la agencia, por cada contacto: el tipo, las referencias y el título y enlace de cada casa', async () => {
    const { token } = await siteWithHomes();
    await post(token, WEB_BODIES.visit);
    expect(state.sent).toHaveLength(1);
    const m = state.sent[0];
    expect(m.to).toEqual(['agencia@example.com']);
    expect(m.subject).toBe('Visita de Ana Pérez (C-101)');
    expect(m.text).toContain('Nombre: Ana Pérez');
    expect(m.text).toContain('Contacto: +34 600 111 222');
    expect(m.text).toMatch(/C-101 · Villa con vistas al mar — https:\/\/agencia\.example\/comprar\/[a-z0-9-]+\/\n/);
    expect(m.text).toContain('Franjas: lunes por la mañana, miércoles por la tarde · en persona · compra sin hipoteca');
    expect(m.text).toMatch(/Aceptó la política de privacidad el \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)/);
    // Sin email del comprador, sin «responder a».
    expect(m.replyTo).toBeUndefined();
  });

  it('«mándamela por email»: correo fijo en su idioma, con el nombre de la agencia y nada del comprador', async () => {
    const { token } = await siteWithHomes();
    // Aunque mande un nombre (la web no lo hace), no llega al correo del comprador.
    const res = await post(token, { ...WEB_BODIES.saved_email, name: 'Visita https://spam.example ya' });
    expect(res.status).toBe(201);
    expect(state.sent.map((m) => m.to[0])).toEqual(['agencia@example.com', 'comprador@example.com']);

    const buyer = state.sent[1];
    expect(buyer.from).toBe('Alféizar Inmobiliaria <ops@kairikos.com>');
    expect(buyer.replyTo).toBe('agencia@example.com');
    expect(buyer.subject).toBe('Your saved homes at Alféizar Inmobiliaria');
    expect(buyer.text).toMatch(/^These are the homes you saved on the Alféizar Inmobiliaria website:/);
    expect(buyer.text).toMatch(/ — €\d{1,3}(,\d{3})+\nhttps:\/\/agencia\.example\/en\/buy\/[a-z0-9-]+\/\n/);
    expect(buyer.text).toMatch(/ — €\d{1,3}(,\d{3})*\/month\nhttps:\/\/agencia\.example\/en\/rent\/[a-z0-9-]+\/\n/);
    expect(buyer.text).toContain('See the list on the website: https://agencia.example/en/saved/?refs=C-101,A-201');
    expect(buyer.text).toContain('Someone asked for this list on the Alféizar Inmobiliaria website; if it was not you, please ignore this email.');
    expect(buyer.text + buyer.html).not.toMatch(/spam|comprador@example\.com/);
    expect(buyer.html).toContain('<a href="https://agencia.example/en/saved/?refs=C-101,A-201">');
  });

  it('en español y en alemán, con sus rutas y su formato de precio', async () => {
    const { token } = await siteWithHomes();
    await post(token, { ...WEB_BODIES.saved_email, lang: 'es', refs: ['C-101'] });
    const es = state.sent[1];
    expect(es.subject).toBe('Tus casas guardadas en Alféizar Inmobiliaria');
    expect(es.text).toMatch(/ — \d{1,3}(\.\d{3})+ €\nhttps:\/\/agencia\.example\/comprar\//);
    expect(es.text).toContain('https://agencia.example/guardadas/?refs=C-101');
    expect(es.text).toContain('Alguien pidió esta lista desde la web de Alféizar Inmobiliaria; si no fuiste tú, ignora este correo.');

    await post(token, { ...WEB_BODIES.saved_email, contact: 'k@example.com', lang: 'de', refs: ['A-201'] });
    const de = state.sent[3];
    expect(de.subject).toBe('Ihre gemerkten Immobilien bei Alféizar Inmobiliaria');
    expect(de.text).toMatch(/ — \d{1,3}(\.\d{3})* €\/Monat\nhttps:\/\/agencia\.example\/de\/mieten\//);
    expect(de.text).toContain('https://agencia.example/de/gemerkt/?refs=A-201');
  });

  it('un fallo de Resend no tumba el contacto: queda guardado y la web ve 201', async () => {
    const { token } = await siteWithHomes();
    delete process.env.RESEND_API_KEY;
    expect((await post(token, WEB_BODIES.saved_email)).status).toBe(201);
    expect(f.enquiries).toHaveLength(1);
    expect(state.sent).toHaveLength(0);
  });
});

// --- Copia como Lead --------------------------------------------------------------------

describe('la copia como Lead', () => {
  it('con el producto de captación, un Lead con un resumen que nombra las casas', async () => {
    state.leadsInbox = true;
    const { token } = await siteWithHomes();
    await post(token, { ...WEB_BODIES.saved_agency, refs: ['C-101', 'A-201'] });
    expect(f.leads).toHaveLength(1);
    expect(f.leads[0]).toMatchObject({ clientId: 'client-1', source: 'inbound', channel: 'web', status: 'nuevo', contactName: 'Ana Pérez', contactEmail: 'ana@example.com', contactPhone: null });
    expect(f.leads[0].summary).toMatch(/^Web inmobiliaria · Guardadas, a la agencia\. 2 casas guardadas\. Casas: C-101 \(Villa con vistas al mar\), A-201 \(.+\)\.$/);
    expect(f.leadAudits).toEqual([expect.objectContaining({ leadId: f.leads[0].id, action: 'created', actorId: 'system:cartera' })]);
    expect(f.enquiries[0].leadId).toBe(f.leads[0].id);
  });

  it('sin él, no', async () => {
    const { token } = await siteWithHomes();
    await post(token, WEB_BODIES.visit);
    expect(f.leads).toHaveLength(0);
    expect(f.enquiries[0].leadId).toBeNull();
  });
});

// --- La pestaña ------------------------------------------------------------------------

describe('la pestaña Contactos', () => {
  it('lista y marca como atendido, con auditoría; un id de otro sitio da 404', async () => {
    const { token } = await siteWithHomes();
    await post(token, WEB_BODIES.visit);
    const list = await (await enquiriesGet()).json();
    expect(list.readOnly).toBe(false);
    expect(list.enquiries[0]).toMatchObject({ kind: 'visit', status: 'nuevo', refs: [{ ref: 'C-101', title: 'Villa con vistas al mar' }] });

    const patch = (body: unknown) =>
      enquiriesPatch(new NextRequest('http://localhost/api/portal/cartera/contactos', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const id = String(f.enquiries[0].id);
    expect(await (await patch({ id, status: 'atendido' })).json()).toEqual({ ok: true, status: 'atendido' });
    expect(f.enquiries[0].status).toBe('atendido');
    expect(f.audits.at(-1)).toMatchObject({ action: 'enquiry_status_changed', actor: ACTOR, metadata: { kind: 'visit', from: 'nuevo', to: 'atendido' } });
    expect((await patch({ id, status: 'borrado' })).status).toBe(400);
    expect((await patch({ id: crypto.randomUUID(), status: 'atendido' })).status).toBe(404);

    const other = f.addSite({ clientId: 'client-2' });
    await post(String(other.feedToken), WEB_BODIES.report);
    expect((await patch({ id: String(f.enquiries[1].id), status: 'atendido' })).status).toBe(404);
  });

  it('en la gracia de una baja se lee pero no se marca', async () => {
    const { token } = await siteWithHomes();
    await post(token, WEB_BODIES.report);
    Object.assign(f.sites[0].clientProduct as object, { status: 'cancelled', cancelledAt: new Date(Date.now() - DAY), changedAt: new Date(Date.now() - DAY) });
    f.sites[0].exitNotifiedAt = new Date(Date.now() - DAY);
    const list = await enquiriesGet();
    expect(list.status).toBe(200);
    expect((await list.json()).readOnly).toBe(true);
    const res = await enquiriesPatch(
      new NextRequest('http://localhost/api/portal/cartera/contactos', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.enquiries[0].id, status: 'atendido' }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'read_only' });
  });
});

// --- La purga ------------------------------------------------------------------------

describe('la purga a los 24 meses', () => {
  it('borra los vencidos una vez al día por sitio y lo apunta sin datos personales', async () => {
    const { site, token } = await siteWithHomes();
    await post(token, WEB_BODIES.visit);
    await post(token, WEB_BODIES.report);
    await post(token, WEB_BODIES.landlord);
    const now = new Date('2026-11-21T04:00:00Z');
    const cutoff = retentionCutoff(now);
    expect(cutoff.toISOString()).toBe('2024-11-21T04:00:00.000Z');
    f.enquiries[0].createdAt = new Date(cutoff.getTime() - 1000);
    f.enquiries[1].createdAt = new Date(cutoff.getTime() - 400 * DAY);
    f.enquiries[2].createdAt = new Date(cutoff.getTime() + 1000);

    expect(await purgeOldEnquiries(asPrisma(), now)).toEqual({ sites: 1, deleted: 2 });
    expect(f.enquiries.map((e) => e.kind)).toEqual(['landlord']);
    expect(f.sites[0].enquiriesPurgedAt).toEqual(now);
    expect(f.audits.at(-1)).toEqual(
      expect.objectContaining({ siteId: site.id, entity: 'site', action: 'enquiries_purged', actor: 'system', metadata: { count: 2, olderThan: cutoff.toISOString() } }),
    );

    // El mismo día no vuelve a pasar, aunque venza otro.
    f.enquiries[0].createdAt = new Date(cutoff.getTime() - 1000);
    expect(await purgeOldEnquiries(asPrisma(), new Date(now.getTime() + 60 * 60 * 1000))).toEqual({ sites: 0, deleted: 0 });
    // Al día siguiente, sí.
    expect(await purgeOldEnquiries(asPrisma(), new Date(now.getTime() + DAY))).toEqual({ sites: 1, deleted: 1 });
    expect(f.enquiries).toHaveLength(0);
  });

  it('va en el cron cartera-tick', async () => {
    const { token } = await siteWithHomes();
    await post(token, WEB_BODIES.report);
    f.enquiries[0].createdAt = new Date(Date.now() - 800 * DAY);
    const r = await sweepCartera(asPrisma());
    expect(r.enquiriesPurged).toBe(1);
    expect(f.enquiries).toHaveLength(0);
  });
});

// --- Prueba de cierre ----------------------------------------------------------------

describe('prueba de cierre: los siete formularios de la web llegan a la pestaña Contactos', () => {
  it('un cuerpo exacto por tipo → 201 → en la pestaña, con sus casas y en español', async () => {
    state.leadsInbox = true;
    await siteWithHomes();
    const token = String(f.sites[0].feedToken);
    for (const body of Object.values(WEB_BODIES)) {
      const res = await post(token, body);
      expect(res.status, body.kind).toBe(201);
    }

    const { enquiries } = await (await enquiriesGet()).json();
    expect(enquiries).toHaveLength(7);
    const byKind = Object.fromEntries(enquiries.map((e: { kind: string }) => [e.kind, e]));
    expect(Object.keys(byKind).sort()).toEqual(['landlord', 'offmarket', 'report', 'saved_agency', 'saved_email', 'valuation', 'visit']);
    expect(byKind.visit).toMatchObject({ name: 'Ana Pérez', lang: 'es', refs: [{ ref: 'C-101' }], status: 'nuevo', copiedToLeads: true });
    expect(byKind.valuation).toMatchObject({ lang: 'en', summary: 'Zona golf · villa · 240 m² útiles · en buen estado · 4 dormitorios · con vistas, piscina · quiere el informe trimestral' });
    expect(byKind.landlord).toMatchObject({ lang: 'de', summary: 'Zona costa · gestión del alquiler' });
    expect(byKind.offmarket.summary).toBe('Cualquier zona · presupuesto de 3 a 6 M€');
    expect(byKind.report.summary).toBe('Pide el informe de mercado trimestral');
    expect(byKind.saved_email).toMatchObject({ name: null, contact: 'comprador@example.com', refs: [{ ref: 'C-101' }, { ref: 'A-201' }] });
    expect(byKind.saved_agency.refs.map((r: { ref: string }) => r.ref)).toEqual(['C-101']);
    // Las etiquetas en español que pinta la pestaña.
    expect(enquiries.map((e: { kind: string }) => KIND_LABELS[e.kind as keyof typeof KIND_LABELS])).not.toContain(undefined);

    // Siete avisos a la agencia y la lista al comprador.
    expect(state.sent.filter((m) => m.to[0] === 'agencia@example.com')).toHaveLength(7);
    expect(state.sent.filter((m) => m.to[0] === 'comprador@example.com')).toHaveLength(1);
    expect(f.leads).toHaveLength(7);
  });
});
