// =============================================================================
// 25/10/2026 — seguimiento por correo a los contactos entrantes con
// consentimiento comercial (lib/inbound-follow-up.ts).
//
// Lo que se fija:
//
// 1. «¿Toca ya?»: día 0 en el momento, días 3 y 7 en su día y en horario, y
//    nunca dos correos seguidos aunque el barrido se haya parado.
// 2. Las paradas: baja, ya es cliente, ya contactado.
// 3. La baja: un testigo cualquiera no toca nada; uno bueno da de baja a la
//    persona en las dos tablas.
// 4. El barrido: solo email con consentimiento, una sola secuencia por
//    persona, y la reserva antes de mandar.
// 5. Los textos: siempre con baja, nunca «sin IVA», sin cifras inventadas.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import {
  emailFromContact,
  nextFollowUpStep,
  followUpStopReason,
  buildFollowUpEmail,
  unsubscribeByToken,
  sweepInboundFollowUps,
  isPlausibleUnsubscribeToken,
  newUnsubscribeToken,
  FOLLOW_UP_MAX_AGE_DAYS,
  type FollowUpLinks,
} from '@/lib/inbound-follow-up';

// 10:00 UTC = 11:00 en Canarias (horario de verano hasta el 25/10).
const ALTA = new Date('2026-10-20T10:00:00Z');
const dias = (n: number) => new Date(ALTA.getTime() + n * 24 * 60 * 60 * 1000);
const none = new Set<string>();

describe('emailFromContact', () => {
  it('acepta un email y lo normaliza', () => {
    expect(emailFromContact('  Ana@Ejemplo.ES ')).toBe('ana@ejemplo.es');
  });
  it('un teléfono no es un email: queda fuera', () => {
    expect(emailFromContact('+34 600 11 22 33')).toBeNull();
    expect(emailFromContact('600112233')).toBeNull();
    expect(emailFromContact('ana@ejemplo')).toBeNull();
  });
});

describe('nextFollowUpStep', () => {
  it('recién llegado: el día 0 sale en el momento, a cualquier hora', () => {
    const noche = new Date('2026-10-20T23:30:00Z'); // 00:30 en Canarias
    expect(nextFollowUpStep({ createdAt: noche, done: none, lastSentAt: null }, noche)).toEqual({ send: 'dia_0', skip: [] });
  });

  it('el día 3 no se adelanta', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0']), lastSentAt: ALTA }, dias(2.9));
    expect(r.send).toBeNull();
  });

  it('el día 3 sale en su día y en horario', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0']), lastSentAt: ALTA }, dias(3));
    expect(r).toEqual({ send: 'dia_3', skip: [] });
  });

  it('el día 3 espera si es de noche en Canarias', () => {
    const noche = new Date(dias(3).getTime() + 12 * 60 * 60 * 1000); // 23:00 local
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0']), lastSentAt: ALTA }, noche);
    expect(r.send).toBeNull();
  });

  it('barrido parado una semana: manda solo el más reciente y sella los anteriores', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: none, lastSentAt: null }, dias(8));
    expect(r).toEqual({ send: 'dia_7', skip: ['dia_0', 'dia_3'] });
  });

  it('nunca dos correos con menos de dos días entre ellos', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0']), lastSentAt: dias(2) }, dias(3));
    expect(r.send).toBeNull();
  });

  it('pasado el plazo, lo que queda se sella sin mandar', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0']), lastSentAt: ALTA }, dias(FOLLOW_UP_MAX_AGE_DAYS + 1));
    expect(r).toEqual({ send: null, skip: ['dia_3', 'dia_7'] });
  });

  it('con la secuencia terminada no hay nada que hacer', () => {
    const r = nextFollowUpStep({ createdAt: ALTA, done: new Set(['dia_0', 'dia_3', 'dia_7']), lastSentAt: dias(7) }, dias(9));
    expect(r).toEqual({ send: null, skip: [] });
  });
});

describe('followUpStopReason', () => {
  it('cada parada corta la secuencia', () => {
    expect(followUpStopReason({ unsubscribed: true, isClient: false, contacted: false })).toBe('unsubscribed');
    expect(followUpStopReason({ unsubscribed: false, isClient: true, contacted: false })).toBe('is_client');
    expect(followUpStopReason({ unsubscribed: false, isClient: false, contacted: true })).toBe('contacted');
    expect(followUpStopReason({ unsubscribed: false, isClient: false, contacted: false })).toBeNull();
  });
});

