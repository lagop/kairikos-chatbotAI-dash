import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { createPremiumQuoteRequest, notifyPremiumQuote } from '@/lib/premium-quoter';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 09/11/2026 — POST /api/public/presupuestador
//
// Lo llama la página /web-premium, también cuando va dentro del marco de
// kairikos.com: el marco es del portal, así que la petición es del mismo
// origen y aquí no hace falta CORS, al revés que en /api/public/web-draft.
//
// Sin la casilla de privacidad marcada no se guarda nada (`consent` tiene que
// ser exactamente true), y `estimacion` ni se lee: el importe lo calcula el lib.
// =============================================================================

const BodySchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  empresa: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(200),
  tel: z.string().trim().max(40).optional(),
  web: z.string().trim().max(300).optional(),
  franja: z.string().trim().max(40),
  sector: z.string().trim().max(40),
  respuestas: z.record(z.unknown()),
  consent: z.literal(true),
  /** El campo trampa. Una persona no lo ve. */
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const { website, ...input } = body.data;
  try {
    const result = await createPremiumQuoteRequest(prisma, { ...input, trap: website, ip: clientIpFromHeaders(req.headers) });
    if (!result.ok) {
      const status = result.error === 'invalid' ? 400 : result.error === 'not_available' ? 404 : 429;
      return NextResponse.json({ error: result.error }, { status });
    }
    if (result.saved) {
      const { id, quoter, estimate } = result.saved;
      after(() =>
        notifyPremiumQuote({ id, quoter, estimate, sector: input.sector, nombre: input.nombre, empresa: input.empresa, email: input.email, tel: input.tel, franja: input.franja }),
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('premium_quoter.create_failed', err, {});
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
