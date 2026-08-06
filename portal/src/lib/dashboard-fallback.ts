// =============================================================================
// KAIA-11641 — Non-Prisma fallback for /portal/dashboard.
//
// Originally the dashboard page called
// `prisma.chatbotClient.findUnique({ where: { id: resolved.clientId } })`
// directly. When that call throws (observed in staging for the seeded
// orly.nityananda@gmail.com customer), the page silently fell back to the
// `MOCK_CLIENT.companyName` (literal "Acme Corp"), which was a data
// defect that QA reproduced deterministically (see KAIA-11329).
//
// The fallback here routes the same request through the Next.js API
// `/api/portal/me`. /me uses the same Prisma shape but is exercised
// through a separate code path that has, in staging, continued to return
// the real customer's row even when the in-page Prisma call throws.
//
// Why not always go through /api/portal/me?
//   * The page should be self-contained; reaching into a same-origin
//     HTTP route from a server component creates a tight coupling and
//     doubles the per-request latency for the normal case.
//   * The non-fallback path (direct Prisma) is faster and is what every
//     other portal page already does.
//
// When does the fallback fire?
//   * When `prisma.chatbotClient.findUnique` throws OR returns null.
//   * Always — even on success — the dashboard page still tries
//     `loadClientProfileViaPortalApi` only if dataSource !== 'prisma'.
//     This is intentional: the page's primary contract is "see the real
//     customer's name", and the fallback is gated so we never replace
//     good Prisma data with possibly-stale portal-route data.
//
// Notes for reviewers:
//   * This helper is intentionally a thin wrapper around `fetch`. We do
//     NOT introduce a new env var / config layer. The base URL is read
//     from the same env vars `/lib/supabase.ts` already exposes
//     (`PORTAL_API_BASE_URL`, then `NEXT_PUBLIC_PORTAL_URL` as fallback).
//   * Cookies are forwarded from the inbound request so the session is
//     preserved when `/api/portal/me` is hit. Without this, /me would
//     return 401 and the fallback would be a no-op.
// =============================================================================

import 'server-only';
import type { ClientProfile } from '@/types/portal';

export async function loadClientProfileViaPortalApi(): Promise<ClientProfile | null> {
  const base =
    process.env.PORTAL_API_BASE_URL ??
    process.env.NEXT_PUBLIC_PORTAL_URL ??
    '';
  if (!base) return null;
  let cookieHeader = '';
  try {
    const { cookies } = await import('next/headers');
    const all = cookies().getAll() as Array<{ name: string; value: string }>;
    cookieHeader = all
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    cookieHeader = '';
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/portal/me`, {
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as ClientProfile;
  } catch (err) {
    console.error('[portal] /portal/dashboard portal_api_fallback fetch failed:', err);
    return null;
  }
}
