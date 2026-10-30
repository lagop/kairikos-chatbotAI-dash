import { describe, expect, it, vi, beforeEach } from 'vitest';

// 30/10/2026 — los borradores de kairikos.com se entregan en menos de 24
// horas (lib/public-draft-delivery.ts): cuándo se reintenta escribirlos,
// cuándo salen, qué correo le llega a cada uno y que no salga dos veces.

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), generate: vi.fn() }));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/inbound-follow-up', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbound-follow-up')>()),
  deliverInboundEmail: (...a: unknown[]) => mocks.deliver(...a),
  readWebPriceCents: vi.fn(async () => 49000),
}));
vi.mock('@/lib/public-draft-request', () => ({
  MAX_GENERATION_ATTEMPTS: 5,
  generatePublicDraft: (...a: unknown[]) => mocks.generate(...a),
}));

import type { PrismaClient } from '@prisma/client';
import {
  buildDraftReadyEmail,
  deliveryDueAt,
  formatDeliveryDeadline,
  generationRetryDue,
  releasePublicDraft,
  renderPreparingPage,
  sweepPublicDrafts,
  DELIVERY_HOURS,
} from '@/lib/public-draft-delivery';

const H = 60 * 60 * 1000;
const T0 = new Date('2026-10-30T10:00:00Z');

describe('plazos', () => {
  it('sale a las 23 horas, para llegar dentro de las 24 que promete la web', () => {
    expect(DELIVERY_HOURS).toBe(23);
    expect(deliveryDueAt(T0).toISOString()).toBe('2026-10-31T09:00:00.000Z');
  });

  it('el plazo se lee en hora de Canarias', () => {
    // 31/10 09:00 UTC = 09:00 en Canarias (horario de invierno desde el 25/10).
    expect(formatDeliveryDeadline(deliveryDueAt(T0))).toBe('sábado 31 de octubre, a las 09:00');
  });

  it('el reintento espera una hora más por cada intento, y para en el tope', () => {
    const at = (min: number) => new Date(T0.getTime() + min * 60 * 1000);
    // Sin intentos (la ruta no llegó a escribirlo): a los dos minutos.
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 0 }, at(1))).toBe(false);
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 0 }, at(2))).toBe(true);
    // Uno fallido: a la hora; dos: a las dos horas.
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 1 }, at(30))).toBe(false);
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 1 }, at(60))).toBe(true);
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 2 }, at(90))).toBe(false);
    expect(generationRetryDue({ createdAt: T0, generationAttempts: 5 }, at(60 * 20))).toBe(false);
  });
});

describe('el correo de «ya está»', () => {
  const marketing = {
    unsubscribeUrl: 'https://portal.example/api/public/baja/x',
    contactUrl: 'https://kairikos.com/contacto/',
    whatsappUrl: 'https://wa.me/34000000000',
    webPriceCents: 49000,
  };

  it('sin la casilla marcada, solo lo que pidió: su enlace, sin precio ni ofertas', () => {
    const { subject, text } = buildDraftReadyEmail({ businessName: 'Fontanería Pérez', draftUrl: 'https://p/mi-web/t', marketing: null });
    expect(subject).toBe('Ya está la web de Fontanería Pérez');
    expect(text).toContain('https://p/mi-web/t');
    expect(text).not.toMatch(/€|Reserva|WhatsApp|baja/);
    expect(text).toContain('Te escribimos porque pediste en kairikos.com');
  });

  it('con la casilla, precio final, cita, WhatsApp y la baja de un clic', () => {
    const { text } = buildDraftReadyEmail({ businessName: 'Fontanería Pérez', draftUrl: 'https://p/mi-web/t', marketing });
    expect(text).toContain('490 €');
    expect(text).toContain('no se le suma ningún impuesto');
    expect(text).toContain(marketing.contactUrl);
    expect(text).toContain(marketing.whatsappUrl);
    expect(text).toContain(marketing.unsubscribeUrl);
  });

  it('la página de espera escapa el nombre y no dice a qué correo va', () => {
    const html = renderPreparingPage({ businessName: 'Bar <Pepe>', dueAt: deliveryDueAt(T0) });
    expect(html).toContain('Bar &lt;Pepe&gt;');
    expect(html).not.toContain('<Pepe>');
    expect(html).toContain('antes del sábado 31 de octubre, a las 09:00');
    expect(html).not.toMatch(/@(?!kairikos\.com)/);
  });
});

