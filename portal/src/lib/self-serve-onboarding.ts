import 'server-only';
import * as crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_TENANT_ID } from './tenant';
import { ensurePrimaryClientSite } from './client-site';
import { PENDING_SIGNUP_PREFIX, isPendingSignupHash } from './pending-signup';

// =============================================================================
// Alta pública de cliente (WP-31) — visitante sin cuenta ni sesión que se
// da de alta y contrata un producto él mismo, sin que un operador cree la
// ficha primero. Comparte forma con createClientByOperator
// (admin-client-onboarding.ts) pero difiere en un punto deliberado: aquí
// la contraseña se fija en el mismo paso, porque no hay un operador que
// separe "quien crea la cuenta" de "quien la usa" — el propio visitante
// es ambos. El caller (la ruta) hashea la contraseña antes de llamar
// aquí; esta función nunca ve la contraseña en claro.
//
// Revisión de seguridad del 22/09/2026: la contraseña nace BLOQUEADA
// (prefijo PENDING_SIGNUP_PREFIX) y solo sirve para entrar cuando alguien
// confirma el email desde su buzón — verifyEmailToken la desbloquea. Ver
// lib/pending-signup.ts.
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

    // Fase 4 multi-instancia — todo cliente nace con su sitio primario: es la
    // invariante que la fase 1 impuso con un índice parcial y que ninguno de
    // los caminos de alta cumplía. Ver lib/client-site.ts.
    await ensurePrimaryClientSite(tx, {
      clientId: client.id,
      tenantId: DEFAULT_TENANT_ID,
      name: input.companyName || input.name,
    });

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        role: 'client',
        passwordHash: `${PENDING_SIGNUP_PREFIX}${input.passwordHash}`,
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
 * Mints a fresh EmailVerificationToken for `email`.
 *
 * Revisión de seguridad del 22/09/2026 — esto ya NO es informativo para
 * las altas de autoservicio: hasta que se usa el token, su contraseña está
 * bloqueada y no pueden entrar ni pagar (ver lib/pending-signup.ts). El
 * argumento de antes —"el pago con tarjeta ya es mejor señal antiabuso que
 * el email"— no cubría el caso real: quien registra el correo de OTRO
 * negocio no necesita pagar para quedarse con la cuenta. Para las cuentas
 * que crea un operador sigue siendo informativo: ahí la contraseña se fija
 * desde un enlace que ya llega a ese buzón (setup-password).
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

  // Desbloquea la contraseña del alta (si la hay) en la misma transacción
  // que consume el token.
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, passwordHash: true },
  });
  const unlock =
    user && isPendingSignupHash(user.passwordHash)
      ? [
          prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: user.passwordHash!.slice(PENDING_SIGNUP_PREFIX.length) },
          }),
        ]
      : [];

  await prisma.$transaction([
    prisma.chatbotClient.updateMany({
      where: { email: normalizedEmail },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    ...unlock,
  ]);

  return { ok: true };
}