const LINKS: FollowUpLinks = {
  unsubscribeUrl: 'https://portal.kairikos.cloud/api/public/baja/testigo',
  contactUrl: 'https://kairikos.com/contacto/',
  whatsappUrl: 'https://wa.me/34624514425',
  webPriceCents: 79900,
  recallOnSale: false,
  recallUrl: 'https://kairikos.com/llamadas/',
};

describe('buildFollowUpEmail', () => {
  const draft = { kind: 'web_draft' as const, businessName: 'Fontanería Pérez', city: 'Las Palmas', draftUrl: 'https://p/mi-web/abc' };
  const calc = {
    kind: 'calculator' as const,
    businessName: 'Reformas Gil',
    missedCallsPerWeek: 5,
    averageJobValueCents: 30000,
    annualLossCents: 1170000,
  };

  it('todos los pasos llevan la baja, quién escribe y nunca «sin IVA»', () => {
    for (const step of ['dia_0', 'dia_3', 'dia_7'] as const) {
      for (const contact of [draft, calc]) {
        const { text } = buildFollowUpEmail(step, contact, LINKS);
        expect(text).toContain(LINKS.unsubscribeUrl);
        expect(text).toContain('Kairikos');
        expect(text).not.toMatch(/sin IVA|IVA no incluido/i);
      }
    }
  });

  it('el día 0 del borrador lleva su enlace y el precio del catálogo como precio final', () => {
    const { text } = buildFollowUpEmail('dia_0', draft, LINKS);
    expect(text).toContain(draft.draftUrl);
    expect(text).toContain('799 €');
    expect(text).toContain('precio final');
  });

  it('sin precio del catálogo, no inventa una cifra', () => {
    const { text } = buildFollowUpEmail('dia_0', draft, { ...LINKS, webPriceCents: null });
    expect(text).not.toMatch(/\d+ €/);
  });

  it('el día 0 de la calculadora repite sus números y no vende Llamadas mientras no esté a la venta', () => {
    const { text } = buildFollowUpEmail('dia_0', calc, LINKS);
    expect(text).toContain('11.700 €');
    expect(text).toContain('300 €');
    expect(text).toContain('te apuntamos');
    expect(text).not.toContain(LINKS.recallUrl);
  });

  it('con Llamadas a la venta, enlaza a contratarlo', () => {
    const { text } = buildFollowUpEmail('dia_0', calc, { ...LINKS, recallOnSale: true });
    expect(text).toContain(LINKS.recallUrl);
  });

  it('el día 7 dice que es el último', () => {
    expect(buildFollowUpEmail('dia_7', draft, LINKS).text).toContain('último correo');
  });
});

describe('testigo de baja', () => {
  it('el que se genera pasa el filtro; basura no', () => {
    expect(isPlausibleUnsubscribeToken(newUnsubscribeToken())).toBe(true);
    expect(isPlausibleUnsubscribeToken("x' OR 1=1 --")).toBe(false);
    expect(isPlausibleUnsubscribeToken('corto')).toBe(false);
  });
});

function makePrisma() {
  return {
    publicDraftRequest: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() },
    calculatorLead: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }), update: vi.fn() },
    chatbotClient: { findMany: vi.fn().mockResolvedValue([]) },
    chatbotClientUser: { findMany: vi.fn().mockResolvedValue([]) },
    product: { findFirst: vi.fn().mockResolvedValue({ setupFeeCents: 79900 }) },
    inboundFollowUpEmail: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'claim-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('unsubscribeByToken', () => {
  it('un testigo con mala forma no consulta nada', async () => {
    const prisma = makePrisma();
    expect(await unsubscribeByToken(prisma as never, 'mal')).toEqual({ ok: false });
    expect(prisma.publicDraftRequest.findUnique).not.toHaveBeenCalled();
  });

  it('un testigo desconocido no da de baja a nadie', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findUnique.mockResolvedValue(null);
    prisma.calculatorLead.findUnique.mockResolvedValue(null);
    expect(await unsubscribeByToken(prisma as never, newUnsubscribeToken())).toEqual({ ok: false });
    expect(prisma.publicDraftRequest.updateMany).not.toHaveBeenCalled();
  });

  it('da de baja a la persona en las dos tablas, por su email', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findUnique.mockResolvedValue({ contact: 'Ana@Ejemplo.es' });
    prisma.calculatorLead.findUnique.mockResolvedValue(null);
    const now = new Date('2026-10-25T12:00:00Z');
    expect(await unsubscribeByToken(prisma as never, newUnsubscribeToken(), now)).toEqual({ ok: true });
    const expected = {
      where: { contact: { equals: 'ana@ejemplo.es', mode: 'insensitive' }, unsubscribedAt: null },
      data: { unsubscribedAt: now },
    };
    expect(prisma.publicDraftRequest.updateMany).toHaveBeenCalledWith(expected);
    expect(prisma.calculatorLead.updateMany).toHaveBeenCalledWith(expected);
  });
});

