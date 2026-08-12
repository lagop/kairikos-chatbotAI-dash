import { NextResponse, type NextRequest } from 'next/server';
import { isBackendConfigured, PORTAL_API_BASE_URL } from './supabase';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from './portal-data';

export interface AuthResult {
  ok: boolean;
  clientId?: string;
  slug?: string;
  isOperator?: boolean;
  reason?: 'unauthorized' | 'forbidden';
}

const KNOWN_DEV_CLIENT_IDS = new Set<string>([
  MOCK_CLIENT.id,
  MOCK_SECONDARY_CLIENT.id,
]);

export function isKnownClientId(id: string | null | undefined) {
  return Boolean(id && KNOWN_DEV_CLIENT_IDS.has(id));
}

// WP-00 (P0 hotfix) — the `operator-dev` bearer token is a dev-only shortcut
// so local/staging tooling can exercise operator-only client routes without
// a real operator session. Both conditions are required so it stays
// unreachable in production even if `isBackendConfigured` were ever wrong;
// it must not rely on being nested under a single gate.
function isOperatorDevBackdoorAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && !isBackendConfigured;
}

export async function authenticateRequest(req: NextRequest): Promise<AuthResult> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { ok: false, reason: 'unauthorized' };
  if (isBackendConfigured) {
    try {
      // KAIA-11955 — production PORTAL_API_BASE_URL ends in `/portal`
      // (the SPA path) but the route handlers live at `/api/portal/...`.
      // Build the API URL by stripping the trailing `/portal` and
      // prepending `/api` so the request actually hits the route.
      let base = PORTAL_API_BASE_URL.replace(/\/$/, '');
      if (base.endsWith('/portal')) {
        base = base.slice(0, -'/portal'.length);
      }
      const res = await fetch(`${base}/api/portal/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false, reason: 'unauthorized' };
      const data = (await res.json()) as { id: string; slug: string };
      return { ok: true, clientId: data.id, slug: data.slug };
    } catch {
      return { ok: false, reason: 'unauthorized' };
    }
  }
  if (token === MOCK_CLIENT.id || token === 'mock-user-001' || token === 'anon' || token.length >= 8) {
    const isMock = token === MOCK_CLIENT.id || token === 'mock-user-001' || token === 'anon';
    return {
      ok: true,
      clientId: isMock ? MOCK_CLIENT.id : token,
      slug: isMock ? MOCK_CLIENT.slug : 'unknown',
      isOperator: token === 'operator-dev' && isOperatorDevBackdoorAllowed(),
    };
  }
  return { ok: false, reason: 'unauthorized' };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null) {
  return Boolean(value && UUID_RE.test(value));
}
