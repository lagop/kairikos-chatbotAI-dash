// =============================================================================
// Informe mensual de resultados de la web Premium (lib/web-results-report.ts).
//
// Cuándo toca (día 1 desde las 09:00 de Canarias, con margen hasta el 3),
// cómo se agregan los contadores diarios con el chat y las llamadas, y qué
// dice el correo: asunto, métricas a cero fuera, flechas, HTML escapado.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const resendSend = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import {
  buildWebResultsEmail,
  computeWebResults,
  emptyWebResults,
  formatChange,
  isResultsReportDue,
  monthRange,
  sendWebResultsReports,
  type WebResults,
} from '@/lib/web-results-report';

const SITE_ID = '11111111-1111-4111-8111-111111111111';

function results(overrides: Partial<WebResults>): WebResults {
  return { ...emptyWebResults(), ...overrides };
}

describe('isResultsReportDue', () => {
  it('el día 1 solo desde las 09:00 de Canarias (UTC+0 en invierno)', () => {
    expect(isResultsReportDue(new Date('2026-12-01T08:59:00Z'), null)).toBe(false);
    expect(isResultsReportDue(new Date('2026-12-01T09:00:00Z'), null)).toBe(true);
  });

  it('en verano Canarias va una hora por delante de UTC', () => {
    expect(isResultsReportDue(new Date('2026-07-01T07:59:00Z'), null)).toBe(false);
    expect(isResultsReportDue(new Date('2026-07-01T08:00:00Z'), null)).toBe(true);
  });

  it('el 2 y el 3 recuperan un día 1 perdido; el 4 ya no', () => {
    expect(isResultsReportDue(new Date('2026-12-02T03:00:00Z'), null)).toBe(true);
    expect(isResultsReportDue(new Date('2026-12-03T23:00:00Z'), null)).toBe(true);
    expect(isResultsReportDue(new Date('2026-12-04T10:00:00Z'), null)).toBe(false);
    expect(isResultsReportDue(new Date('2026-12-15T10:00:00Z'), null)).toBe(false);
  });

  it('una vez por mes: el cursor se compara por mes', () => {
    const now = new Date('2026-12-01T10:00:00Z');
    expect(isResultsReportDue(now, new Date('2026-12-01T09:05:00Z'))).toBe(false);
    expect(isResultsReportDue(now, new Date('2026-11-01T09:05:00Z'))).toBe(true);
    // Un tick que corre cien veces el día 2 tampoco repite.
    expect(isResultsReportDue(new Date('2026-12-02T10:00:00Z'), new Date('2026-12-01T09:05:00Z'))).toBe(false);
  });
});

