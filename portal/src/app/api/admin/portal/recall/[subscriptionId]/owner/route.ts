import { type NextRequest } from 'next/server';
import { resolveOperatorTarget } from '@/lib/recall-owner-settings-auth';
import { handleOwnerWhatsappPatch } from '@/lib/recall-owner-settings-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/portal/recall/[subscriptionId]/owner — el operador guarda
 * el WhatsApp del dueño cuando el alta se hace por teléfono.
 */
export async function PATCH(req: NextRequest, { params }: { params: { subscriptionId: string } }) {
  const target = await resolveOperatorTarget(req, params.subscriptionId);
  if (target instanceof Response) return target;
  return handleOwnerWhatsappPatch(req, target);
}
