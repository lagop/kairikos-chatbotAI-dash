import { type NextRequest } from 'next/server';
import { resolveOperatorTarget } from '@/lib/recall-owner-settings-auth';
import { handleGreetingGet, handleGreetingPut, handleGreetingDelete } from '@/lib/recall-owner-settings-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/PUT/DELETE /api/admin/portal/recall/[subscriptionId]/greeting — la
 * locución de un cliente, para cuando el dueño la manda por otro canal y la
 * sube el operador.
 */
type Ctx = { params: { subscriptionId: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  const target = await resolveOperatorTarget(req, params.subscriptionId);
  if (target instanceof Response) return target;
  return handleGreetingGet(target);
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const target = await resolveOperatorTarget(req, params.subscriptionId);
  if (target instanceof Response) return target;
  return handleGreetingPut(req, target);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const target = await resolveOperatorTarget(req, params.subscriptionId);
  if (target instanceof Response) return target;
  return handleGreetingDelete(target);
}
