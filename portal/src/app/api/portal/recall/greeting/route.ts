import { type NextRequest } from 'next/server';
import { resolveClientTarget } from '@/lib/recall-owner-settings-auth';
import { handleGreetingGet, handleGreetingPut, handleGreetingDelete } from '@/lib/recall-owner-settings-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/PUT/DELETE /api/portal/recall/greeting — la locución del cliente.
 * PUT recibe el audio tal cual en el cuerpo (WAV o MP3, ver
 * lib/recall-owner-settings.ts). GET es para escucharla en el portal; la
 * que pide Twilio durante la llamada es /api/webhooks/twilio/greeting.
 */
export async function GET() {
  const target = await resolveClientTarget();
  if (target instanceof Response) return target;
  return handleGreetingGet(target);
}

export async function PUT(req: NextRequest) {
  const target = await resolveClientTarget();
  if (target instanceof Response) return target;
  return handleGreetingPut(req, target);
}

export async function DELETE() {
  const target = await resolveClientTarget();
  if (target instanceof Response) return target;
  return handleGreetingDelete(target);
}
