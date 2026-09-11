import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isBackendConfigured, PORTAL_API_BASE_URL } from '@/lib/supabase';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { createClientByOperator, mintSetupPasswordToken } from '@/lib/admin-client-onboarding';
import { activateClientProductForOperator } from '@/lib/client-product-activation';
import { createProductCheckoutSession } from '@/lib/stripe-billing';
import { sendSetupPassword, sendEmail } from '@/lib/auth-email';
import { logError } from '@/lib/observability';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (isBackendConfigured) {
    const upstream = await fetch(`${PORTAL_API_BASE_URL}/admin/portal/clients`, {
      headers: { Authorization: req.headers.get('authorization') ?? '' },
      cache: 'no-store',
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.json([
    {
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'acme-corp',
      companyName: 'Acme Corp',
      primaryContactEmail: 'qa-test-client-a@kairikos.com',
      stripeCustomerId: 'cus_test_client_a',
      tier: 'pro',
      onboardingStatus: 'live',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      slug: 'globex-inc',
      companyName: 'Globex Inc',
      primaryContactEmail: 'qa-test-client-b@kairikos.com',
      stripeCustomerId: 'cus_test_client_b',
      tier: 'premium',
      onboardingStatus: 'in-progress',
    },
  ]);
}

// =============================================================================
// POST /api/admin/portal/clients — alta manual de cliente desde el panel.
//
// Hasta hoy la única fila ChatbotClient que se podía crear era vía
// POST /api/public/intake, el formulario de kairikos.com — una venta
// cerrada por teléfono o email no tenía ningún sitio en el panel donde
// darse de alta.
//
// Cada producto de la lista queda o bien activo de inmediato (el
// operador ya cobró por otra vía — transferencia, efectivo) o con un
// enlace de pago de Stripe que se manda por correo al cliente, para que
// pague él mismo igual que en el autoservicio. Las dos rutas reutilizan
// exactamente la misma lógica que ya usan sus caminos originales
// (activateClientProductForOperator / createProductCheckoutSession) —
// nada de esto se reimplementa aquí.
// =============================================================================

const CreateClientSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  companyName: z.string().min(1).max(200),
  products: z
    .array(
      z.object({
        productId: z.string().uuid(),
        mode: z.enum(['active', 'checkout_link']),
      }),
    )
    .max(20)
    .default([]),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = CreateClientSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { email, name, companyName, products } = body.data;

  const created = await createClientByOperator(prisma, { email, name, companyName });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 409 });
  }
  const { clientId } = created;

  const operatorIdForAudit = auth.operatorId === 'legacy' ? null : auth.operatorId;
  const actorId = `operator:${auth.operatorId}`;

  const activated: string[] = [];
  const checkoutLinks: { productName: string; url: string }[] = [];
  const failed: { productId: string; mode: string; error: string }[] = [];

  for (const { productId, mode } of products) {
    if (mode === 'active') {
      const result = await activateClientProductForOperator(prisma, { clientId, productId }, { operatorId: operatorIdForAudit });
      if (result.ok) {
        activated.push(result.productCode);
      } else {
        failed.push({ productId, mode, error: result.error });
      }
      continue;
    }

    // mode === 'checkout_link'
    const result = await createProductCheckoutSession({ clientId, productId, actorId });
    if (result.ok) {
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { name: true } });
      checkoutLinks.push({ productName: product?.name ?? productId, url: result.url });
    } else {
      failed.push({ productId, mode, error: result.error });
    }
  }

  // El correo de activación es best-effort: el cliente ya existe y el
  // operador puede reenviarlo a mano (POST .../send-setup-email, ya
  // existente) si Resend falla en este momento — un fallo de correo no
  // debe deshacer el alta ni los productos ya activados.
  //
  // El enlace necesita un PasswordResetToken real (KAIA-13282): la ruta
  // /api/portal/setup-password exige un token válido desde el arreglo
  // de seguridad KAIA-11500, y un enlace sin él siempre se rechaza en
  // el propio cliente como "El enlace no es válido" antes de llegar a
  // hacer ningún POST.
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const token = await mintSetupPasswordToken(prisma, normalizedEmail);
    const setupUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001'}/portal/setup-password?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}`;
    await sendSetupPassword({ to: email, setupUrl });
  } catch (err) {
    logError('admin_clients.setup_email_failed', err, { clientId }, 'warn');
  }

  if (checkoutLinks.length > 0) {
    try {
      const lines = checkoutLinks.map((l) => `${l.productName}: ${l.url}`);
      await sendEmail({
        to: email,
        subject: 'Completa el pago de tu contratación — Kairikos',
        text: [
          'Hola,',
          '',
          'Para activar los productos contratados, completa el pago desde estos enlaces:',
          '',
          ...lines,
          '',
          '— Equipo Kairikos',
        ].join('\n'),
        html: `<!doctype html><html lang="es"><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
          <p>Hola,</p>
          <p>Para activar los productos contratados, completa el pago desde estos enlaces:</p>
          <ul>${checkoutLinks.map((l) => `<li><a href="${l.url}">${l.productName}</a></li>`).join('')}</ul>
          <p style="font-size: 12px; color: #6b7280;">— Equipo Kairikos</p>
        </body></html>`,
      });
    } catch (err) {
      logError('admin_clients.checkout_links_email_failed', err, { clientId }, 'warn');
    }
  }

  return NextResponse.json(
    { ok: true, clientId, clientUserId: created.clientUserId, activated, checkoutLinksSent: checkoutLinks.length, failed },
    { status: 201 },
  );
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
