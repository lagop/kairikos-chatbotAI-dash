// =============================================================================
// WP-XX — Leads Fase 2: status-transition predicates in src/lib/leads.ts.
// Boundary coverage for each canX(status) function — mirrors how
// web-quotes.ts's equivalent predicates would be tested if a test file
// existed for them (none does today; this is the first of its kind).
// =============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ isProductContracted: vi.fn() }));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...a: unknown[]) => mockState.isProductContracted(...a),
}));

import {
  canDiscard,
  canMarkContacted,
  canMarkConverted,
  stuckThresholdDays,
  isStuck,
  listLeadsQueue,
  parseLeadStatusFilter,
  parseLeadSort,
  hasLeadsInboxAccess,
} from '@/lib/leads';

describe('canMarkContacted (nuevo -> contactado)', () => {
  it('allows from nuevo', () => {
    expect(canMarkContacted('nuevo')).toBe(true);
  });

  it('denies from every other status', () => {
    expect(canMarkContacted('contactado')).toBe(false);
    expect(canMarkContacted('convertido')).toBe(false);
    expect(canMarkContacted('descartado')).toBe(false);
    expect(canMarkContacted('')).toBe(false);
    expect(canMarkContacted('unknown')).toBe(false);
  });
});

describe('canMarkConverted (contactado -> convertido)', () => {
  it('allows from contactado', () => {
    expect(canMarkConverted('contactado')).toBe(true);
  });

  it('denies from every other status, including nuevo (cannot skip contactado)', () => {
    expect(canMarkConverted('nuevo')).toBe(false);
    expect(canMarkConverted('convertido')).toBe(false);
    expect(canMarkConverted('descartado')).toBe(false);
    expect(canMarkConverted('')).toBe(false);
    expect(canMarkConverted('unknown')).toBe(false);
  });
});

describe('canDiscard (side-exit: nuevo|contactado -> descartado)', () => {
  it('allows from nuevo', () => {
    expect(canDiscard('nuevo')).toBe(true);
  });

  it('allows from contactado', () => {
    expect(canDiscard('contactado')).toBe(true);
  });

  it('denies from terminal statuses (convertido, descartado) and unknown values', () => {
    expect(canDiscard('convertido')).toBe(false);
    expect(canDiscard('descartado')).toBe(false);
    expect(canDiscard('')).toBe(false);
    expect(canDiscard('unknown')).toBe(false);
  });
});

describe('stuck detection', () => {
  const NOW = new Date('2026-09-10T12:00:00.000Z');
  function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  }

  it('has no threshold for the terminal statuses', () => {
    expect(stuckThresholdDays('convertido')).toBeNull();
    expect(stuckThresholdDays('descartado')).toBeNull();
  });

  it('chases an uncontacted lead harder than one already being worked', () => {
    expect(stuckThresholdDays('nuevo')).toBe(2);
    expect(stuckThresholdDays('contactado')).toBe(14);
    expect(stuckThresholdDays('contactado')!).toBeGreaterThan(stuckThresholdDays('nuevo')!);
  });

  it('is not stuck before the threshold and is stuck at or after it', () => {
    expect(isStuck('nuevo', daysAgo(1), NOW)).toBe(false);
    expect(isStuck('nuevo', daysAgo(2), NOW)).toBe(true);
    expect(isStuck('nuevo', daysAgo(9), NOW)).toBe(true);

    expect(isStuck('contactado', daysAgo(13), NOW)).toBe(false);
    expect(isStuck('contactado', daysAgo(14), NOW)).toBe(true);
  });

  it('never reports a terminal status as stuck, however long it has sat there', () => {
    expect(isStuck('convertido', daysAgo(400), NOW)).toBe(false);
    expect(isStuck('descartado', daysAgo(400), NOW)).toBe(false);
  });

  it('never reports an unknown status as stuck', () => {
    expect(isStuck('nonsense', daysAgo(400), NOW)).toBe(false);
  });
});

