// =============================================================================
// A4 — unit tests del informe de valor semanal.
//
// Lo que se fija:
//
// 1. Que NO se mande un correo cuando no hay nada que contar. "Esta semana,
//    nada" es la mejor forma de que alguien se plantee para qué paga.
// 2. Que el cursor avance igualmente en esa semana vacía: si no, a la
//    siguiente se contaría el doble de tiempo y el correo mentiría.
// 3. Que no aparezcan euros inventados. El plan habla de "Z € recuperados" y
//    la tentación es multiplicar por un ticket medio que nadie nos ha dado —
//    el mismo error de los 300 € por corte de pelo.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findClients: vi.fn(),
  updateClient: vi.fn(),
  countCalls: vi.fn(),
  countReviews: vi.fn(),
  countLeads: vi.fn(),
  countConversations: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/email-sender', () => ({ notifyFromAddress: () => 'Kairikos <ops@kairikos.test>' }));

import { buildValueEmail, hasSomethingToTell, sweepValueReports } from '@/lib/client-value-report';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  chatbotClient: {
    findMany: (...a: unknown[]) => mockState.findClients(...a),
    update: (...a: unknown[]) => mockState.updateClient(...a),
  },
  callEvent: { count: (...a: unknown[]) => mockState.countCalls(...a) },
  googleReview: { count: (...a: unknown[]) => mockState.countReviews(...a) },
  lead: { count: (...a: unknown[]) => mockState.countLeads(...a) },
  chatbotConversation: { count: (...a: unknown[]) => mockState.countConversations(...a) },
} as unknown as PrismaClient;

beforeEach(() => {
  mockState.findClients.mockReset().mockResolvedValue([
    { id: 'c1', name: 'Fontanería Ejemplo', email: 'duenyo@negocio.es', lastValueReportAt: null },
  ]);
  mockState.updateClient.mockReset().mockResolvedValue({});
  mockState.countCalls.mockReset().mockResolvedValue(0);
  mockState.countReviews.mockReset().mockResolvedValue(0);
  mockState.countLeads.mockReset().mockResolvedValue(0);
  mockState.countConversations.mockReset().mockResolvedValue(0);
  mockState.logError.mockReset();
  delete process.env.RESEND_API_KEY;
});

describe('hasSomethingToTell', () => {
  it('una semana sin nada no se cuenta', () => {
    expect(
      hasSomethingToTell({ llamadasRecuperadas: 0, resenasNuevas: 0, leadsNuevos: 0, conversaciones: 0 }),
    ).toBe(false);
  });

  it('con una sola cosa ya hay correo', () => {
    expect(
      hasSomethingToTell({ llamadasRecuperadas: 1, resenasNuevas: 0, leadsNuevos: 0, conversaciones: 0 }),
    ).toBe(true);
  });
});

describe('buildValueEmail', () => {
  it('el asunto lleva la cifra, que es lo que se recuerda', () => {
    const { subject } = buildValueEmail('Fontanería Ejemplo', {
      llamadasRecuperadas: 11,
      resenasNuevas: 2,
      leadsNuevos: 0,
      conversaciones: 0,
    });
    expect(subject).toContain('11 llamadas recuperadas');
  });

  it('singular y plural, que "1 llamadas" delata que lo escribió una máquina', () => {
    const uno = buildValueEmail('X', {
      llamadasRecuperadas: 1,
      resenasNuevas: 1,
      leadsNuevos: 1,
      conversaciones: 1,
    });
    expect(uno.text).toContain('1 llamada recuperada');
    expect(uno.text).toContain('1 reseña nueva');
    expect(uno.text).toContain('1 contacto nuevo');
    expect(uno.text).toContain('1 conversación atendida');
  });

  it('no aparecen euros inventados por ninguna parte', () => {
    const email = buildValueEmail('X', {
      llamadasRecuperadas: 11,
      resenasNuevas: 3,
      leadsNuevos: 5,
      conversaciones: 9,
    });
    expect(email.text).not.toMatch(/€|euros/);
    expect(email.html).not.toMatch(/€|euros/);
  });

  it('solo se mencionan las cosas que pasaron', () => {
    const email = buildValueEmail('X', {
      llamadasRecuperadas: 4,
      resenasNuevas: 0,
      leadsNuevos: 0,
      conversaciones: 0,
    });
    expect(email.text).not.toContain('reseña');
    expect(email.text).not.toContain('conversaci');
  });

  it('escapa el nombre del negocio en el HTML', () => {
    const email = buildValueEmail('Bar <script>', {
      llamadasRecuperadas: 1,
      resenasNuevas: 0,
      leadsNuevos: 0,
      conversaciones: 0,
    });
    expect(email.html).toContain('&lt;script&gt;');
  });
});

describe('sweepValueReports', () => {
  it('una semana vacía no manda correo pero SÍ avanza el cursor', async () => {
    const result = await sweepValueReports(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(result.sent).toBe(0);
    expect(result.skippedNothingToTell).toBe(1);
    expect(mockState.updateClient).toHaveBeenCalled();
  });

  it('sin clave de Resend no se pierde el cursor: el cliente no recibe dos veces lo mismo', async () => {
    mockState.countCalls.mockResolvedValue(7);
    const result = await sweepValueReports(prisma, new Date('2026-09-24T10:00:00Z'));
    expect(result.failed).toBe(1);
    expect(mockState.updateClient).toHaveBeenCalled();
  });

  it('la ventana arranca en el último informe, no siempre siete días atrás', async () => {
    mockState.findClients.mockResolvedValue([
      {
        id: 'c1',
        name: 'X',
        email: 'x@x.es',
        lastValueReportAt: new Date('2026-09-01T10:00:00Z'),
      },
    ]);
    await sweepValueReports(prisma, new Date('2026-09-24T10:00:00Z'));
    const where = mockState.countCalls.mock.calls[0][0].where;
    expect(where.startedAt.gte).toEqual(new Date('2026-09-01T10:00:00Z'));
  });
});
