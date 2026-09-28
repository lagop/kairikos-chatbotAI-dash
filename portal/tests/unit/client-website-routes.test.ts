// =============================================================================
// Producto Web, Fase 1 — unit tests de las rutas de operador del sitio.
//
// Lo que se fija: quién puede hacer qué. Guardar la credencial de SFTP —la
// llave del servidor de un tercero— pide segundo factor; publicar, que es el
// día a día, no. Y ninguna de las dos responde nada a quien no tiene sesión
// de operador.
//
// Lo demás (construcción del sitio, guardas de host) vive en
// website-publish.test.ts, que no necesita mockear Next.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticate: vi.fn(),
  stepUp: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
  findWebsite: vi.fn(),
  createAudit: vi.fn(),
  findOperator: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticate(...a),
}));
vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => mockState.stepUp(...a),
}));
vi.mock('@/lib/website-publish', () => ({
  savePublishCredential: (...a: unknown[]) => mockState.save(...a),
  publishWebsite: (...a: unknown[]) => mockState.publish(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    clientWebsite: { findUnique: (...a: unknown[]) => mockState.findWebsite(...a) },
    clientWebsiteAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
    operator: { findUnique: (...a: unknown[]) => mockState.findOperator(...a) },
  },
}));

import { PUT as putCredential } from '@/app/api/admin/portal/websites/[websiteId]/credential/route';
import { POST as postPublish } from '@/app/api/admin/portal/websites/[websiteId]/publish/route';

const PARAMS = { params: { websiteId: '11111111-1111-4111-8111-111111111111' } };

function request(body?: unknown): Request {
  return new Request('https://portal.test/api/admin/portal/websites/x/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CREDENTIAL = {
  host: 'sftp.midominio.es',
  port: 22,
  username: 'usuario',
  password: 'secreta',
  remotePath: '/public_html',
};

beforeEach(() => {
  mockState.authenticate.mockReset().mockResolvedValue({ ok: true, operatorId: 'op-1' });
  mockState.stepUp.mockReset().mockResolvedValue({ ok: true });
  mockState.save.mockReset().mockResolvedValue({ ok: true });
  mockState.publish.mockReset().mockResolvedValue({ ok: true, filesUploaded: 2 });
  mockState.findWebsite.mockReset().mockResolvedValue({ id: 'w1', clientId: 'c1', tenantId: null });
  mockState.createAudit.mockReset().mockResolvedValue({});
  mockState.findOperator.mockReset().mockResolvedValue({ email: 'op@kairikos.test' });
  mockState.logError.mockReset();
});

describe('PUT credencial de SFTP', () => {
  it('sin sesión de operador no hace nada', async () => {
    mockState.authenticate.mockResolvedValue({ ok: false });
    const res = await putCredential(request(CREDENTIAL) as never, PARAMS);
    expect(res.status).toBe(401);
    expect(mockState.save).not.toHaveBeenCalled();
  });

  it('exige segundo factor: es la llave del servidor de un tercero', async () => {
    mockState.stepUp.mockResolvedValue({ ok: false, error: 'totp_required', status: 401 });
    const res = await putCredential(request(CREDENTIAL) as never, PARAMS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'totp_required' });
    expect(mockState.save).not.toHaveBeenCalled();
  });

  it('un host interno se rechaza con 422, no con 500', async () => {
    mockState.save.mockResolvedValue({ ok: false, error: 'invalid_host' });
    const res = await putCredential(request({ ...CREDENTIAL, host: '127.0.0.1' }) as never, PARAMS);
    expect(res.status).toBe(422);
  });

  it('la auditoría guarda metadatos y NUNCA la contraseña', async () => {
    await putCredential(request(CREDENTIAL) as never, PARAMS);
    const audited = mockState.createAudit.mock.calls[0][0].data;
    expect(audited.action).toBe('credential_saved');
    expect(audited.after).toMatchObject({ host: CREDENTIAL.host, hasPassword: true });
    expect(JSON.stringify(audited)).not.toContain(CREDENTIAL.password);
  });

  it('un cuerpo incompleto no llega a tocar la credencial guardada', async () => {
    const res = await putCredential(request({ host: 'x.es' }) as never, PARAMS);
    expect(res.status).toBe(400);
    expect(mockState.save).not.toHaveBeenCalled();
  });
});

describe('POST publicar', () => {
  it('sin sesión de operador no publica', async () => {
    mockState.authenticate.mockResolvedValue({ ok: false });
    const res = await postPublish(request() as never, PARAMS);
    expect(res.status).toBe(401);
    expect(mockState.publish).not.toHaveBeenCalled();
  });

  it('NO pide segundo factor: es la acción del día a día', async () => {
    const res = await postPublish(request() as never, PARAMS);
    expect(res.status).toBe(200);
    expect(mockState.stepUp).not.toHaveBeenCalled();
  });

  it('sin credencial responde 409, que es un remedio distinto a un fallo de subida', async () => {
    mockState.publish.mockResolvedValue({ ok: false, error: 'credential_missing' });
    const res = await postPublish(request() as never, PARAMS);
    expect(res.status).toBe(409);
  });

  it('un fallo del servidor del cliente llega como 502 con su mensaje', async () => {
    mockState.publish.mockResolvedValue({ ok: false, error: 'Permission denied' });
    const res = await postPublish(request() as never, PARAMS);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });
});
