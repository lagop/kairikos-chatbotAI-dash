// =============================================================================
// WP-11 — unit tests for src/lib/support-requests.ts
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSupportRequest,
  listSupportRequests,
  setSupportRequestStatus,
} from '@/lib/support-requests';

function makePrisma() {
  return {
    supportRequest: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe('createSupportRequest', () => {
  it('creates a row scoped to the client and tenant', async () => {
    const prisma = makePrisma();
    prisma.supportRequest.create.mockResolvedValue({ id: 'sr_1', createdAt: new Date('2026-08-13T10:00:00Z') });

    const result = await createSupportRequest(prisma as never, {
      clientId: 'client-1',
      tenantId: 'tenant-1',
      subject: 'No encuentro el logo',
      message: 'No sé dónde subir el logo del negocio.',
    });

    expect(result.id).toBe('sr_1');
    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        tenantId: 'tenant-1',
        subject: 'No encuentro el logo',
        message: 'No sé dónde subir el logo del negocio.',
      },
      select: { id: true, createdAt: true },
    });
  });

  it('defaults tenantId to null when omitted', async () => {
    const prisma = makePrisma();
    prisma.supportRequest.create.mockResolvedValue({ id: 'sr_2', createdAt: new Date() });

    await createSupportRequest(prisma as never, {
      clientId: 'client-1',
      subject: 'Duda',
      message: 'Mensaje de al menos diez caracteres.',
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: null }) }),
    );
  });
});

describe('listSupportRequests', () => {
  it('maps rows and prefers companyName over name for the client display', async () => {
    const prisma = makePrisma();
    prisma.supportRequest.findMany.mockResolvedValue([
      {
        id: 'sr_1',
        clientId: 'client-1',
        subject: 'Asunto',
        message: 'Mensaje',
        status: 'open',
        resolvedByOperatorId: null,
        resolvedAt: null,
        createdAt: new Date('2026-08-13T10:00:00Z'),
        client: { name: 'Orly', companyName: 'Orly Dental S.L.', email: 'orly@example.com' },
      },
    ]);

    const rows = await listSupportRequests(prisma as never);

    expect(rows).toEqual([
      {
        id: 'sr_1',
        clientId: 'client-1',
        clientName: 'Orly Dental S.L.',
        clientEmail: 'orly@example.com',
        subject: 'Asunto',
        message: 'Mensaje',
        status: 'open',
        resolvedByOperatorId: null,
        resolvedAt: null,
        createdAt: '2026-08-13T10:00:00.000Z',
      },
    ]);
  });

  it('falls back to name when companyName is null', async () => {
    const prisma = makePrisma();
    prisma.supportRequest.findMany.mockResolvedValue([
      {
        id: 'sr_1',
        clientId: 'client-1',
        subject: 'Asunto',
        message: 'Mensaje',
        status: 'resolved',
        resolvedByOperatorId: 'ops@kairikos.com',
        resolvedAt: new Date('2026-08-13T12:00:00Z'),
        createdAt: new Date('2026-08-13T10:00:00Z'),
        client: { name: 'Orly', companyName: null, email: 'orly@example.com' },
      },
    ]);

    const rows = await listSupportRequests(prisma as never, { status: 'resolved' });

    expect(rows[0].clientName).toBe('Orly');
    expect(rows[0].status).toBe('resolved');
    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'resolved' } }),
    );
  });

  it('passes an empty where clause when no status filter is given', async () => {
    const prisma = makePrisma();
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await listSupportRequests(prisma as never);

    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe('setSupportRequestStatus', () => {
  const prisma = makePrisma();

  beforeEach(() => {
    prisma.supportRequest.findUnique.mockReset();
    prisma.supportRequest.update.mockReset();
  });

  it('returns not_found when the id does not exist', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue(null);

    const result = await setSupportRequestStatus(prisma as never, 'missing', 'resolved', 'ops@kairikos.com');

    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(prisma.supportRequest.update).not.toHaveBeenCalled();
  });

  it('resolving stamps resolvedByOperatorId and resolvedAt', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({ id: 'sr_1' });
    prisma.supportRequest.update.mockResolvedValue({});

    const result = await setSupportRequestStatus(prisma as never, 'sr_1', 'resolved', 'ops@kairikos.com');

    expect(result).toEqual({ ok: true, status: 'resolved' });
    expect(prisma.supportRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr_1' },
      data: {
        status: 'resolved',
        resolvedByOperatorId: 'ops@kairikos.com',
        resolvedAt: expect.any(Date),
      },
    });
  });

  it('reopening clears resolvedByOperatorId and resolvedAt', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({ id: 'sr_1' });
    prisma.supportRequest.update.mockResolvedValue({});

    const result = await setSupportRequestStatus(prisma as never, 'sr_1', 'open', 'ops@kairikos.com');

    expect(result).toEqual({ ok: true, status: 'open' });
    expect(prisma.supportRequest.update).toHaveBeenCalledWith({
      where: { id: 'sr_1' },
      data: { status: 'open', resolvedByOperatorId: null, resolvedAt: null },
    });
  });
});