describe('monthRange', () => {
  it('cada extremo con su propio desfase: octubre incluye el 31 entero', () => {
    // El 25/10/2026 Canarias pasa de UTC+1 a UTC+0.
    const { since, until } = monthRange('2026-10');
    expect(since.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(until.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('diciembre cierra el año', () => {
    const { since, until } = monthRange('2026-12');
    expect(since.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(until.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

function fakeDb(opts: {
  groups?: Array<{ kind: string; source: string; _sum: { count: number | null } }>;
  chatbotProducts?: number;
  conversations?: number;
  calls?: number;
  isPrimary?: boolean;
}) {
  const db = {
    clientSite: {
      findUnique: vi.fn().mockResolvedValue({ id: SITE_ID, clientId: 'client-1', isPrimary: opts.isPrimary ?? true }),
    },
    webEventDay: { groupBy: vi.fn().mockResolvedValue(opts.groups ?? []) },
    clientProduct: { count: vi.fn().mockResolvedValue(opts.chatbotProducts ?? 0) },
    callEvent: { count: vi.fn().mockResolvedValue(opts.calls ?? 0) },
    chatbotConversation: { count: vi.fn().mockResolvedValue(opts.conversations ?? 0) },
  };
  return db;
}

describe('computeWebResults', () => {
  const { since, until } = monthRange('2026-10');

  it('suma los contadores por tipo y origen', async () => {
    const db = fakeDb({
      groups: [
        { kind: 'landing', source: 'ai', _sum: { count: 18 } },
        { kind: 'landing', source: 'search', _sum: { count: 300 } },
        { kind: 'landing', source: 'direct', _sum: { count: 82 } },
        { kind: 'call_click', source: '', _sum: { count: 14 } },
        { kind: 'whatsapp_click', source: '', _sum: { count: 22 } },
        { kind: 'email_click', source: '', _sum: { count: 3 } },
        { kind: 'form_submit', source: '', _sum: { count: 6 } },
        { kind: 'booking_submit', source: '', _sum: { count: 3 } },
        { kind: 'chat_start', source: '', _sum: { count: 40 } },
      ],
      calls: 4,
    });
    const r = await computeWebResults(db as unknown as PrismaClient, SITE_ID, since, until);
    expect(r).toMatchObject({
      visitas: 400,
      visitasIa: 18,
      llamadasClic: 14,
      whatsapp: 22,
      emails: 3,
      formulariosContacto: 6,
      reservas: 3,
      formularios: 9,
      chatsWeb: 40,
      // Sin chatbot del portal: la cifra de chat es la de la web.
      chats: 40,
      conversaciones: null,
      llamadasRecuperadas: 4,
    });
  });

  it('los días van del 1 al último del mes local, incluido el 31 de octubre', async () => {
    const db = fakeDb({});
    await computeWebResults(db as unknown as PrismaClient, SITE_ID, since, until);
    const where = db.webEventDay.groupBy.mock.calls[0][0].where;
    expect(where.clientSiteId).toBe(SITE_ID);
    expect(where.day.gte.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(where.day.lte.toISOString().slice(0, 10)).toBe('2026-10-31');
  });

  it('con chatbot del portal, manda el número de conversaciones', async () => {
    const db = fakeDb({ groups: [{ kind: 'chat_start', source: '', _sum: { count: 40 } }], chatbotProducts: 1, conversations: 31 });
    const r = await computeWebResults(db as unknown as PrismaClient, SITE_ID, since, until);
    expect(r.chats).toBe(31);
    expect(r.conversaciones).toBe(31);
    expect(r.chatsWeb).toBe(40);
  });

  it('las llamadas excluyen las bloqueadas y buscan los productos de este sitio', async () => {
    const db = fakeDb({ isPrimary: false });
    await computeWebResults(db as unknown as PrismaClient, SITE_ID, since, until);
    const where = db.callEvent.count.mock.calls[0][0].where;
    expect(where.outcome).toEqual({ not: 'blocked' });
    expect(where.subscription.clientProduct.OR).toEqual([{ clientSiteId: SITE_ID }]);
  });

  it('el sitio primario se queda también las contrataciones sin sitio', async () => {
    const db = fakeDb({ isPrimary: true });
    await computeWebResults(db as unknown as PrismaClient, SITE_ID, since, until);
    const where = db.callEvent.count.mock.calls[0][0].where;
    expect(where.subscription.clientProduct.OR).toEqual([
      { clientSiteId: SITE_ID },
      { clientSiteId: null, clientId: 'client-1' },
    ]);
  });
});

describe('formatChange', () => {
  it('flechas, número y porcentaje', () => {
    expect(formatChange(14, 10)).toBe('▲ 4 (+40 %)');
    expect(formatChange(8, 10)).toBe('▼ 2 (−20 %)');
    expect(formatChange(5, 5)).toBe('= sin cambios');
  });

  it('sin porcentaje cuando el mes anterior fue 0', () => {
    expect(formatChange(7, 0)).toBe('▲ 7');
  });
});

describe('buildWebResultsEmail', () => {
  const base = {
    siteName: 'Alisio Dental Studio',
    monthLabel: 'noviembre',
    previousMonthLabel: 'octubre',
    panelUrl: 'https://portal.kairikos.cloud/portal/web/abc',
  };

  it('el asunto lleva las tres primeras cifras con algo', () => {
    const { subject } = buildWebResultsEmail({
      ...base,
      current: results({ llamadasClic: 14, whatsapp: 22, formularios: 9, reservas: 3, emails: 2, visitas: 500 }),
      previous: emptyWebResults(),
    });
    expect(subject).toBe('Tu web en noviembre: 14 llamadas, 22 WhatsApp, 9 formularios');
  });

  it('salta las métricas a cero y usa el singular', () => {
    const { subject, text } = buildWebResultsEmail({
      ...base,
      current: results({ formularios: 1, formulariosContacto: 1, chats: 3, visitas: 40 }),
      previous: results({ visitas: 30 }),
    });
    expect(subject).toBe('Tu web en noviembre: 1 formulario, 3 conversaciones, 40 visitas');
    expect(text).not.toContain('· WhatsApp');
    expect(text).not.toContain('· Emails');
    expect(text).not.toContain('Llamadas perdidas recuperadas');
    expect(text).not.toContain('buscadores con IA');
    expect(text).toContain('· Visitas: 40 ▲ 10 (+33 %)');
  });

  it('una métrica que cae a cero sigue saliendo, con su flecha hacia abajo', () => {
    const { text } = buildWebResultsEmail({
      ...base,
      current: results({ whatsapp: 0, llamadasClic: 3 }),
      previous: results({ whatsapp: 4, llamadasClic: 3 }),
    });
    expect(text).toContain('· WhatsApp: 0 ▼ 4 (−100 %)');
    expect(text).toContain('· Llamadas desde la web: 3 = sin cambios');
  });

  it('encabeza con los contactos y explica las visitas desde IA', () => {
    const { text, html } = buildWebResultsEmail({
      ...base,
      current: results({ llamadasClic: 14, whatsapp: 22, emails: 2, formularios: 9, reservas: 3, visitasIa: 18, visitas: 300 }),
      previous: results({ llamadasClic: 10, whatsapp: 20, emails: 2, formularios: 7, visitasIa: 11, visitas: 280 }),
    });
    expect(text).toContain('Contactos desde la web: 47 ▲ 8 (+21 %)');
    expect(text).toContain('· Formularios y reservas: 9 (3 reservas) ▲ 2 (+29 %)');
    expect(text).toContain('Visitas desde buscadores con IA: 18 ▲ 7 (+64 %)');
    expect(text).toContain('ChatGPT, Perplexity, Claude, Gemini o Copilot');
    expect(text).toContain('comparado con octubre');
    expect(text).toContain('Cuidado Premium');
    expect(text).toContain(base.panelUrl);
    expect(html).toContain(`href="${base.panelUrl}"`);
    // Sin promesas ni superlativos.
    expect(`${text} ${html}`).not.toMatch(/el mejor|garantiza/i);
  });

  it('escapa el HTML del nombre del sitio y del enlace', () => {
    const { html, text } = buildWebResultsEmail({
      ...base,
      siteName: 'Clínica <b>"Sol"</b> & Mar',
      panelUrl: 'https://portal.kairikos.cloud/portal/web?x="><script>',
      current: results({ llamadasClic: 1 }),
      previous: emptyWebResults(),
    });
    expect(html).toContain('Clínica &lt;b&gt;&quot;Sol&quot;&lt;/b&gt; &amp; Mar');
    expect(html).not.toContain('<b>"Sol"</b>');
    expect(html).not.toContain('"><script>');
    // El texto plano va tal cual.
    expect(text).toContain('Clínica <b>"Sol"</b> & Mar');
  });
});

describe('sendWebResultsReports', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;
  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test';
    resendSend.mockReset();
    resendSend.mockResolvedValue({ data: { id: 'm1' }, error: null });
  });
  afterEach(() => {
    process.env.RESEND_API_KEY = ORIGINAL_KEY;
  });

  function sweepDb(opts: { groups?: Array<{ kind: string; source: string; _sum: { count: number } }>; lastAt?: Date | null }) {
    const base = fakeDb({ groups: opts.groups ?? [] });
    return {
      ...base,
      clientSite: {
        ...base.clientSite,
        findMany: vi.fn().mockResolvedValue([
          {
            id: SITE_ID,
            name: 'Alisio Dental Studio',
            lastResultsReportAt: opts.lastAt ?? null,
            client: { email: 'hola@alisio.example' },
            products: [{ id: 'web-cp-1' }],
          },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  it('fuera de los días 1 a 3 ni consulta', async () => {
    const db = sweepDb({});
    const r = await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-10T10:00:00Z'));
    expect(r).toEqual({ considered: 0, sent: 0, skipped: 0, failed: 0 });
    expect(db.clientSite.findMany).not.toHaveBeenCalled();
  });

  it('solo sitios con token, sin archivar y con Cuidado activo', async () => {
    const db = sweepDb({});
    await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-01T10:00:00Z'));
    const where = db.clientSite.findMany.mock.calls[0][0].where;
    expect(where.eventsToken).toEqual({ not: null });
    expect(where.archivedAt).toBeNull();
    expect(where.products.some).toEqual({ status: 'active', product: { code: 'web_care' } });
  });

  it('un mes sin actividad no manda nada pero avanza el cursor', async () => {
    const db = sweepDb({});
    const now = new Date('2026-12-01T10:00:00Z');
    const r = await sendWebResultsReports(db as unknown as PrismaClient, now);
    expect(r).toEqual({ considered: 1, sent: 0, skipped: 1, failed: 0 });
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.clientSite.update).toHaveBeenCalledWith({ where: { id: SITE_ID }, data: { lastResultsReportAt: now } });
  });

  it('manda el informe de noviembre al email del cliente con el enlace a su web', async () => {
    const db = sweepDb({ groups: [{ kind: 'call_click', source: '', _sum: { count: 5 } }] });
    const r = await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-01T10:00:00Z'));
    expect(r.sent).toBe(1);
    const payload = resendSend.mock.calls[0][0];
    expect(payload.to).toEqual(['hola@alisio.example']);
    expect(payload.subject).toBe('Tu web en noviembre: 5 llamadas');
    expect(payload.text).toContain('/portal/web/web-cp-1');
    expect(db.clientSite.update).toHaveBeenCalledTimes(1);
  });

  it('ya informado este mes: no repite', async () => {
    const db = sweepDb({ groups: [{ kind: 'call_click', source: '', _sum: { count: 5 } }], lastAt: new Date('2026-12-01T09:05:00Z') });
    const r = await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-01T10:00:00Z'));
    expect(r.considered).toBe(0);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('si el envío falla cuenta el fallo, avanza el cursor y no lanza', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'The domain is invalid' } });
    const db = sweepDb({ groups: [{ kind: 'call_click', source: '', _sum: { count: 5 } }] });
    const r = await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-01T10:00:00Z'));
    expect(r).toEqual({ considered: 1, sent: 0, skipped: 0, failed: 1 });
    expect(db.clientSite.update).toHaveBeenCalledTimes(1);
  });

  it('si la consulta falla devuelve el resumen vacío', async () => {
    const db = sweepDb({});
    db.clientSite.findMany.mockRejectedValue(new Error('db down'));
    const r = await sendWebResultsReports(db as unknown as PrismaClient, new Date('2026-12-01T10:00:00Z'));
    expect(r).toEqual({ considered: 0, sent: 0, skipped: 0, failed: 0 });
  });
});
