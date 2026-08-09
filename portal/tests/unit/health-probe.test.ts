// =============================================================================
// KAIA-1110 — unit tests for src/lib/health-probe.ts
//
// Covers the per-toolKey probes: pass (200), fail (401/403), degraded
// (5xx + timeout), and the unknown-toolKey fallback. The supabase probe
// is exercised at the integration level by the smoke script because it
// needs a real Prisma client; the unit tests focus on the HTTP-driven
// probes (resend, n8n, portal_api_key) which carry the bulk of the
// contract risk and are fully mockable.
//
// The lib imports `server-only` to prevent browser bundle leakage.
// Vitest aliases that to an empty stub via tests/helpers/server-only.ts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  probeResend,
  probeN8n,
  probePortalApiKey,
  probeUnknown,
  getProbe,
  type FetchLike,
  type ProbeContext,
} from '@/lib/health-probe';

const ROW = { id: 'row-1', toolKey: 'resend', envVarName: 'RESEND_API_KEY' };

function makeFetch(impl: FetchLike['arguments'] extends never ? never : Parameters<FetchLike>): FetchLike {
  // Convenience: the tests below pass a function that returns a fake
  // Response-shaped object. This wrapper just preserves the call site
  // shape so the tests read like the actual API.
  return impl as unknown as FetchLike;
}

function okResponse(): { status: number; ok: boolean; text(): Promise<string> } {
  return { status: 200, ok: true, text: async () => '' };
}
function errorResponse(status: number): { status: number; ok: boolean; text(): Promise<string> } {
  return { status, ok: false, text: async () => '' };
}

describe('probeResend', () => {
  it('returns healthy on 200', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' } };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('healthy');
    expect(r.error).toBeUndefined();
  });

  it('returns failed on 401 (auth failure)', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(401));
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' } };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('401');
  });

  it('returns failed on 403 (forbidden)', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(403));
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' } };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('403');
  });

  it('returns degraded on 5xx', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(503));
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' } };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('degraded');
    expect(r.error).toContain('503');
  });

  it('returns degraded on probe timeout (AbortError)', async () => {
    const fetchImpl = makeFetch(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' }, timeoutMs: 5_000 };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('degraded');
    expect(r.error).toContain('5000ms');
  });

  it('returns failed when RESEND_API_KEY is unset', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: '' } };
    const r = await probeResend(ROW, ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('RESEND_API_KEY');
  });

  it('sends the Authorization header with the API key', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = makeFetch(async (_url, init) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return okResponse();
    });
    const ctx: ProbeContext = { fetchImpl, env: { resendApiKey: 're_x' } };
    await probeResend(ROW, ctx);
    expect(captured.Authorization).toBe('Bearer re_x');
  });
});

describe('probeN8n', () => {
  const N8N_ROW = { id: 'row-1', toolKey: 'n8n', envVarName: 'N8N_API_KEY' };

  it('returns healthy on 200', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: 'n8n_x', n8nBaseUrl: 'https://n8n.example.com' },
    };
    const r = await probeN8n(N8N_ROW, ctx);
    expect(r.status).toBe('healthy');
  });

  it('returns failed on 401', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(401));
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: 'n8n_x', n8nBaseUrl: 'https://n8n.example.com' },
    };
    const r = await probeN8n(N8N_ROW, ctx);
    expect(r.status).toBe('failed');
  });

  it('returns degraded on 500', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(500));
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: 'n8n_x', n8nBaseUrl: 'https://n8n.example.com' },
    };
    const r = await probeN8n(N8N_ROW, ctx);
    expect(r.status).toBe('degraded');
  });

  it('sends the X-N8N-API-KEY header with the key', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = makeFetch(async (_url, init) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return okResponse();
    });
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: 'n8n_x', n8nBaseUrl: 'https://n8n.example.com' },
    };
    await probeN8n(N8N_ROW, ctx);
    expect(captured['X-N8N-API-KEY']).toBe('n8n_x');
  });

  it('appends the workflow endpoint with limit=1', async () => {
    let url = '';
    const fetchImpl = makeFetch(async (u) => {
      url = u;
      return okResponse();
    });
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: 'n8n_x', n8nBaseUrl: 'https://n8n.example.com/' },
    };
    await probeN8n(N8N_ROW, ctx);
    expect(url).toBe('https://n8n.example.com/api/v1/workflows?limit=1');
  });

  it('returns failed when N8N_API_KEY is unset', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = {
      fetchImpl,
      env: { n8nApiKey: '', n8nBaseUrl: 'https://n8n.example.com' },
    };
    const r = await probeN8n(N8N_ROW, ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('N8N_API_KEY');
  });
});

describe('probePortalApiKey', () => {
  const PORTAL_ROW = { id: 'row-1', toolKey: 'portal_api_key', envVarName: 'PORTAL_API_KEY' };

  it('returns healthy on 200', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: 'https://portal.example.com' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('healthy');
  });

  it('returns failed on 401 (key invalid)', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(401));
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: 'https://portal.example.com' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('invalid');
  });

  it('returns degraded on 5xx', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(503));
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: 'https://portal.example.com' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('degraded');
  });

  it('returns unknown on 404 (probe endpoint not configured)', async () => {
    const fetchImpl = makeFetch(async () => errorResponse(404));
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: 'https://portal.example.com' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('unknown');
  });

  it('sends x-kairikos-internal-key header', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = makeFetch(async (_url, init) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return okResponse();
    });
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: 'https://portal.example.com' },
    };
    await probePortalApiKey(PORTAL_ROW, ctx);
    expect(captured['x-kairikos-internal-key']).toBe('k_x');
  });

  it('returns failed when PORTAL_API_KEY is unset', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: '', portalBaseUrl: 'https://portal.example.com' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('failed');
  });

  it('returns unknown when portalBaseUrl is unset', async () => {
    const fetchImpl = makeFetch(async () => okResponse());
    const ctx: ProbeContext = {
      fetchImpl,
      env: { portalApiKey: 'k_x', portalBaseUrl: '' },
    };
    const r = await probePortalApiKey(PORTAL_ROW, ctx);
    expect(r.status).toBe('unknown');
  });
});

describe('probeUnknown (default fallback)', () => {
  it('returns unknown for an unmapped toolKey', async () => {
    const r = await probeUnknown(
      { id: 'r', toolKey: 'stripe', envVarName: null },
      {},
    );
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('stripe');
  });
});

describe('getProbe dispatch', () => {
  it('returns the resend probe for toolKey=resend', () => {
    expect(getProbe('resend')).toBe(probeResend);
  });
  it('returns the n8n probe for toolKey=n8n', () => {
    expect(getProbe('n8n')).toBe(probeN8n);
  });
  it('returns the portal_api_key probe for toolKey=portal_api_key', () => {
    expect(getProbe('portal_api_key')).toBe(probePortalApiKey);
  });
  it('returns the unknown probe for unmapped toolKeys', () => {
    expect(getProbe('not_a_real_tool')).toBe(probeUnknown);
  });
});
