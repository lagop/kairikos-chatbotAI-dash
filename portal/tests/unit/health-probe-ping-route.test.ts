// =============================================================================
// GET /api/internal/health-probe/ping — además de confirmar que la clave
// interna sigue valiendo, dice de qué commit salió la imagen que corre.
//
// Lo pregunta el paso de verificación de deploy.yml. Nació el 23/09/2026:
// un despliegue se marcó OK en GitHub y la VPS siguió doce minutos con la
// versión anterior, así que "desplegado" no significaba nada.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({ auth: vi.fn(), failure: vi.fn() }));

vi.mock('@/lib/internal-auth', () => ({
  authenticateInternalRequest: (...a: unknown[]) => mockState.auth(...a),
  internalAuthFailureResponse: (...a: unknown[]) => mockState.failure(...a),
}));

import { GET, POST } from '@/app/api/internal/health-probe/ping/route';

const req = {} as unknown as NextRequest;

beforeEach(() => {
  mockState.auth.mockReset().mockReturnValue({ ok: true });
  mockState.failure.mockReset().mockReturnValue(null);
});

afterEach(() => {
  delete process.env.BUILD_REVISION;
});

describe('GET /api/internal/health-probe/ping', () => {
  it('devuelve el commit de la imagen', async () => {
    process.env.BUILD_REVISION = '6c67686b5f1bb89393f2401a17b016cf68353182';

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      revision: '6c67686b5f1bb89393f2401a17b016cf68353182',
    });
  });

  // Una imagen construida en local no lleva el build-arg. Decir null es
  // honesto; inventarse un commit haría que el verificador del despliegue
  // diera por buena una versión que no es.
  it('dice null cuando la imagen no se construyó con el commit dentro', async () => {
    const res = await GET(req);
    expect(await res.json()).toEqual({ ok: true, revision: null });
  });

  it('una variable vacía también es null, no cadena vacía', async () => {
    process.env.BUILD_REVISION = '';
    expect(await (await GET(req)).json()).toEqual({ ok: true, revision: null });
  });

  // Lo que de verdad protege el dato: sin la clave interna no se contesta.
  // La versión que corre un servidor no se regala.
  it('sin clave válida no dice ni la versión ni nada', async () => {
    const denegada = new Response('unauthorized', { status: 401 });
    mockState.failure.mockReturnValue(denegada);
    process.env.BUILD_REVISION = 'secreto';

    const res = await GET(req);

    expect(res).toBe(denegada);
  });

  it('POST sigue sin estar permitido', async () => {
    expect(POST().status).toBe(405);
  });
});
