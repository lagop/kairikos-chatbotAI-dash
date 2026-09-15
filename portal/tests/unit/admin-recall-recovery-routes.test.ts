// =============================================================================
// Recuperación dentro de `recall` — tests de las rutas de operador.
//
// La lógica de campañas e importación ya está cubierta en sus propios
// tests. Aquí se prueba lo que estas rutas añaden, que son reglas de
// permiso, no de cálculo:
//
//   1. APROBAR Y CONFIRMAR UNA IMPORTACIÓN EXIGEN UN OPERADOR IDENTIFICABLE.
//      Con la clave de API heredada (operatorId 'legacy') no hay nadie a
//      quien atribuir la decisión de escribir a clientes reales.
//   2. EL CLIENTE SALE DE LA SUSCRIPCIÓN, nunca del cuerpo.
//   3. EL TEXTO DE LA DECLARACIÓN LO PONE EL SERVIDOR.
//   4. SIN LA CASILLA DE "EL CLIENTE ACEPTÓ", NO SE IMPORTA.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  isDatabaseConfigured: true,
  operatorFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  commitImport: vi.fn(),
  draftCampaign: vi.fn(),
  approveCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    recallSubscription: { findUnique: (...a: unknown[]) => mockState.subscriptionFindUnique(...a) },
  },
}));

vi.mock('@/lib/contact-import', async () => {
  const actual = await vi.importActual<typeof import('@/lib/contact-import')>('@/lib/contact-import');
  return { ...actual, commitImport: (...a: unknown[]) => mockState.commitImport(...a) };
});

vi.mock('@/lib/recovery-campaigns', () => ({
  draftCampaign: (...a: unknown[]) => mockState.draftCampaign(...a),
  approveCampaign: (...a: unknown[]) => mockState.approveCampaign(...a),
  cancelCampaign: (...a: unknown[]) => mockState.cancelCampaign(...a),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { IMPORT_DECLARATION_V1 } from '@/lib/contact-import';

const SUB_ID = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222';
const AUTH_REAL = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const AUTH_LEGACY = { ok: true, sessionId: 'legacy', operatorId: 'legacy' };
const CSV = 'Nombre;Teléfono;Fecha;Importe\nGarcía;651234567;03/04/2023;340,00';

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_REAL);
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ id: 'op_1', email: 'ana@kairikos.com' });
  mockState.subscriptionFindUnique
    .mockReset()
    .mockResolvedValue({ id: SUB_ID, clientId: 'client_real', tenantId: 'tenant_1' });
  mockState.commitImport.mockReset().mockResolvedValue({
    importId: 'imp_1',
    contactsCreated: 1,
    contactsUpdated: 0,
    jobsCreated: 1,
    rowsSkipped: 0,
    quality: {},
  });
  mockState.draftCampaign.mockReset().mockResolvedValue({ campaignId: 'c1', trigger: 'open_quote', memberCount: 3, excludedCount: 1 });
  mockState.approveCampaign.mockReset().mockResolvedValue({ ok: true });
  mockState.cancelCampaign.mockReset().mockResolvedValue({ ok: true });
});

describe('POST .../[subscriptionId]/import — confirmar la importación', () => {
  const load = () => import('@/app/api/admin/portal/recall/[subscriptionId]/import/route');

  it('importa con el cliente de la SUSCRIPCIÓN y la declaración del SERVIDOR', async () => {
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: true }), { params: { subscriptionId: SUB_ID } });

    expect(res.status).toBe(200);
    expect(mockState.commitImport.mock.calls[0][1]).toMatchObject({
      clientId: 'client_real',
      tenantId: 'tenant_1',
      legalDeclaration: IMPORT_DECLARATION_V1,
      declaredBy: 'operator:ana@kairikos.com',
    });
  });

  it('IGNORA un clientId que venga en el cuerpo', async () => {
    const { POST } = await load();
    await POST(req({ csv: CSV, clientAccepted: true, clientId: 'client_ajeno' }), { params: { subscriptionId: SUB_ID } });
    expect(mockState.commitImport.mock.calls[0][1].clientId).toBe('client_real');
  });

  it('IGNORA una declaración que venga en el cuerpo: lo que se guarda es lo que manda el servidor', async () => {
    const { POST } = await load();
    await POST(req({ csv: CSV, clientAccepted: true, legalDeclaration: 'acepto lo que sea' }), {
      params: { subscriptionId: SUB_ID },
    });
    expect(mockState.commitImport.mock.calls[0][1].legalDeclaration).toBe(IMPORT_DECLARATION_V1);
  });

  it.each([undefined, false, 'true', 1])('NO importa sin clientAccepted === true (recibido: %s)', async (value) => {
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: value }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(400);
    expect(mockState.commitImport).not.toHaveBeenCalled();
  });

  it('NO importa con la clave de API heredada: la importación tiene que quedar firmada', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue(AUTH_LEGACY);
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: true }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(403);
    expect(mockState.commitImport).not.toHaveBeenCalled();
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
  });

  it('404 si la suscripción no existe, sin tocar nada', async () => {
    mockState.subscriptionFindUnique.mockResolvedValue(null);
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: true }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(404);
    expect(mockState.commitImport).not.toHaveBeenCalled();
  });

  it('un id que no es un uuid no llega a la base', async () => {
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: true }), { params: { subscriptionId: "1' OR 1=1" } });
    expect(res.status).toBe(404);
    expect(mockState.subscriptionFindUnique).not.toHaveBeenCalled();
  });

  it('401 sin sesión de operador', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const { POST } = await load();
    const res = await POST(req({ csv: CSV, clientAccepted: true }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(401);
  });
});

