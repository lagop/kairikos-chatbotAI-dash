import { type NextRequest } from 'next/server';
import { resolveClientTarget } from '@/lib/recall-owner-settings-auth';
import { handleOwnerWhatsappPatch } from '@/lib/recall-owner-settings-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/portal/recall/owner — el cliente guarda el WhatsApp donde
 * recibe los recados. Ver lib/recall-owner-settings.ts.
 */
export async function PATCH(req: NextRequest) {
  // Fase 3 multi-instancia — de qué línea. Por query y no en el cuerpo
  // porque el objetivo se resuelve antes de leerlo.
  const target = await resolveClientTarget(req.nextUrl.searchParams.get('clientProductId'));
  if (target instanceof Response) return target;
  return handleOwnerWhatsappPatch(req, target);
}
