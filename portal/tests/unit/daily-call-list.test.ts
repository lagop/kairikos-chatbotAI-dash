// =============================================================================
// 04/10/2026 — la lista diaria de llamadas (lib/daily-call-list.ts) y el
// «ya se mandó hoy» de los resúmenes al operador (claimDailyOperatorDigest),
// que también arregla el barrido de salud de clientes: sin él, un cliente en
// riesgo habría generado un correo cada 5 minutos.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  send: vi.fn(),
  recipients: vi.fn(),
}));

vi.mock('@/lib/operator-notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operator-notify')>();
  return { ...actual, sendOperatorNotification: (...a: unknown[]) => mockState.send(...a) };
});
vi.mock('@/lib/operator-alert-settings', () => ({ getOperatorAlertRecipients: () => mockState.recipients() }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { callHook, isCallListDue, loadCallList, renderCallList, sendDailyCallList, type CallListLead } from '@/lib/daily-call-list';
import { sweepClientHealth } from '@/lib/client-health';

// Martes 06/10/2026. 08:00 UTC = 10:00 en Madrid (horario de verano).
const TUESDAY_10_MADRID = new Date('2026-10-06T08:00:00Z');

const LEAD = (over: Partial<CallListLead> = {}): CallListLead => ({
  id: 'l1',
  contactName: 'Reformas López',
  contactPhone: '+34 600 111 222',
  website: 'https://reformaslopez.es',
  searchCategory: 'reformas',
  searchLocation: 'Las Palmas',
  score: 80,
  scoreReason: 'Muchas obras y sin respuesta fuera de horario.',
  repliedAt: null,
  competitorSnapshot: { subjectRating: 4.6, subjectReviewCount: 54, shareToken: 'tok_1' },
  ...over,
});

function makePrisma(opts: { existingClaim?: boolean; leads?: CallListLead[] } = {}) {
  return {
    operatorNotification: {
      findFirst: vi.fn().mockResolvedValue(opts.existingClaim ? { id: 'n0' } : null),
      create: vi.fn().mockResolvedValue({ id: 'n1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
    lead: { findMany: vi.fn().mockResolvedValue(opts.leads ?? [LEAD()]) },
  };
}

beforeEach(() => {
  mockState.send.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.recipients.mockReset().mockResolvedValue([{ email: 'ops@kairikos.com' }]);
});

describe('isCallListDue', () => {
  it('de lunes a viernes, a partir de las 8:30 de Madrid', () => {
    expect(isCallListDue(new Date('2026-10-06T06:29:00Z'))).toBe(false); // 8:29 Madrid
    expect(isCallListDue(new Date('2026-10-06T06:30:00Z'))).toBe(true); // 8:30 Madrid
  });

  it('nunca en fin de semana', () => {
    expect(isCallListDue(new Date('2026-10-10T10:00:00Z'))).toBe(false); // sábado
    expect(isCallListDue(new Date('2026-10-11T10:00:00Z'))).toBe(false); // domingo
  });
});

describe('callHook', () => {
  it('quien contestó va primero en el mensaje', () => {
    expect(callHook(LEAD({ repliedAt: new Date() }))).toMatch(/contestado/);
  });
  it('sin web, abre con la web', () => {
    expect(callHook(LEAD({ website: null }))).toMatch(/No tiene web/);
  });
  it('con pocas reseñas, abre con su informe y Reseñas', () => {
    expect(callHook(LEAD({ competitorSnapshot: { subjectRating: 4.8, subjectReviewCount: 7, shareToken: null } }))).toMatch(
      /Solo 7 reseñas/,
    );
  });
  it('con nota baja, abre con las reseñas', () => {
    expect(callHook(LEAD({ competitorSnapshot: { subjectRating: 3.9, subjectReviewCount: 80, shareToken: null } }))).toMatch(
      /3,9/,
    );
  });
  it('si no, la pregunta de las llamadas perdidas', () => {
    expect(callHook(LEAD())).toMatch(/llamadas pierde/);
  });
});

describe('loadCallList', () => {
  it('solo prospectos de la cuenta interna, sin contactar, con teléfono y que no pidieron que no les contactemos', async () => {
    const prisma = makePrisma();
    await loadCallList(prisma as never);
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          client: { isInternal: true },
          source: 'outbound',
          status: 'nuevo',
          optedOutAt: null,
          contactPhone: { not: null },
        },
        orderBy: [
          { repliedAt: { sort: 'desc', nulls: 'last' } },
          { score: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        take: 15,
      }),
    );
  });
});

describe('renderCallList', () => {
  it('teléfono pulsable, gancho, por qué e informe; y cómo sacar a alguien de la lista', () => {
    const { subject, text, html } = renderCallList([LEAD()], 'https://portal.kairikos.cloud', '2026-10-06');
    expect(subject).toBe('Llamadas de hoy (2026-10-06): 1 negocio');
    expect(text).toContain('1. Reformas López — +34 600 111 222 (reformas · Las Palmas)');
    expect(text).toContain('Informe: https://portal.kairikos.cloud/informe/tok_1');
    expect(text).toContain('márcalo como contactado o descartado');
    expect(html).toContain('href="tel:+34600111222"');
  });

  it('escapa lo que viene de Google', () => {
    const { html } = renderCallList([LEAD({ contactName: '<script>x</script>' })], 'https://p', 'd');
    expect(html).not.toContain('<script>x');
  });
});

describe('sendDailyCallList', () => {
  it('a su hora, reclama el día y manda la lista', async () => {
    const prisma = makePrisma();
    await expect(sendDailyCallList(prisma as never, TUESDAY_10_MADRID)).resolves.toEqual({ sent: true, leads: 1 });
    expect(prisma.operatorNotification.create).toHaveBeenCalledWith({
      data: { kind: 'daily-call-list', day: '2026-10-06', subject: 'Llamadas de hoy (2026-10-06)' },
      select: { id: true },
    });
    expect(mockState.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'daily-call-list' }));
  });

  it('una segunda pasada el mismo día no manda nada', async () => {
    const prisma = makePrisma({ existingClaim: true });
    await expect(sendDailyCallList(prisma as never, TUESDAY_10_MADRID)).resolves.toEqual({ sent: false, reason: 'already_sent' });
    expect(mockState.send).not.toHaveBeenCalled();
  });

  it('sin nadie a quien llamar no manda un correo vacío', async () => {
    const prisma = makePrisma({ leads: [] });
    await expect(sendDailyCallList(prisma as never, TUESDAY_10_MADRID)).resolves.toEqual({ sent: false, reason: 'empty' });
    expect(mockState.send).not.toHaveBeenCalled();
  });

  it('si el envío falla, suelta el día para reintentarlo', async () => {
    mockState.send.mockResolvedValue({ ok: false, error: 'resend down' });
    const prisma = makePrisma();
    await expect(sendDailyCallList(prisma as never, TUESDAY_10_MADRID)).resolves.toEqual({ sent: false, reason: 'send_failed' });
    expect(prisma.operatorNotification.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
  });
});

describe('sweepClientHealth — un aviso al día, no uno cada 5 minutos', () => {
  function healthPrisma(existingClaim: boolean) {
    return {
      chatbotClient: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'c1',
            name: 'Cliente impagado',
            lastLoginAt: new Date(),
            clientProducts: [
              { status: 'active', product: { code: 'recall', tier: 'solo' }, subscription: { status: 'past_due' } },
            ],
          },
        ]),
      },
      callEvent: { count: vi.fn().mockResolvedValue(10) },
      googleReview: { count: vi.fn().mockResolvedValue(0) },
      lead: { count: vi.fn().mockResolvedValue(0) },
      operatorNotification: {
        findFirst: vi.fn().mockResolvedValue(existingClaim ? { id: 'n0' } : null),
        create: vi.fn().mockResolvedValue({ id: 'n1' }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
  }

  it('la primera pasada del día avisa; las siguientes no', async () => {
    const first = healthPrisma(false);
    const r1 = await sweepClientHealth(first as never, TUESDAY_10_MADRID);
    expect(r1.risks.length).toBeGreaterThan(0);
    expect(r1.notified).toBe(1);

    mockState.send.mockClear();
    const second = healthPrisma(true);
    const r2 = await sweepClientHealth(second as never, TUESDAY_10_MADRID);
    expect(r2.notified).toBe(0);
    expect(mockState.send).not.toHaveBeenCalled();
  });
});
