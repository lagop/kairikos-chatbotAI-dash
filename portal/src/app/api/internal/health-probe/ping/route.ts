import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// GET /api/internal/health-probe/ping
//
// KAIA-1110 — minimal endpoint hit by the `portal_api_key` health probe.
// The probe is asking "does this key still authenticate?"; we only need
// to confirm the auth header round-trips successfully. No DB access, no
// side effects — so this route is safe to be called every 5 minutes by
// the worker without putting load on Postgres.
//
// Auth: shared secret in PORTAL_API_KEY, identical to the rest of the
// /api/internal/* family. The probe passes the key in
// `x-kairikos-internal-key`; the helper also accepts `x-portal-api-key`
// for parity with the other internal routes.
//
// Response:
//   200 — { ok: true }  (key is valid; this is the "healthy" signal)
//   401 — handled by `internalAuthFailureResponse`
//   500 — handled by `internalAuthFailureResponse` when PORTAL_API_KEY
//         is unset on the server
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  // `revision` — el commit del que salió esta imagen (BUILD_REVISION, que
  // el Dockerfile recibe como build-arg). Lo pregunta el paso de
  // verificación de deploy.yml para confirmar que la versión desplegada
  // es la que se acaba de construir: el 23/09/2026 un despliegue se
  // marcó OK y la VPS siguió doce minutos con la anterior.
  //
  // Va en esta ruta, que ya exige PORTAL_API_KEY, y no en /api/health,
  // que es pública: saber de qué commit corre un servidor es justo el
  // tipo de dato que no se regala a quien no tiene que verlo.
  //
  // null cuando no se construyó con el build-arg (imagen local): honesto,
  // y el verificador sabe distinguirlo de "otra versión".
  return NextResponse.json({ ok: true, revision: process.env.BUILD_REVISION || null });
}

export function POST() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