describe('listLeadsQueue', () => {
  const findMany = vi.fn();
  const prisma = { lead: { findMany: (...a: unknown[]) => findMany(...a) } } as unknown as PrismaClient;

  beforeEach(() => {
    findMany.mockReset();
  });

  it('queries only the open statuses — never terminal leads', async () => {
    findMany.mockResolvedValue([]);
    await listLeadsQueue(prisma);
    expect(findMany.mock.calls[0][0].where).toEqual({ status: { in: ['nuevo', 'contactado'] } });
  });

  it('clocks a nuevo lead from createdAt and a contactado one from contactedAt, not updatedAt', async () => {
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    const contactedAt = new Date('2026-09-05T00:00:00.000Z');
    findMany.mockResolvedValue([
      {
        id: 'lead_1',
        clientId: 'client_1',
        status: 'nuevo',
        createdAt,
        contactedAt: null,
        contactName: 'Ana',
        contactPhone: null,
        contactEmail: null,
        score: 80,
        channel: 'whatsapp',
        client: { name: 'Ana Owner', companyName: null, email: 'ana@example.com' },
      },
      {
        id: 'lead_2',
        clientId: 'client_2',
        status: 'contactado',
        createdAt,
        contactedAt,
        contactName: 'Bea',
        contactPhone: null,
        contactEmail: null,
        score: null,
        channel: 'phone',
        client: { name: 'Bea Owner', companyName: 'Bea SL', email: 'bea@example.com' },
      },
    ]);

    const rows = await listLeadsQueue(prisma);

    expect(rows).toEqual([
      {
        leadId: 'lead_1',
        clientId: 'client_1',
        clientName: 'Ana Owner',
        clientEmail: 'ana@example.com',
        status: 'nuevo',
        since: createdAt,
        contactName: 'Ana',
        contactPhone: null,
        contactEmail: null,
        score: 80,
        channel: 'whatsapp',
      },
      {
        leadId: 'lead_2',
        clientId: 'client_2',
        clientName: 'Bea SL',
        clientEmail: 'bea@example.com',
        status: 'contactado',
        since: contactedAt,
        contactName: 'Bea',
        contactPhone: null,
        contactEmail: null,
        score: null,
        channel: 'phone',
      },
    ]);
  });

  it('falls back to createdAt for a contactado row missing its own timestamp (pre-migration data)', async () => {
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    findMany.mockResolvedValue([
      {
        id: 'lead_1',
        clientId: 'client_1',
        status: 'contactado',
        createdAt,
        contactedAt: null,
        contactName: null,
        contactPhone: null,
        contactEmail: null,
        score: null,
        channel: null,
        client: { name: 'Ana Owner', companyName: null, email: 'ana@example.com' },
      },
    ]);

    const rows = await listLeadsQueue(prisma);
    expect(rows[0].since).toEqual(createdAt);
  });
});

describe('parseLeadStatusFilter', () => {
  it('accepts each known status', () => {
    expect(parseLeadStatusFilter('nuevo')).toBe('nuevo');
    expect(parseLeadStatusFilter('contactado')).toBe('contactado');
    expect(parseLeadStatusFilter('convertido')).toBe('convertido');
    expect(parseLeadStatusFilter('descartado')).toBe('descartado');
  });

  it('falls back to null ("todos") for undefined, empty, or hostile input — never crashes', () => {
    expect(parseLeadStatusFilter(undefined)).toBeNull();
    expect(parseLeadStatusFilter('')).toBeNull();
    expect(parseLeadStatusFilter('DROP TABLE leads;')).toBeNull();
    expect(parseLeadStatusFilter('Nuevo')).toBeNull(); // case-sensitive, not a fuzzy match
  });

  it('takes the first value when the query string repeats the param', () => {
    expect(parseLeadStatusFilter(['contactado', 'convertido'])).toBe('contactado');
  });
});

describe('parseLeadSort', () => {
  it('accepts "prioridad"', () => {
    expect(parseLeadSort('prioridad')).toBe('prioridad');
  });

  it('defaults to "recientes" for undefined, empty, or hostile input', () => {
    expect(parseLeadSort(undefined)).toBe('recientes');
    expect(parseLeadSort('')).toBe('recientes');
    expect(parseLeadSort('nonsense')).toBe('recientes');
  });
});

describe('hasLeadsInboxAccess', () => {
  const prisma = {} as PrismaClient;

  beforeEach(() => {
    mockState.isProductContracted.mockReset();
  });

  it('true when only "leads" is contracted', async () => {
    mockState.isProductContracted.mockImplementation((_p, _c, code: string) =>
      Promise.resolve(code === 'leads'),
    );
    await expect(hasLeadsInboxAccess(prisma, 'client_1')).resolves.toBe(true);
  });

  it('true when only "prospecting" is contracted — the gap caught during planning', async () => {
    mockState.isProductContracted.mockImplementation((_p, _c, code: string) =>
      Promise.resolve(code === 'prospecting'),
    );
    await expect(hasLeadsInboxAccess(prisma, 'client_1')).resolves.toBe(true);
  });

  it('true when both are contracted', async () => {
    mockState.isProductContracted.mockResolvedValue(true);
    await expect(hasLeadsInboxAccess(prisma, 'client_1')).resolves.toBe(true);
  });

  it('false when neither is contracted', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    await expect(hasLeadsInboxAccess(prisma, 'client_1')).resolves.toBe(false);
  });

  it('checks both products, not just the first', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    await hasLeadsInboxAccess(prisma, 'client_1');
    const checkedCodes = mockState.isProductContracted.mock.calls.map((call) => call[2]);
    expect(checkedCodes.sort()).toEqual(['leads', 'prospecting']);
  });
});
