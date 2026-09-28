// =============================================================================
// Revisión de seguridad del 22/09/2026 — POST /api/public/intake es público y
// sin sesión. Con el email de un cliente existente sobrescribía su nombre de
// empresa, re-vinculaba su login al cliente del formulario y volvía a crear
// carpeta de Drive, correo al operador e incidencia en cada envío. Y la
// respuesta decía a cualquiera si ese email era cliente (clientId).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  clientCreate: vi.fn(),
  clientUpdate: vi.fn(),
  productFindUnique: vi.fn(),
  clientProductCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpsert: vi.fn(),
  submissionFindUnique: vi.fn(),
  submissionCreate: vi.fn(),
  createClientFolderAndUploadKit: vi.fn(),
  createDay2OnboardingIssue: vi.fn(),
  saveWizardStep: vi.fn(),
  fetch: vi.fn(),
}));

vi.stubGlobal('fetch', m.fetch);

vi.mock('@/lib/prisma', () => {
  const tx = {
    chatbotClient: { findUnique: m.clientFindUnique, create: m.clientCreate, update: m.clientUpdate },
    product: { findUnique: m.productFindUnique },
    clientProduct: { create: m.clientProductCreate },
    chatbotClientUser: { findUnique: m.userFindUnique, create: m.userCreate, upsert: m.userUpsert },
    intakeSubmission: { findUnique: m.submissionFindUnique, create: m.submissionCreate },
  };
  return {
    prisma: { ...tx, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
    isDatabaseConfigured: true,
  };
});
vi.mock('@/lib/client-product-access', () => ({ resolveSoleChatbotInstance: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/client-site', () => ({
  ensurePrimaryClientSite: vi.fn().mockResolvedValue(undefined),
  assignSiteToNewContract: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/intake-schema', () => ({
  INTAKE_SLUG: 'chatbot',
  deriveVertical: () => 'fontaneria',
  parseIntakePayload: (input: unknown) => ({ ok: true, data: input }),
}));
vi.mock('@/lib/google-drive', () => ({
  createClientFolderAndUploadKit: (...a: unknown[]) => m.createClientFolderAndUploadKit(...a),
}));
vi.mock('@/lib/paperclip-day2', () => ({
  createDay2OnboardingIssue: (...a: unknown[]) => m.createDay2OnboardingIssue(...a),
}));
vi.mock('@/lib/operator-notify', () => ({ notifyOperatorOfExecutionFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/tenant', () => ({ DEFAULT_TENANT_ID: 'tenant_default' }));
vi.mock('@/lib/intake-to-wizard', () => ({ mapIntakeToWizardSteps: () => ({}) }));
vi.mock('@/lib/wizard-client', () => ({ saveWizardStep: (...a: unknown[]) => m.saveWizardStep(...a) }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/wizard-catalog', () => ({ CHATBOT_PRODUCT_CODE: 'chatbot' }));

import { POST } from '@/app/api/public/intake/route';

const PAYLOAD = { business_name: 'Negocio Falso SL', human_handoff_email: 'dueno@negocio.example', sector: 'x' };
let ipCounter = 0;

function makeRequest() {
  ipCounter += 1;
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': `203.0.113.${ipCounter}` });
  return { headers, json: async () => PAYLOAD } as unknown as NextRequest;
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.submissionFindUnique.mockResolvedValue(null);
  m.submissionCreate.mockResolvedValue({ id: 'sub_1' });
  m.clientCreate.mockResolvedValue({ id: 'client_new', name: 'N', companyName: 'N', tenantId: 't1' });
  m.productFindUnique.mockResolvedValue({ id: 'prod_chatbot' });
  m.clientProductCreate.mockResolvedValue({ id: 'cp_1' });
  m.userFindUnique.mockResolvedValue(null);
  m.userCreate.mockResolvedValue({ id: 'cu_1' });
  m.createClientFolderAndUploadKit.mockResolvedValue({ ok: true, folderId: 'f1', folderUrl: 'https://drive/f1' });
  m.createDay2OnboardingIssue.mockResolvedValue({ ok: true, issueIdentifier: 'KAIA-1' });
  m.fetch.mockResolvedValue({ ok: true });
  process.env.PORTAL_API_BASE_URL = 'https://portal.example';
  process.env.PORTAL_API_KEY = 'k';
});

describe('POST /api/public/intake — an email that is already a client', () => {
  beforeEach(() => {
    m.clientFindUnique.mockResolvedValue({ id: 'client_victim', name: 'Real', companyName: 'Negocio Real', tenantId: 't1' });
  });

  it('never modifies the existing client', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(m.clientUpdate).not.toHaveBeenCalled();
    expect(m.clientCreate).not.toHaveBeenCalled();
    expect(m.clientProductCreate).not.toHaveBeenCalled();
  });

  it('never re-points an existing login to another client', async () => {
    await POST(makeRequest());
    expect(m.userUpsert).not.toHaveBeenCalled();
    expect(m.userCreate).not.toHaveBeenCalled();
  });

  it('records the submission but fires no Drive folder, operator email or Paperclip issue', async () => {
    await POST(makeRequest());
    expect(m.submissionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clientId: 'client_victim' }) }),
    );
    expect(m.createClientFolderAndUploadKit).not.toHaveBeenCalled();
    expect(m.createDay2OnboardingIssue).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('answers exactly like a new signup — the response does not reveal the email is a client', async () => {
    const existingBody = await (await POST(makeRequest())).json();
    m.clientFindUnique.mockResolvedValue(null);
    const newBody = await (await POST(makeRequest())).json();
    expect(Object.keys(existingBody).sort()).toEqual(Object.keys(newBody).sort());
    expect(existingBody).not.toHaveProperty('clientId');
    expect(existingBody).not.toHaveProperty('clientUserId');
    expect(newBody).not.toHaveProperty('drive');
  });
});

describe('POST /api/public/intake — a brand-new email', () => {
  beforeEach(() => {
    m.clientFindUnique.mockResolvedValue(null);
  });

  it('creates the client and its login, and runs the onboarding side effects', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(m.clientCreate).toHaveBeenCalled();
    expect(m.userCreate).toHaveBeenCalledWith({
      data: { nextAuthEmail: PAYLOAD.human_handoff_email, clientId: 'client_new', tenantId: 't1' },
    });
    expect(m.createClientFolderAndUploadKit).toHaveBeenCalled();
    expect(m.createDay2OnboardingIssue).toHaveBeenCalled();
    expect(m.fetch).toHaveBeenCalledWith('https://portal.example/api/internal/notify-operator', expect.anything());
  });

  it('leaves a login that already exists with that email where it is', async () => {
    m.userFindUnique.mockResolvedValueOnce({ id: 'cu_other' });
    await POST(makeRequest());
    expect(m.userCreate).not.toHaveBeenCalled();
    expect(m.userUpsert).not.toHaveBeenCalled();
  });
});
