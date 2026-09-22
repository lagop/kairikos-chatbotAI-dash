import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { InMemoryRateLimiter, hashPassword } from '@/lib/operator-crypto';
import { createClientForSelfServe, mintEmailVerificationToken } from '@/lib/self-serve-onboarding';
import { sendVerifyEmail, sendAccountExistsEmail } from '@/lib/auth-email';
import { logError } from '@/lib/observability';
import { clientIpFromHeaders } from '@/lib/client-ip';

// =============================================================================
// POST /api/public/self-serve-signup — WP-31.
//
// Public, unauthenticated: a visitor creates their own account AND picks
// the product they want, in one request, with the password set
// immediately (not the two-step setup-password flow — there's no
// operator here to separate "who creates the account" from "who uses
// it"). The client that calls this is expected to sign in right after
// with the same credentials (next-auth/react's signIn('portal-credentials', …)
// client-side, same call the normal login form already makes) and then
// hit the existing POST /api/portal/billing/checkout with `productId` —
// this route does NOT create the Stripe Checkout Session itself, to
// avoid a second, parallel path into checkout logic that could drift
// from the one every other purchase already goes through.
//
// Eligibility is entirely DB-driven (Product.selfServeEligible) — this
// route trusts that flag as the single source of truth rather than
// hardcoding product codes here, so an operator can turn a tier on/off
// from /admin/portal/settings/billing without a deploy.
//
// Revisión de seguridad del 22/09/2026 — verificar antes de pagar.
//   - La cuenta nace con la contraseña BLOQUEADA (lib/pending-signup.ts):
//     no se puede entrar ni pagar hasta pulsar el enlace que llega al
//     buzón. Antes, cualquiera podía registrar el correo de otro negocio y
//     quedarse la cuenta. El enlace lleva el producto elegido, y la página
//     de verificación sigue desde ahí: entrar → pagar (o pedir presupuesto).
//   - La respuesta es la MISMA (202) si el email es nuevo o ya tiene cuenta:
//     antes un 409 'client_already_exists' decía a cualquiera si un correo
//     era cliente. Al dueño real le llega un aviso por correo en su lugar.
// =============================================================================

// Lo único que ve quien rellena el formulario, sea cual sea el caso.
const ACCEPTED = { ok: true, verificationSent: true } as const;

const SelfServeSignupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  companyName: z.string().min(1).max(200),
  password: z.string().min(8).max(128),
  productId: z.string().uuid(),
  tosAccepted: z.literal(true),
  // Honeypot: a real visitor never sees or fills this field (hidden via
  // CSS in the form). A non-empty value is a strong bot signal — this
  // route has no CAPTCHA, and adding one wasn't judged worth the extra
  // dependency/friction until this proves insufficient.
  website: z.string().max(0).optional().default(''),
});

const ipRateLimiter = new InMemoryRateLimiter(15 * 60 * 1000);

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  // La IP que pone el proxy, no la primera de X-Forwarded-For (ver client-ip.ts).
  const ip = clientIpFromHeaders(req.headers);
  if (!ipRateLimiter.check(`ip:${ip}`, 10)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const body = SelfServeSignupSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { email, name, companyName, password, productId } = body.data;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, code: true, isActive: true, selfServeEligible: true },
  });
  // 'web' is the one deliberate exception: selfServeEligible governs
  // self-serve STRIPE PAYMENT ("can a client pay for this themselves"),
  // and 'web' never can — it has no fixed price. But account creation
  // itself is fine for a web prospect; the final step is a free quote
  // request (POST /api/portal/web-quote/request), which never touches
  // this flag or Stripe. See SelfServeSignupForm's requiresQuote branch.
  const eligible = product?.isActive && (product.selfServeEligible || product.code === 'web');
  if (!product || !eligible) {
    return NextResponse.json({ error: 'product_not_self_serve_eligible' }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const origin = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

  // Un login con este email puede existir sin que sea el email de contacto
  // de ningún cliente (un segundo usuario de otro cliente): también cuenta
  // como "ya tiene cuenta", o el create de User reventaría con un 500.
  const existingLogin = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  const created = existingLogin
    ? ({ ok: false, error: 'client_already_exists' } as const)
    : await createClientForSelfServe(prisma, {
        email,
        name,
        companyName,
        passwordHash: await hashPassword(password),
      });

  if (!created.ok) {
    // Nada de cambiar contraseñas ni reenviar el enlace de activación: si la
    // cuenta existente sigue pendiente, ese enlace activaría la contraseña de
    // quien la creó, que no tiene por qué ser el dueño del buzón.
    try {
      await sendAccountExistsEmail({
        to: normalizedEmail,
        loginUrl: `${origin}/portal/login`,
        forgotUrl: `${origin}/portal/forgot-password`,
      });
    } catch (err) {
      logError('self_serve_signup.account_exists_email_failed', err, {}, 'warn');
    }
    return NextResponse.json(ACCEPTED, { status: 202 });
  }

  // Sin este correo la cuenta no se puede usar, pero reintentar el alta no
  // ayuda (el email ya existe): quien no lo reciba entra por "he olvidado
  // mi contraseña", que también prueba que el buzón es suyo.
  try {
    const token = await mintEmailVerificationToken(prisma, normalizedEmail);
    const verifyUrl = `${origin}/portal/verify-email?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&product=${encodeURIComponent(productId)}${product.code === 'web' ? '&quote=1' : ''}`;
    await sendVerifyEmail({ to: email, verifyUrl });
  } catch (err) {
    logError('self_serve_signup.verify_email_failed', err, { clientId: created.clientId }, 'error');
  }

  return NextResponse.json(ACCEPTED, { status: 202 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
