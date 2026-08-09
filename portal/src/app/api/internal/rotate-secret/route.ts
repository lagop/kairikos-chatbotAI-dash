import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

// POST /api/internal/rotate-secret
// Internal API for the rotate-now worker. Called by the operator settings page
// when the user clicks "rotate now" on an integration row.
// Auth: PORTAL_API_KEY in x-portal-api-key or x-kairikos-internal-key header.
// KAIA-1108

interface RotateSecretBody {
  toolKey: unknown;
}

const VALID_TOOL_KEYS = ['resend', 'n8n', 'portal_api_key', 'postgres_password'];

async function rotatePortalApiKey(): Promise<{ ok: true; newValue: string } | { ok: false; error: string }> {
  const newKey = randomBytes(32).toString('hex');
  return { ok: true, newValue: newKey };
}

async function rotatePostgresPassword(): Promise<{ ok: true; newValue: string } | { ok: false; error: string }> {
  const newPassword = randomBytes(20).toString('base64').slice(0, 24);
  return { ok: true, newValue: newPassword };
}

async function writeAuditLog(
  settingsId: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  await prisma.operatorSettingsAudit.create({
    data: {
      settingsId,
      action,
      before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      after: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      metadata: (metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ ok: false, error: 'database_not_configured' });
  }

  let body: RotateSecretBody;
  try {
    body = (await req.json()) as RotateSecretBody;
  } catch {
    return NextResponse.json({ error: 'bad_request', detail: 'body must be valid JSON' }, { status: 400 });
  }

  if (typeof body.toolKey !== 'string' || !VALID_TOOL_KEYS.includes(body.toolKey)) {
    return NextResponse.json(
      { error: 'bad_request', detail: `toolKey must be one of: ${VALID_TOOL_KEYS.join(', ')}` },
      { status: 422 },
    );
  }

  const toolKey = body.toolKey;

  // Fetch the current settings row
  const settings = await prisma.operatorSettings.findUnique({
    where: { toolKey },
  });
  if (!settings) {
    return NextResponse.json({ error: 'not_found', detail: `toolKey "${toolKey}" not found` }, { status: 404 });
  }

  // Run the rotation
  let rotResult: { ok: true; newValue: string } | { ok: false; error: string };
  let newValue: string | null = null;

  if (toolKey === 'portal_api_key') {
    rotResult = await rotatePortalApiKey();
  } else if (toolKey === 'postgres_password') {
    rotResult = await rotatePostgresPassword();
  } else {
    // resend and n8n require manual rotation — return a specific error
    return NextResponse.json({
      ok: false,
      error: 'manual_step_required',
      detail:
        toolKey === 'resend'
          ? 'Create a new API key at https://resend.com/api-keys, then re-call this endpoint with the new value'
          : 'Regenerate the API key in n8n Settings → API Key, then re-call this endpoint with the new value',
    });
  }

  if (!rotResult.ok) {
    const errorDetail = (rotResult as { ok: false; error: string }).error;
    // Log the failure
    await writeAuditLog(
      settings.id,
      'rotation_failed',
      { toolKey, lastRotatedAt: settings.lastRotatedAt },
      { toolKey, lastRotatedAt: settings.lastRotatedAt },
      { error: errorDetail },
    );
    return NextResponse.json({ ok: false, error: 'rotation_failed', detail: errorDetail });
  }

  newValue = rotResult.newValue;

  // Update lastRotatedAt
  try {
    await prisma.operatorSettings.update({
      where: { toolKey },
      data: { lastRotatedAt: new Date() },
    });
  } catch (err) {
    console.error('[POST /api/internal/rotate-secret] update failed', err);
    await writeAuditLog(
      settings.id,
      'rotation_failed',
      { toolKey, lastRotatedAt: settings.lastRotatedAt },
      null,
      { error: String(err) },
    );
    return NextResponse.json({ ok: false, error: 'internal_error', detail: 'failed to update lastRotatedAt' });
  }

  // Log the success
  await writeAuditLog(
    settings.id,
    'rotation_succeeded',
    { toolKey, lastRotatedAt: settings.lastRotatedAt },
    { toolKey, lastRotatedAt: new Date() },
    { newValueLength: newValue.length },
  );

  return NextResponse.json({
    ok: true,
    toolKey,
    newValue, // The caller (operator settings page) writes this to 1Password
    lastRotatedAt: new Date().toISOString(),
  });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';