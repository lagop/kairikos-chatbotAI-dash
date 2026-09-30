// =============================================================================
// Revisión de seguridad del 30/09/2026 — lo que no tenía ya su propio archivo
// de tests:
//   - una suscripción terminada en Stripe apaga el producto;
//   - el cifrado del webhook de leads;
//   - revocar las sesiones de un cliente;
//   - la redirección abierta de la vista de operador;
//   - el cierre de sesión ya no acepta GET.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  cpFindUnique: vi.fn(),
  cpUpdate: vi.fn(),
  auditCreate: vi.fn(),
  subUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    clientProduct: {
      findUnique: (...a: unknown[]) => mockState.cpFindUnique(...a),
      update: (...a: unknown[]) => mockState.cpUpdate(...a),
    },
    clientProductAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
  };
  return {
    isDatabaseConfigured: true,
    prisma: {
      ...tx,
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      subscription: { update: (...a: unknown[]) => mockState.subUpdate(...a) },
    },
  };
});

import {
  retireClientProductForEndedSubscription,
  deleteSubscriptionFromStripe,
  SUBSCRIPTION_ENDED_STATUSES,
} from '@/lib/stripe-billing';
import { encryptLeadWebhook, decryptLeadWebhook, isLeadWebhookCryptoConfigured } from '@/lib/lead-webhook-crypto';
import { revokeClientSessions } from '@/lib/client-sessions';

beforeEach(() => {
  mockState.cpFindUnique.mockReset().mockResolvedValue({
    id: 'cp1',
    clientId: 'c1',
    productId: 'p1',
    tenantId: 't1',
    status: 'active',
  });
  mockState.cpUpdate.mockReset().mockResolvedValue({});
  mockState.auditCreate.mockReset().mockResolvedValue({});
  mockState.subUpdate.mockReset().mockResolvedValue({ clientProductId: 'cp1' });
  mockState.userUpdateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('una suscripción terminada en Stripe apaga el producto', () => {
  it('cancela el producto y deja auditoría con system:stripe', async () => {
    expect(await retireClientProductForEndedSubscription('cp1')).toBe(true);
    expect(mockState.cpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp1' }, data: expect.objectContaining({ status: 'cancelled' }) }),
    );
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'retire',
        statusBefore: 'active',
        statusAfter: 'cancelled',
        actorId: 'system:stripe',
      }),
    });
  });

  it('idempotente: un producto ya cancelado no se toca ni se audita otra vez', async () => {
    mockState.cpFindUnique.mockResolvedValue({ id: 'cp1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'cancelled' });
    expect(await retireClientProductForEndedSubscription('cp1')).toBe(false);
    expect(mockState.cpUpdate).not.toHaveBeenCalled();
    expect(mockState.auditCreate).not.toHaveBeenCalled();
  });

  it('customer.subscription.deleted apaga el producto enlazado a la suscripción', async () => {
    await deleteSubscriptionFromStripe('sub_1');
    expect(mockState.subUpdate).toHaveBeenCalled();
    expect(mockState.cpUpdate).toHaveBeenCalled();
  });

  it('si la fila Subscription no existe, usa el metadato del alta', async () => {
    mockState.subUpdate.mockRejectedValue(new Error('not found'));
    await deleteSubscriptionFromStripe('sub_1', 'cp1');
    expect(mockState.cpFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cp1' } }));
    expect(mockState.cpUpdate).toHaveBeenCalled();
  });

  it('past_due NO apaga: Stripe sigue reintentando el cobro', () => {
    expect(SUBSCRIPTION_ENDED_STATUSES.has('past_due')).toBe(false);
    expect(SUBSCRIPTION_ENDED_STATUSES.has('canceled')).toBe(true);
    expect(SUBSCRIPTION_ENDED_STATUSES.has('unpaid')).toBe(true);
  });
});

describe('el cifrado del webhook de leads', () => {
  const original = process.env.LEAD_WEBHOOK_ENCRYPTION_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.LEAD_WEBHOOK_ENCRYPTION_KEY;
    else process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = original;
  });

  it('ida y vuelta: lo guardado no lleva la URL ni el secreto en claro', () => {
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = 'a'.repeat(64);
    const cols = encryptLeadWebhook('https://hooks.zapier.com/abc/TOKEN', 'whsec_x');
    expect(Buffer.from(cols.urlCiphertext).toString('utf8')).not.toContain('TOKEN');
    expect(decryptLeadWebhook(cols)).toEqual({ url: 'https://hooks.zapier.com/abc/TOKEN', secret: 'whsec_x' });
  });

  it('sin clave, o vacía: no configurado, y descifrar devuelve null sin lanzar', () => {
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = 'a'.repeat(64);
    const cols = encryptLeadWebhook('https://x.example/h', 's');
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = '';
    expect(isLeadWebhookCryptoConfigured()).toBe(false);
    expect(decryptLeadWebhook(cols)).toBeNull();
  });

  it('con otra clave no se descifra (y no lanza)', () => {
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = 'a'.repeat(64);
    const cols = encryptLeadWebhook('https://x.example/h', 's');
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(decryptLeadWebhook(cols)).toBeNull();
  });

  it('una fila de antes del cifrado (columnas nulas) da null', () => {
    process.env.LEAD_WEBHOOK_ENCRYPTION_KEY = 'a'.repeat(64);
    expect(
      decryptLeadWebhook({
        urlCiphertext: null,
        urlIv: null,
        urlTag: null,
        secretCiphertext: null,
        secretIv: null,
        secretTag: null,
      }),
    ).toBeNull();
  });
});

describe('revocar las sesiones de un cliente', () => {
  it('sube la versión de sesión de ese usuario cliente', async () => {
    const prisma = { user: { updateMany: mockState.userUpdateMany } } as unknown as PrismaClient;
    await revokeClientSessions(prisma, '  Ana@Ejemplo.ES ');
    expect(mockState.userUpdateMany).toHaveBeenCalledWith({
      where: { email: 'ana@ejemplo.es', role: 'client' },
      data: { sessionVersion: { increment: 1 } },
    });
  });
});

describe('rutas de salir y de vista de operador', () => {
  it('el cierre de sesión del portal y del panel ya no aceptan GET', async () => {
    const portal = await import('@/app/api/portal/logout/route');
    const admin = await import('@/app/admin/logout/route');
    expect('GET' in portal).toBe(false);
    expect('GET' in admin).toBe(false);
  });

  it('la vista de operador no redirige fuera con un return_to absoluto', async () => {
    const { POST } = await import('@/app/api/portal/operator/route');
    const form = new FormData();
    form.set('mode', 'disable');
    form.set('return_to', 'https://sitio-malicioso.example/robar');
    const req = new Request('https://portal.kairikos.cloud/api/portal/operator', { method: 'POST', body: form });
    const res = await POST(req as never);
    expect(res.headers.get('location')).toBe('https://portal.kairikos.cloud/admin/portal/clients');
  });
});
