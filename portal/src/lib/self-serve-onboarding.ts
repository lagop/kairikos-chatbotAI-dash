import 'server-only';
import * as crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_TENANT_ID } from './tenant';

// =============================================================================
// Alta pública de cliente (WP-31) — visitante sin cuenta ni sesión que se
// da de alta y contrata un producto él mismo, sin que un operador cree la
// ficha primero. Comparte forma con createClientByOperator
// (admin-client-onboarding.ts) pero difiere en un punto deliberado: aquí
// la contraseña se fija en el mismo paso, porque no hay un operador que
// separe "quien crea la cuenta" de "quien la usa" — el propio visitante
// es ambos. El caller (la ruta) hashea la contraseña antes de llamar
// aquí; esta función nunca ve la contraseña en claro.
// =============================================================================

export interface CreateClientForSelfServeInput {
  email: string;
  name: string;
  companyName: string;
  passwordHash: string;
}

export type CreateClientForSelfServeResult =
  | { ok: true; clientId: string; clientUserId: string }
  | { ok: false; error: 'client_already_exists' };

const DEFAULT_TIER = 'starter';
const DEFAULT_STATE = 'in-progress';

export async function createClientForSelfServe(
  prisma: PrismaClient,
  input: CreateClientForSelfServeInput,
): Promise<CreateClientForSelfServeResult> {
  const normalizedEmail = input.email.toLowerCase().trim();

  const existingClient = await prisma.chatbotClient.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existingClient) {
    return { ok: false, error: 'client_already_exists' };
  }

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.chatbotClient.create({
      data: {
        email: normalizedEmail,
        name: input.name,
        companyName: input.companyName,
        tier: DEFAULT_TIER,
        state: DEFAULT_STATE,
        tenantId: DEFAULT_TENANT_ID,
        tosAcceptedAt: new Date(),
      },
      select: { id: true },
    });

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        role: 'client',
        passwordHash: input.passwordHash,
        passwordSetAt: new Date(),
      },
      select: { id: true },
    });

    const clientUser = await tx.chatbotClientUser.create({
      data: {
        nextAuthEmail: normalizedEmail,
        clientId: client.id,
        userId: user.id,
        tenantId: DEFAULT_TENANT_ID,
      },
      select: { id: true },
    });

    return { clientId: client.id, clientUserId: clientUser.id };
  });

  return { ok: true, ...result };
}

/**
 * Mints a fresh EmailVerificationToken for `email`. Deliberately does
 * NOT gate login or checkout on this — payment itself (a real card
 * charge) is already a stronger anti-abuse signal than email ownership,
 * and requiring verification before checkout would add friction exactly
 * where this flow exists to remove it. What it DOES gate: nothing yet
 * at the code level — /api/public/verify-email marks
 * ChatbotClient.emailVerifiedAt, which today is purely informational
 * for the operator (an "email sin verificar" state to notice), not
 * enforced anywhere. Tightening that — e.g. requiring verification
 * before support requests or security-sensitive account changes — is a
 * deliberate follow-up, not an oversight.
 */
export async function mintEmailVerificationToken(prisma: PrismaClient, email: string): Promise<string> {
  const normalizedEmail = email.toLowerCase().trim();

  await prisma.emailVerificationToken.updateMany({
    where: { email: normalizedEmail, usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: { email: normalizedEmail, tokenHash: hash, expiresAt },
  });

  return raw;
}

export type VerifyEmailTokenResult = { ok: true } | { ok: false; error: 'invalid_or_expired_token' };

export async function verifyEmailToken(
  prisma: PrismaClient,
  params: { email: string; token: string },
): Promise<VerifyEmailTokenResult> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const tokenHash = crypto.createHash('sha256').update(params.token).digest('hex');

  const record = await prisma.emailVerificationToken.findFirst({
    where: { email: normalizedEmail, tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) {
    return { ok: false, error: 'invalid_or_expired_token' };
  }

  await prisma.$transaction([
    prisma.chatbotClient.updateMany({
      where: { email: normalizedEmail },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return { ok: true };
}