describe('POST .../[subscriptionId]/import/preview — vista previa', () => {
  it('devuelve el análisis y la declaración, y NO escribe nada', async () => {
    const { POST } = await import('@/app/api/admin/portal/recall/[subscriptionId]/import/preview/route');
    const res = await POST(req({ csv: CSV }), { params: { subscriptionId: SUB_ID } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.declaration).toBe(IMPORT_DECLARATION_V1);
    expect(json.quality.totalRows).toBe(1);
    expect(mockState.commitImport).not.toHaveBeenCalled();
  });

  it('funciona también con la clave heredada: mirar no compromete a nada', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue(AUTH_LEGACY);
    const { POST } = await import('@/app/api/admin/portal/recall/[subscriptionId]/import/preview/route');
    const res = await POST(req({ csv: CSV }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/portal/recall/diagnostic — herramienta de venta', () => {
  it('analiza sin suscripción y sin base de datos', async () => {
    mockState.isDatabaseConfigured = false;
    const { POST } = await import('@/app/api/admin/portal/recall/diagnostic/route');
    const res = await POST(req({ csv: CSV }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.summary).toContain('Calidad de los datos');
    expect(mockState.subscriptionFindUnique).not.toHaveBeenCalled();
    expect(mockState.commitImport).not.toHaveBeenCalled();
  });
});

describe('POST .../[subscriptionId]/recovery/drafts — crear borrador', () => {
  const load = () => import('@/app/api/admin/portal/recall/[subscriptionId]/recovery/drafts/route');

  it('crea el borrador con los ids de la suscripción', async () => {
    const { POST } = await load();
    const res = await POST(req({ trigger: 'open_quote' }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(200);
    expect(mockState.draftCampaign.mock.calls[0][1]).toEqual({
      clientId: 'client_real',
      tenantId: 'tenant_1',
      subscriptionId: SUB_ID,
      trigger: 'open_quote',
    });
  });

  it('rechaza un disparador que no existe', async () => {
    const { POST } = await load();
    const res = await POST(req({ trigger: 'equipment_age' }), { params: { subscriptionId: SUB_ID } });
    expect(res.status).toBe(400);
    expect(mockState.draftCampaign).not.toHaveBeenCalled();
  });

  it('sin candidatos lo dice en vez de crear un borrador vacío', async () => {
    mockState.draftCampaign.mockResolvedValue(null);
    const { POST } = await load();
    const res = await POST(req({ trigger: 'dormant' }), { params: { subscriptionId: SUB_ID } });
    expect(await res.json()).toMatchObject({ ok: false, error: 'no_candidates' });
  });
});

describe('POST /api/admin/portal/recall/recovery/[campaignId] — aprobar o cancelar', () => {
  const load = () => import('@/app/api/admin/portal/recall/recovery/[campaignId]/route');

  it('aprueba a nombre del operador de verdad', async () => {
    const { POST } = await load();
    const res = await POST(req({ action: 'approve' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(200);
    expect(mockState.approveCampaign).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 'op_1');
  });

  // LA REGLA DE ESTA RUTA.
  it('NO aprueba con la clave de API heredada: no hay nadie a quien atribuir la decisión de escribir a clientes', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue(AUTH_LEGACY);
    const { POST } = await load();
    const res = await POST(req({ action: 'approve' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_attributable' });
    expect(mockState.approveCampaign).not.toHaveBeenCalled();
  });

  it('SÍ deja cancelar con la clave heredada: parar un envío nunca le escribe a nadie', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue(AUTH_LEGACY);
    const { POST } = await load();
    const res = await POST(req({ action: 'cancel' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(200);
    expect(mockState.cancelCampaign).toHaveBeenCalled();
  });

  it('409 al aprobar una campaña que ya no está en borrador', async () => {
    mockState.approveCampaign.mockResolvedValue({ ok: false, reason: 'not_draft' });
    const { POST } = await load();
    const res = await POST(req({ action: 'approve' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(409);
  });

  it('409 al cancelar una campaña ya terminada', async () => {
    mockState.cancelCampaign.mockResolvedValue({ ok: false, reason: 'not_cancellable' });
    const { POST } = await load();
    const res = await POST(req({ action: 'cancel' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(409);
  });

  it('rechaza una acción desconocida', async () => {
    const { POST } = await load();
    const res = await POST(req({ action: 'send_now' }), { params: { campaignId: CAMPAIGN_ID } });
    expect(res.status).toBe(400);
  });
});
