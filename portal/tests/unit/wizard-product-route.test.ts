// =============================================================================
// WP-16 — unit tests for GET/PATCH /api/portal/wizard/[product]/[step].
//
// Focused on the WP-16-specific gates that run BEFORE any wizard read/
// write: is `product` a real product code, and has the client actually
// contracted it. The underlying read/write behavior for a contracted
// chatbot step is already covered by wizard-client.test.ts and
// wizard-tier-prisma.test.ts (this route delegates to those unchanged),
// so this file only asserts the new gating short-circuits correctly and
// never reaches saveWizardStep/readWizardStep when it shouldn't.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveClientFromSession = vi.fn();
const findFirstClientProduct = vi.fn();
const findUniqueChatbotClient = vi.fn();
const readWizardStep = vi.fn();
const saveWizardStep = vi.fn();

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => resolveClientFromSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    clientProduct: {
      findFirst: (...args: unknown[]) => findFirstClientProduct(...args),
    },
    chatbotClient: {
      findUnique: (...args: unknown[]) => findUniqueChatbotClient(...args),
    },
    chatbotConfigStep: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    chatbotConfigStepAudit: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/wizard-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/wizard-client')>('@/lib/wizard-client');
  return {
    ...actual,
    readWizardStep: (...args: unknown[]) => readWizardStep(...args),
    saveWizardStep: (...args: unknown[]) => saveWizardStep(...args),
  };
});

import { GET, PATCH } from '@/app/api/portal/wizard/[product]/[step]/route';

const CLIENT_ID = 'client_1';

function makeGetRequest() {
  return {} as unknown as Parameters<typeof GET>[0];
}

function makePatchRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  resolveClientFromSession.mockReset();
  findFirstClientProduct.mockReset();
  findUniqueChatbotClient.mockReset();
  readWizardStep.mockReset();
  saveWizardStep.mockReset();
  resolveClientFromSession.mockResolvedValue({ clientId: CLIENT_ID, email: 'c@example.com' });
  findUniqueChatbotClient.mockResolvedValue({ tier: 'pro' });
});

describe('GET /api/portal/wizard/[product]/[step]', () => {
  it('returns 401 when there is no session', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(), { params: { product: 'chatbot', step: '1' } });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown product code', async () => {
    const res = await GET(makeGetRequest(), { params: { product: 'not-a-product', step: '1' } });
    expect(res.status).toBe(404);
    expect(findFirstClientProduct).not.toHaveBeenCalled();
  });

  it('returns 403 when the product is not contracted', async () => {
    findFirstClientProduct.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(), { params: { product: 'chatbot', step: '1' } });
    expect(res.status).toBe(403);
    expect(findFirstClientProduct).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID, status: 'active', product: { code: 'chatbot' } },
      select: { id: true },
    });
    expect(readWizardStep).not.toHaveBeenCalled();
  });

  it('returns 404 for a contracted product with no wizard content yet (empty catalog)', async () => {
    findFirstClientProduct.mockResolvedValueOnce({ id: 'cp1' });
    const res = await GET(makeGetRequest(), { params: { product: 'web', step: '1' } });
    expect(res.status).toBe(404);
    expect(readWizardStep).not.toHaveBeenCalled();
  });

  it('reads the step for a contracted chatbot product', async () => {
    findFirstClientProduct.mockResolvedValueOnce({ id: 'cp1' });
    readWizardStep.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(), { params: { product: 'chatbot', step: '1' } });
    expect(res.status).toBe(200);
    expect(readWizardStep).toHaveBeenCalledWith(expect.anything(), CLIENT_ID, 'chatbot', '1');
  });
});

describe('PATCH /api/portal/wizard/[product]/[step]', () => {
  it('returns 401 when there is no session', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await PATCH(makePatchRequest({ data: {}, status: 'draft' }), {
      params: { product: 'chatbot', step: '1' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown product code, before parsing the body', async () => {
    const res = await PATCH(makePatchRequest({ data: {}, status: 'draft' }), {
      params: { product: 'not-a-product', step: '1' },
    });
    expect(res.status).toBe(404);
    expect(saveWizardStep).not.toHaveBeenCalled();
  });

  it('WP-16 AC: returns 403 when PATCHing a product the client has not contracted', async () => {
    findFirstClientProduct.mockResolvedValueOnce(null);
    const res = await PATCH(makePatchRequest({ data: { foo: 'bar' }, status: 'draft' }), {
      params: { product: 'chatbot', step: '1' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(saveWizardStep).not.toHaveBeenCalled();
  });

  it('returns 404 for a contracted product with no wizard content yet (empty catalog)', async () => {
    findFirstClientProduct.mockResolvedValueOnce({ id: 'cp1' });
    const res = await PATCH(makePatchRequest({ data: {}, status: 'draft' }), {
      params: { product: 'leads', step: '1' },
    });
    expect(res.status).toBe(404);
    expect(saveWizardStep).not.toHaveBeenCalled();
  });

  it('saves the step for a contracted chatbot product', async () => {
    findFirstClientProduct.mockResolvedValueOnce({ id: 'cp1' });
    saveWizardStep.mockResolvedValueOnce({ stepId: 's1', version: 1, status: 'draft' });
    const res = await PATCH(
      makePatchRequest({ data: { servicios: [] }, status: 'draft' }),
      { params: { product: 'chatbot', step: '1' } },
    );
    expect(res.status).toBe(200);
    expect(saveWizardStep).toHaveBeenCalledWith(
      expect.anything(),
      { clientId: CLIENT_ID, email: 'c@example.com', productCode: 'chatbot' },
      { stepKey: '1', data: { servicios: [] }, status: 'draft' },
    );
  });
});