function fakePrisma(row: Record<string, unknown>, opts: { claim?: number } = {}) {
  const calls = { claim: vi.fn(), update: vi.fn(), followUp: vi.fn(), findMany: vi.fn() };
  const prisma = {
    publicDraftRequest: {
      updateMany: vi.fn(async (args: unknown) => {
        calls.claim(args);
        return { count: opts.claim ?? 1 };
      }),
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async (args: unknown) => calls.update(args)),
      findMany: calls.findMany,
    },
    inboundFollowUpEmail: { createMany: vi.fn(async (args: unknown) => calls.followUp(args)) },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

const ROW = {
  token: 'a'.repeat(64),
  businessName: 'Fontanería Pérez',
  contact: 'Hola@Perez.es',
  marketingConsentAt: null,
  unsubscribedAt: null,
  unsubscribeToken: null,
  sentAt: null,
  model: 'claude-sonnet-5',
};

describe('releasePublicDraft', () => {
  beforeEach(() => {
    mocks.deliver.mockReset().mockResolvedValue(null);
    mocks.generate.mockReset();
  });

  it('se reserva con condición (sin enviar y ya escrito) y manda el correo de servicio', async () => {
    const { prisma, calls } = fakePrisma(ROW);
    expect(await releasePublicDraft(prisma, 'id-1', { now: T0 })).toBe('sent');
    const claim = calls.claim.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 'id-1', sentAt: null });
    expect(claim.where.copy).toBeDefined();
    expect(claim.data).toEqual({ sentAt: T0, deliveryError: null });
    const [to, , unsubscribe] = mocks.deliver.mock.calls[0];
    expect(to).toBe('hola@perez.es');
    // Sin consentimiento: sin cabecera de baja ni fila de seguimiento.
    expect(unsubscribe).toBeNull();
    expect(calls.followUp).not.toHaveBeenCalled();
  });

  it('con consentimiento, la versión comercial cuenta como el día 0 del seguimiento', async () => {
    const { prisma, calls } = fakePrisma({ ...ROW, marketingConsentAt: T0 });
    expect(await releasePublicDraft(prisma, 'id-1', { now: T0 })).toBe('sent');
    expect(mocks.deliver.mock.calls[0][2]).toMatch(/\/api\/public\/baja\/[A-Za-z0-9_-]+$/);
    expect(calls.update.mock.calls[0][0].data.unsubscribeToken).toBeTruthy();
    expect(calls.followUp.mock.calls[0][0]).toEqual({
      data: [{ source: 'web_draft', sourceId: 'id-1', email: 'hola@perez.es', step: 'dia_0', status: 'sent', sentAt: T0 }],
      skipDuplicates: true,
    });
  });

  it('dado de baja: recibe lo que pidió, pero sin ofertas', async () => {
    const { prisma } = fakePrisma({ ...ROW, marketingConsentAt: T0, unsubscribedAt: T0 });
    await releasePublicDraft(prisma, 'id-1', { now: T0 });
    expect(mocks.deliver.mock.calls[0][2]).toBeNull();
    expect(mocks.deliver.mock.calls[0][1].text).not.toContain('€');
  });

  it('si otro ya lo envió no manda nada; si no está escrito, lo dice', async () => {
    const taken = fakePrisma(ROW, { claim: 0 });
    expect(await releasePublicDraft(taken.prisma, 'id-1')).toBe('already');
    const unwritten = fakePrisma({ ...ROW, model: null }, { claim: 0 });
    expect(await releasePublicDraft(unwritten.prisma, 'id-1')).toBe('not_ready');
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('sin correo (formulario antiguo) abre el enlace y no manda nada', async () => {
    const { prisma } = fakePrisma({ ...ROW, contact: '600112233' });
    expect(await releasePublicDraft(prisma, 'id-1')).toBe('sent_no_email');
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('si el correo falla, el enlace queda abierto y el motivo, guardado', async () => {
    mocks.deliver.mockResolvedValue('The domain is invalid');
    const { prisma, calls } = fakePrisma(ROW);
    expect(await releasePublicDraft(prisma, 'id-1')).toBe('email_failed');
    expect(calls.update.mock.calls[0][0].data).toEqual({ deliveryError: 'The domain is invalid' });
  });

  it('el botón del operador puede reintentar un correo que falló', async () => {
    const { prisma, calls } = fakePrisma(ROW);
    await releasePublicDraft(prisma, 'id-1', { retryFailed: true });
    expect(calls.claim.mock.calls[0][0].where.OR).toEqual([{ sentAt: null }, { deliveryError: { not: null } }]);
  });
});

describe('sweepPublicDrafts', () => {
  beforeEach(() => {
    mocks.deliver.mockReset().mockResolvedValue(null);
    mocks.generate.mockReset().mockResolvedValue('generated');
  });

  it('escribe como mucho dos por pasada, solo los que toca reintentar, y envía los vencidos', async () => {
    const now = new Date(T0.getTime() + 3 * H);
    const { prisma, calls } = fakePrisma(ROW);
    calls.findMany
      .mockResolvedValueOnce([
        { id: 'p1', createdAt: T0, generationAttempts: 1 },
        { id: 'p2', createdAt: new Date(now.getTime() - 60 * 1000), generationAttempts: 0 },
        { id: 'p3', createdAt: T0, generationAttempts: 2 },
        { id: 'p4', createdAt: T0, generationAttempts: 0 },
      ])
      .mockResolvedValueOnce([{ id: 'd1' }]);
    const r = await sweepPublicDrafts(prisma, now);
    // p2 es de hace un minuto (le toca a la ruta); p1 y p3 sí tocan; p4 se queda para la próxima.
    expect(mocks.generate.mock.calls.map((c) => c[1])).toEqual(['p1', 'p3']);
    expect(r).toMatchObject({ generated: 2, released: 1 });
    const dueWhere = calls.findMany.mock.calls[1][0].where;
    expect(dueWhere.sentAt).toBeNull();
    expect(dueWhere.createdAt.lte.getTime()).toBe(now.getTime() - 23 * H);
  });
});
