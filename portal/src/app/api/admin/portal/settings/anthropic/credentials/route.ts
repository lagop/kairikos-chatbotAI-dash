import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { getAnthropicCredentialStatus, saveAnthropicCredential, DEFAULT_BASE_URL, DEFAULT_MODEL } from '@/lib/anthropic-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getAnthropicCredentialStatus();
  return NextResponse.json(status);
}

const BodySchema = z.object({
  apiKey: z.string().min(1),
  // Empty string means "use the built-in default" — the panel sends '' for
  // an untouched field rather than omitting the key, so this always
  // normalizes both the same way (see the trim-to-null below).
  baseUrl: z.string().trim().optional(),
  model: z.string().trim().optional(),
});

/**
 * POST /api/admin/portal/settings/anthropic/credentials
 *
 * Saves (or rotates) the operator's Anthropic credential — the key, plus
 * an optional custom base URL and default model. Requires a fresh TOTP
 * step-up, same posture as the Stripe/Twilio credential routes: this key
 * is what pays for every AI call the portal makes, across five different
 * features (see anthropic-credentials.ts's header). Verified against the
 * real Messages API (a 1-token completion, cheapest possible real call)
 * before persisting — with whatever base URL and model were entered, so a
 * typo'd model name is caught here instead of on the first real
 * conversation.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const apiKey = body.data.apiKey;
  const baseUrl = body.data.baseUrl || null;
  const model = body.data.model || null;

  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      return NextResponse.json({ error: 'invalid_base_url' }, { status: 400 });
    }
  }

  try {
    const res = await fetch(`${baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model ?? DEFAULT_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hola' }],
      }),
    });
    if (!res.ok) return NextResponse.json({ error: 'invalid_anthropic_credentials' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'invalid_anthropic_credentials' }, { status: 400 });
  }

  // Everything past this point (encrypting and persisting) is NOT wrapped
  // by the try/catch above — that one is scoped to 'did Anthropic reject
  // the credentials', a distinct failure. A misconfigured encryption key
  // throws synchronously and, unguarded, would crash this route as an
  // unhandled exception — see the Stripe/Twilio credentials routes'
  // identical comment for why that reads worse to an operator than a
  // clear internal_error.
  try {
    const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
    await saveAnthropicCredential(
      { apiKey, baseUrl, model },
      { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null },
    );
  } catch (err) {
    logError('anthropic_credentials.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, lastFour: apiKey.slice(-4), baseUrl, model });
}