describe('sweepInboundFollowUps', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: 'x' }, error: null });
    process.env.RESEND_API_KEY = 're_test';
  });

  const draftRow = (over: Record<string, unknown> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    token: 'tok',
    contact: 'ana@ejemplo.es',
    businessName: 'Fontanería Pérez',
    city: 'Las Palmas',
    createdAt: ALTA,
    unsubscribeToken: null,
    ...over,
  });

  it('un contacto nuevo con email recibe el día 0: reserva, testigo de baja y envío con List-Unsubscribe', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow()]).mockResolvedValueOnce([]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r.sent).toBe(1);
    expect(prisma.inboundFollowUpEmail.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ step: 'dia_0', status: 'sending', email: 'ana@ejemplo.es' }) }),
    );
    expect(prisma.publicDraftRequest.update).toHaveBeenCalled(); // testigo de baja
    const args = sendMock.mock.calls[0][0];
    expect(args.to).toEqual(['ana@ejemplo.es']);
    expect(args.headers['List-Unsubscribe']).toMatch(/\/api\/public\/baja\//);
    expect(args.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(prisma.inboundFollowUpEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    );
  });

  it('sin clave de Resend no reserva nada (no quema los toques)', async () => {
    delete process.env.RESEND_API_KEY;
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow()]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r.sent + r.failed).toBe(0);
    expect(prisma.inboundFollowUpEmail.create).not.toHaveBeenCalled();
  });

  it('un teléfono no recibe nada', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow({ contact: '600112233' })]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r).toMatchObject({ candidates: 0, sent: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('si se dio de baja en otra fila, no se le escribe', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany
      .mockResolvedValueOnce([draftRow()])
      .mockResolvedValueOnce([{ contact: 'ANA@ejemplo.es', unsubscribedAt: dias(-20), contactedAt: null }]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r).toMatchObject({ stopped: 1, sent: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('si ya es cliente, no se le escribe', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow()]).mockResolvedValueOnce([]);
    prisma.chatbotClient.findMany.mockResolvedValue([{ email: 'Ana@Ejemplo.es' }]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r).toMatchObject({ stopped: 1, sent: 0 });
  });

  it('si el operador ya le contactó, no se le escribe', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany
      .mockResolvedValueOnce([draftRow()])
      .mockResolvedValueOnce([{ contact: 'ana@ejemplo.es', unsubscribedAt: null, contactedAt: dias(0) }]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r).toMatchObject({ stopped: 1, sent: 0 });
  });

  it('si otro barrido ya reservó el paso, este no manda', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow()]).mockResolvedValueOnce([]);
    prisma.inboundFollowUpEmail.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' }),
    );
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('dos peticiones de la misma persona: una sola secuencia, la más reciente', async () => {
    const prisma = makePrisma();
    const vieja = draftRow({ id: '22222222-2222-4222-8222-222222222222', createdAt: dias(-1) });
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([vieja, draftRow()]).mockResolvedValueOnce([]);
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(prisma.inboundFollowUpEmail.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceId: draftRow().id }) }),
    );
    expect(prisma.inboundFollowUpEmail.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ sourceId: vieja.id, status: 'skipped', error: 'superseded' })]),
        skipDuplicates: true,
      }),
    );
  });

  it('si Resend falla, el toque queda como fallido y no se reintenta', async () => {
    const prisma = makePrisma();
    prisma.publicDraftRequest.findMany.mockResolvedValueOnce([draftRow()]).mockResolvedValueOnce([]);
    sendMock.mockResolvedValue({ data: null, error: { message: 'The domain is invalid' } });
    const r = await sweepInboundFollowUps(prisma as never, dias(0.01));
    expect(r.failed).toBe(1);
    expect(prisma.inboundFollowUpEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
