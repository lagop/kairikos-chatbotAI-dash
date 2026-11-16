import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { resolveOperatorTarget } from '@/lib/recall-owner-settings-auth';
import { setCallerLanguages } from '@/lib/recall-caller-language-settings';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ callerLanguages: z.array(z.string().min(2).max(8)).max(10) });

/**
 * PUT /api/admin/portal/recall/[subscriptionId]/languages — el operador elige
 * en qué idiomas se escribe a quien llama a este cliente (15/11/2026). El
 * español va siempre. Ver src/lib/recall-caller-language.ts.
 *
 * Solo operador: activar un idioma manda plantillas a la revisión de Meta en
 * la cuenta del cliente (ver recall-caller-language-settings.ts).
 */
export async function PUT(req: NextRequest, props: { params: Promise<{ subscriptionId: string }> }) {
  const params = await props.params;
  const target = await resolveOperatorTarget(req, params.subscriptionId);
  if (target instanceof Response) return target;
  if (target.actor.type !== 'operator') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const result = await setCallerLanguages(prisma, {
      subscriptionId: target.subscriptionId,
      languages: body.data.callerLanguages,
      actor: { operatorId: target.actor.operatorId, email: target.actor.email },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    logError('recall_caller_languages.put_failed', err, { subscriptionId: target.subscriptionId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
