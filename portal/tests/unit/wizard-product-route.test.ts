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
const getSession = vi.fn();
const findFirstClientProduct = vi.fn();
const findUniqueChatbotClient = vi.fn();
const readWizardStep = vi.fn();
const saveWizardStep = vi.fn();

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    clientProduct: {
      findFirst: (...args: unknown[]) => findFirstClientProduct(...args),
      // Fase 4 multi-instancia — la ruta resuelve de qué chatbot es el
      // asistente (resolveContractedInstance), que pide hasta dos filas para
      // detectar ambigüedad. Atado al mismo mock: contratado → un chatbot.
      findMany: async (...args: unknown[]) => {
        const row = await findFirstClientProduct(...args);
        return row
          ? [{ id: 'cp_chatbot_1', clientId: 'client_1', clientSiteId: null, tenantId: 't1', status: 'active', product: { code: 'chatbot', tier: 'starter' } }]
          : [];
      },
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

// nextUrl: la ruta lee ?clientProductId para saber de qué chatbot es el
// asistente; un NextRequest real siempre lo trae.
const URL_ = new URL('https://portal.kairikos.test/api/portal/wizard/chatbot/1');

function makeGetRequest() {
  return { url: URL_.toString(), nextUrl: URL_ } as unknown as Parameters<typeof GET>[0];
}

function makePatchRequest(body: unknown) {
  return { json: async () => body, url: URL_.toString(), nextUrl: URL_ } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  resolveClientFromSession.mockReset();
  getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
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
    findFirstClientProduct.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), { params: { product: 'chatbot', step: '1' } });
    expect(res.status).toBe(403);
    expect(findFirstClientProduct).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID, status: 'active', product: { code: 'chatbot' } },
      select: { id: true },
    });
    expect(readWizardStep).not.toHaveBeenCalled();
  });

  it('returns 404 for a contracted product with no wizard content yet (empty catalog)', async () => {
    findFirstClientProduct.mockResolvedValue({ id: 'cp1' });
    const res = await GET(makeGetRequest(), { params: { product: 'web', step: '1' } });
    expect(res.status).toBe(404);
    expect(readWizardStep).not.toHaveBeenCalled();
  });

  it('reads the step for a contracted chatbot product', async () => {
    findFirstClientProduct.mockResolvedValue({ id: 'cp1' });
    readWizardStep.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(), { params: { product: 'chatbot', step: '1' } });
    expect(res.status).toBe(200);
    // Fase 4 multi-instancia — el paso de ESTE chatbot.
    expect(readWizardStep).toHaveBeenCalledWith(expect.anything(), CLIENT_ID, 'chatbot', '1', 'cp_chatbot_1');
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
    findFirstClientProduct.mockResolvedValue(null);
    const res = await PATCH(makePatchRequest({ data: { foo: 'bar' }, status: 'draft' }), {
      params: { product: 'chatbot', step: '1' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(saveWizardStep).not.toHaveBeenCalled();
  });

  it('returns 404 for a contracted product with no wizard content yet (empty catalog)', async () => {
    findFirstClientProduct.mockResolvedValue({ id: 'cp1' });
    const res = await PATCH(makePatchRequest({ data: {}, status: 'draft' }), {
      params: { product: 'leads', step: '1' },
    });
    expect(res.status).toBe(404);
    expect(saveWizardStep).not.toHaveBeenCalled();
  });

  it('saves the step for a contracted chatbot product', async () => {
    findFirstClientProduct.mockResolvedValue({ id: 'cp1' });
    saveWizardStep.mockResolvedValueOnce({ stepId: 's1', version: 1, status: 'draft' });
    const res = await PATCH(
      makePatchRequest({ data: { servicios: [] }, status: 'draft' }),
      { params: { product: 'chatbot', step: '1' } },
    );
    expect(res.status).toBe(200);
    expect(saveWizardStep).toHaveBeenCalledWith(
      expect.anything(),
      // Fase 4 multi-instancia — el paso se guarda en ESTE chatbot; sin esto
      // sería invisible para su bot, que lee la configuración por chatbot.
      { clientId: CLIENT_ID, email: 'c@example.com', productCode: 'chatbot', clientProductId: 'cp_chatbot_1' },
      { stepKey: '1', data: { servicios: [] }, status: 'draft' },
    );
  });
});
