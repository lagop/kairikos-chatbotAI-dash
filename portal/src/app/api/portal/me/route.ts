// KAIA-3921 / KAIA-3922 — client profile read + write.
//
//   GET   /api/portal/me   — returns the ChatbotClient row tied to the
//                              caller's session (resolved server-side via
//                              resolveClientFromSession; never trusts a
//                              client_id in the URL or body).
//   PATCH /api/portal/me   — updates a strict allowlist of safe profile
//                              fields. Empty body / unknown fields → 400.
//   POST  /api/portal/me/password — KAIA-3922 password-change flow with
//                              current-password reauthentication, session
//                              invalidation signal, and reset-token burn.
//
// Lens: blast radius (one user, one row, one transaction), separation
// of concerns (no shared mutation surface with admin), MTTR/MTTD.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { DEV_MOCK_CLIENT_BY_EMAIL } from '@/lib/portal-data';
import type { ClientProfile } from '@/types/portal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PatchSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Indica tu nombre.')
      .max(120, 'El nombre es demasiado largo.')
      .optional(),
    companyName: z
      .string()
      .trim()
      .min(1, 'Indica el nombre de la empresa.')
      .max(160, 'El nombre de la empresa es demasiado largo.')
      .optional(),
    contactName: z
      .string()
      .trim()
      .min(1, 'Indica tu nombre.')
      .max(120, 'El nombre es demasiado largo.')
      .optional(),
    primaryContactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email('Introduce un email válido.')
      .max(254)
      .optional(),
  })
  .strict();

type PatchBody = z.infer<typeof PatchSchema>;

function buildProfile(
  row: {
    id: string;
    email: string;
    name: string | null;
    companyName: string | null;
    tier: string;
    stripeCustomerId: string | null;
    goLiveAt: Date | null;
    createdAt: Date;
  },
  slug: string,
): ClientProfile {
  return {
    id: row.id,
    slug,
    companyName: row.companyName ?? row.name ?? '',
    primaryContactEmail: row.email,
    stripeCustomerId: row.stripeCustomerId,
    tier: row.tier as ClientProfile['tier'],
    onboardingStatus: row.goLiveAt ? 'live' : 'in-progress',
    createdAt: row.createdAt.toISOString(),
    goLiveDate: row.goLiveAt?.toISOString() ?? null,
    chatbotSpaceId: null,
    contactName: row.name,
  };
}

function buildMockProfile(client: {
  id: string;
  slug: string;
  companyName: string;
  primaryContactEmail: string;
  stripeCustomerId: string | null;
  tier: ClientProfile['tier'];
  onboardingStatus: ClientProfile['onboardingStatus'];
  createdAt: string;
  goLiveDate: string | null;
  chatbotSpaceId: string | null;
}): ClientProfile {
  return {
    ...client,
    contactName: client.companyName,
  };
}

export async function GET(_req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' || !isDatabaseConfigured) {
    const target = DEV_MOCK_CLIENT_BY_EMAIL.get(resolved.email.toLowerCase());
    if (!target) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(buildMockProfile(target));
  }
  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: {
      id: true,
      email: true,
      name: true,
      companyName: true,
      tier: true,
      stripeCustomerId: true,
      goLiveAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(buildProfile(client, client.email));
}

export async function PATCH(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: PatchBody;
  try {
    const json = (await req.json()) as unknown;
    const parsed = PatchSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => issue.message)
        .filter(Boolean)
        .join(' ');
      return NextResponse.json(
        { error: 'invalid_body', detail: detail || 'Cuerpo no válido.' },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'El cuerpo no es JSON válido.' },
      { status: 400 },
    );
  }

  const { name, companyName, contactName, primaryContactEmail } = body;
  const effectiveName = name ?? contactName;
  if (
    effectiveName === undefined &&
    companyName === undefined &&
    primaryContactEmail === undefined
  ) {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'No has indicado ningún cambio.' },
      { status: 400 },
    );
  }

  // Dev-mock branch: mutate the in-memory client singleton so the UI is
  // demoable without a database. Safe in dev-mock because the process
  // is single-shot.
  if (resolved.source === 'mock_dev' || !isDatabaseConfigured) {
    const target = DEV_MOCK_CLIENT_BY_EMAIL.get(resolved.email.toLowerCase());
    if (!target) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (effectiveName !== undefined) {
      target.companyName = effectiveName;
    }
    if (companyName !== undefined) {
      target.companyName = companyName;
    }
    if (primaryContactEmail !== undefined) {
      target.primaryContactEmail = primaryContactEmail;
    }
    return NextResponse.json(buildMockProfile(target));
  }

  const updated = await prisma.chatbotClient.update({
    where: { id: resolved.clientId },
    data: {
      ...(effectiveName !== undefined ? { name: effectiveName } : {}),
      ...(companyName !== undefined ? { companyName } : {}),
      ...(primaryContactEmail !== undefined ? { email: primaryContactEmail } : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      companyName: true,
      tier: true,
      stripeCustomerId: true,
      goLiveAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(buildProfile(updated, updated.email));
}
