// =============================================================================
// Fase 2.4 — unit tests para src/lib/lead-stale-alerts.ts.
//
// Lo importante: que los umbrales sean LOS MISMOS que ya usaba la cola del
// operador (no una segunda definición que pueda divergir), que un cliente
// reciba un correo con su lista y no cinco correos sueltos, y que un fallo
// de envío no selle el aviso.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  sendStaleLeadEmail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/leads-email', () => ({
  sendStaleLeadEmail: (...a: unknown[]) => mockState.sendStaleLeadEmail(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { sweepStaleLeadAlerts, describeLead } from '@/lib/lead-stale-alerts';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

const prismaState = {
  leadFindMany: vi.fn(),
  leadUpdateMany: vi.fn(),
  clientFindUnique: vi.fn(),
  profileFindUnique: vi.fn(),
};

const prismaMock = {
  lead: {
    findMany: (...a: unknown[]) => prismaState.leadFindMany(...a),
    updateMany: (...a: unknown[]) => prismaState.leadUpdateMany(...a),
  },
  chatbotClient: { findUnique: (...a: unknown[]) => prismaState.clientFindUnique(...a) },
  leadQualificationProfile: { findUnique: (...a: unknown[]) => prismaState.profileFindUnique(...a) },
} as unknown as Parameters<typeof sweepStaleLeadAlerts>[0];

function lead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead_1',
    clientId: 'c1',
    status: 'nuevo',
    createdAt: daysAgo(5),
    contactedAt: null,
    contactName: 'Marta',
    contactPhone: null,
    contactEmail: null,
    score: 80,
    ...over,
  };
}

beforeEach(() => {
  prismaState.leadFindMany.mockReset().mockResolvedValue([]);
  prismaState.leadUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  prismaState.clientFindUnique.mockReset().mockResolvedValue({
    email: 'aurora@example.com', name: 'Aurora', companyName: 'Peluquería Aurora',
  });
  prismaState.profileFindUnique.mockReset().mockResolvedValue(null);
  mockState.sendStaleLeadEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.logError.mockReset();
});

describe('describeLead', () => {
  it('usa el primer dato de contacto que haya', () => {
    expect(describeLead(lead() as never)).toBe('Marta (prioridad 80)');
    expect(describeLead(lead({ contactName: null, contactPhone: '+34600' }) as never)).toBe('+34600 (prioridad 80)');
  });

  it('no miente cuando no hay ningún dato', () => {
    expect(describeLead(lead({ contactName: null, score: null }) as never)).toBe('Sin datos de contacto');
  });
});

describe('sweepStaleLeadAlerts — a quién avisa', () => {
  it('solo mira leads abiertos, sin aviso previo, de clientes con leads contratado', async () => {
    await sweepStaleLeadAlerts(prismaMock, NOW);
    expect(prismaState.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['nuevo', 'contactado'] },
          staleAlertSentAt: null,
        }),
      }),
    );
  });

  it('respeta los umbrales que ya usaba la cola del operador', async () => {
    // 'nuevo' se considera frío a los 2 días; 1 día todavía no.
    prismaState.leadFindMany.mockResolvedValue([lead({ createdAt: daysAgo(1) })]);
    expect(await sweepStaleLeadAlerts(prismaMock, NOW)).toEqual({ stale: 0, clientsAlerted: 0 });
    expect(mockState.sendStaleLeadEmail).not.toHaveBeenCalled();
  });

  it('un contactado aguanta más que un nuevo antes de considerarse frío', async () => {
    // 14 días es el umbral de 'contactado': a los 5 no toca aún.
    prismaState.leadFindMany.mockResolvedValue([
      lead({ status: 'contactado', contactedAt: daysAgo(5), createdAt: daysAgo(40) }),
    ]);
    expect(await sweepStaleLeadAlerts(prismaMock, NOW)).toMatchObject({ stale: 0 });

    prismaState.leadFindMany.mockResolvedValue([
      lead({ status: 'contactado', contactedAt: daysAgo(20), createdAt: daysAgo(40) }),
    ]);
    expect(await sweepStaleLeadAlerts(prismaMock, NOW)).toMatchObject({ stale: 1, clientsAlerted: 1 });
  });
});

describe('sweepStaleLeadAlerts — cómo avisa', () => {
  it('manda UN correo por cliente con todos sus leads, no uno por lead', async () => {
    prismaState.leadFindMany.mockResolvedValue([
      lead({ id: 'l1', contactName: 'Marta' }),
      lead({ id: 'l2', contactName: 'Jorge' }),
      lead({ id: 'l3', clientId: 'c2', contactName: 'Ana' }),
    ]);

    const result = await sweepStaleLeadAlerts(prismaMock, NOW);

    expect(result).toEqual({ stale: 3, clientsAlerted: 2 });
    expect(mockState.sendStaleLeadEmail).toHaveBeenCalledTimes(2);
    const primerCorreo = mockState.sendStaleLeadEmail.mock.calls[0][0];
    expect(primerCorreo.leads).toHaveLength(2);
    expect(primerCorreo.leads[0]).toMatchObject({ status: 'nuevo', days: 5, thresholdDays: 2 });
  });

  it('prefiere el email de aviso configurado sobre el de la cuenta', async () => {
    prismaState.leadFindMany.mockResolvedValue([lead()]);
    prismaState.profileFindUnique.mockResolvedValue({ emailAviso: 'ventas@aurora.example' });

    await sweepStaleLeadAlerts(prismaMock, NOW);

    expect(mockState.sendStaleLeadEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ventas@aurora.example' }),
    );
  });

  it('sella el aviso de todos los leads incluidos en el correo', async () => {
    prismaState.leadFindMany.mockResolvedValue([lead({ id: 'l1' }), lead({ id: 'l2' })]);
    await sweepStaleLeadAlerts(prismaMock, NOW);
    expect(prismaState.leadUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1', 'l2'] } },
      data: { staleAlertSentAt: NOW },
    });
  });

  it('si el envío falla NO sella nada: se reintenta en el siguiente barrido', async () => {
    prismaState.leadFindMany.mockResolvedValue([lead()]);
    mockState.sendStaleLeadEmail.mockResolvedValue({ ok: false, error: 'resend caído' });

    const result = await sweepStaleLeadAlerts(prismaMock, NOW);

    expect(result).toEqual({ stale: 1, clientsAlerted: 0 });
    expect(prismaState.leadUpdateMany).not.toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('un cliente sin destinatario se salta sin romper a los demás', async () => {
    prismaState.leadFindMany.mockResolvedValue([lead({ clientId: 'c1' }), lead({ id: 'l2', clientId: 'c2' })]);
    prismaState.clientFindUnique
      .mockResolvedValueOnce({ email: '', name: 'X', companyName: null })
      .mockResolvedValueOnce({ email: 'ok@example.com', name: 'Y', companyName: null });

    const result = await sweepStaleLeadAlerts(prismaMock, NOW);

    expect(result.clientsAlerted).toBe(1);
  });
});
