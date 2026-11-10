// =============================================================================
// 10/11/2026 — POST /api/admin/portal/web/[clientProductId]/custom-care.
//
// Ofrecer «solo mantenimiento» avisa al cliente por correo. Lo que no puede
// pasar: que el correo vaya a otro cliente que el dueño de la web, o que un
// correo fallido deje al operador creyendo que el cliente está avisado.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const WEB_ID = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findWeb: vi.fn(),
  findClient: vi.fn(),
  createCustomCareOffer: vi.fn(),
  findCustomCareOffer: vi.fn(),
  sendCustomCareOfferEmail: vi.fn(),
  assignSiteToNewContract: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    clientProduct: { findFirst: (...a: unknown[]) => state.findWeb(...a) },
    chatbotClient: { findUnique: (...a: unknown[]) => state.findClient(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => state.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/client-site', () => ({
  assignSiteToNewContract: (...a: unknown[]) => state.assignSiteToNewContract(...a),
}));
vi.mock('@/lib/custom-care', () => ({
  createCustomCareOffer: (...a: unknown[]) => state.createCustomCareOffer(...a),
  findCustomCareOffer: (...a: unknown[]) => state.findCustomCareOffer(...a),
  withdrawCustomCareOffer: vi.fn(),
}));
vi.mock('@/lib/web-quote-email', () => ({
  sendCustomCareOfferEmail: (...a: unknown[]) => state.sendCustomCareOfferEmail(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => state.logError(...a) }));

import { POST } from '@/app/api/admin/portal/web/[clientProductId]/custom-care/route';

function post(body: unknown) {
  return POST({ json: async () => body } as unknown as NextRequest, { params: Promise.resolve({ clientProductId: WEB_ID }) });
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  state.findWeb.mockResolvedValue({ id: WEB_ID, clientId: 'c1', tenantId: 't1', clientSiteId: 'site_1' });
  state.findClient.mockResolvedValue({ email: 'aurora@example.com', companyName: 'Peluquería Aurora', name: 'Aurora' });
  state.createCustomCareOffer.mockResolvedValue({ ok: true, clientProductId: 'cp_offer' });
  state.findCustomCareOffer.mockResolvedValue({ clientProductId: 'cp_offer', priceCents: 4900, trialMonths: 3, currency: 'EUR' });
  state.sendCustomCareOfferEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
});

describe('POST custom-care — el correo al cliente', () => {
  it('avisa al dueño de la web, con el precio guardado y el enlace a esa web', async () => {
    const res = await post({ priceCents: 4900, trialMonths: 3 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, offerClientProductId: 'cp_offer', email: 'sent', emailTo: 'aurora@example.com' });
    expect(state.findClient).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' } }));
    expect(state.findCustomCareOffer).toHaveBeenCalledWith(expect.anything(), 'c1', 'site_1');
    expect(state.sendCustomCareOfferEmail).toHaveBeenCalledWith({
      to: 'aurora@example.com',
      businessName: 'Peluquería Aurora',
      priceCents: 4900,
      currency: 'EUR',
      trialMonths: 3,
      webClientProductId: WEB_ID,
    });
  });

  it('si el correo falla, la oferta queda creada y la respuesta lo dice', async () => {
    state.sendCustomCareOfferEmail.mockResolvedValue({ ok: false, error: 'The domain is invalid' });
    const res = await post({ priceCents: 4900, trialMonths: 3 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, email: 'failed' });
    expect(state.logError).toHaveBeenCalledWith('custom_care_offer_email.failed', expect.any(Error), expect.anything(), 'warn');
  });

  it('sin clave de Resend, skipped (no «sent»)', async () => {
    state.sendCustomCareOfferEmail.mockResolvedValue({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
    expect(await (await post({ priceCents: 4900, trialMonths: 3 })).json()).toMatchObject({ email: 'skipped' });
  });

  it('si la oferta no se crea, no se manda nada', async () => {
    state.createCustomCareOffer.mockResolvedValue({ ok: false, error: 'already_contracted' });
    const res = await post({ priceCents: 4900, trialMonths: 3 });
    expect(res.status).toBe(409);
    expect(state.sendCustomCareOfferEmail).not.toHaveBeenCalled();
  });
});
