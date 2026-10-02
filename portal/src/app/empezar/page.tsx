import { EmptyState } from '@/components/portal/EmptyState';
import Link from 'next/link';
import { SelfServeSignupForm, type SignupTierOption } from '@/components/public/SelfServeSignupForm';
import { ThemeToggle } from '@/components/portal/ThemeToggle';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';
import { tierLabel } from '@/lib/public-catalog';

// =============================================================================
// /empezar (WP-31) — public, no session required. A visitor creates their
// own account and buys a product directly, without an operator creating
// the account first. Deliberately NOT under /portal — middleware.ts only
// gates /portal/:path* and /admin/portal/:path*, so this route (like
// /chatbot/intake and /api/public/*) needs no exemption added there.
//
// Only lists Product rows with selfServeEligible=true — that flag is the
// single source of truth for what shows up here (see the column's
// comment in schema.prisma); this page does no product-code filtering
// of its own.
// =============================================================================

// Los nombres de escalón salen de lib/public-catalog. Estuvieron duplicados
// aquí y en /portal/productos, con la nota de que duplicarlos no costaba nada
// «porque es formato, no lógica de negocio». Era cierto mientras los dos
// sitios fueran pantallas internas. Desde el 26/09/2026 los mismos nombres se
// publican en kairikos.com a través de /api/public/catalogo, y una tercera
// copia habría sido la que se queda atrás.

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export const dynamic = 'force-dynamic';

// A7 — el enlace que reparte un socio es /empezar?ref=SALTOKI-ADEF2. Se lee
// aquí, en el servidor, y baja ya escrito al formulario: el visitante no
// teclea nada y el socio no depende de que nadie recuerde su código. No se
// valida en esta página a propósito — un código inventado en la URL no puede
// impedir que alguien se dé de alta; eso lo decide el alta, no la portada.
export default async function EmpezarPage(
  props: {
    searchParams?: Promise<{ ref?: string | string[]; producto?: string | string[]; tier?: string | string[] }>;
  }
) {
  const searchParams = await props.searchParams;
  const refParam = searchParams?.ref;
  const codigoInicial = (Array.isArray(refParam) ? refParam[0] : refParam)?.trim().slice(0, 40) ?? '';

  // WP-33 — qué producto traía quien llega desde kairikos.com.
  //
  // Los botones «Empezar» de /servicios/ y /planes/ mandaban aquí SIN decir
  // qué producto había pulsado el visitante, así que esta página preseleccionaba
  // siempre el primero de la lista —Chatbot IA— y quien venía a contratar
  // Reseñas se encontraba con otra cosa marcada. Un fallo silencioso de los
  // caros: no da error, no se ve en los logs, y lo que se pierde es la venta
  // de alguien que ya había dicho que sí.
  //
  // 'producto' es el código; 'tier' es opcional, porque /servicios/ vende el
  // producto entero y /planes/ vende un escalón concreto. Sin tier, gana el
  // más barato — que es el primero, porque la consulta ordena por precio.
  const unParam = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase() ?? '';
  const productoPedido = unParam(searchParams?.producto).slice(0, 40);
  const tierPedido = unParam(searchParams?.tier).slice(0, 40);

  if (!isDatabaseConfigured) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>
        <EmptyState title="No disponible en modo demo" description="El alta requiere una cuenta real conectada a base de datos." />
      </div>
    );
  }

  const products = await prisma.product.findMany({
    where: { isActive: true, selfServeEligible: true, kind: 'plan' },
    orderBy: [{ code: 'asc' }, { priceCents: 'asc' }],
    select: { id: true, code: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
  });

  const tiers: SignupTierOption[] = products.map((p) => ({
    productId: p.id,
    code: p.code,
    label: isProductCode(p.code) ? PRODUCT_CATALOGS[p.code].label : p.code,
    tier: p.tier,
    tierLabel: tierLabel(p.tier),
    priceCents: p.priceCents,
    setupFeeCents: p.setupFeeCents,
    currency: p.currency,
    requiresQuote: false,
  }));

  // 'web' is deliberately outside the selfServeEligible query above —
  // it has no fixed catalog price (createProductCheckoutSession
  // rejects it unconditionally with product_requires_quote, same as
  // /portal/productos's own RequestWebQuoteCard special-case), so it
  // was invisible on this page entirely: a brand-new prospect with no
  // prior account had NO public way to ask for a website, only an
  // existing client could, from inside the portal. Same account
  // creation as every other tier here, but the final step is
  // POST /api/portal/web-quote/request (free, no Stripe) instead of a
  // Checkout Session — see SelfServeSignupForm's requiresQuote branch.
  const webProduct = await prisma.product.findFirst({
    where: { code: 'web', isActive: true },
    select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
  });
  if (webProduct) {
    tiers.push({
      productId: webProduct.id,
      code: 'web',
      label: isProductCode('web') ? PRODUCT_CATALOGS.web.label : 'web',
      tier: webProduct.tier,
      tierLabel: tierLabel(webProduct.tier),
      priceCents: webProduct.priceCents,
      setupFeeCents: webProduct.setupFeeCents,
      currency: webProduct.currency,
      requiresQuote: true,
    });
  }

  // Se resuelve aquí, con `tiers` ya completo: un código que no exista o un
  // escalón que no le corresponda devuelven undefined y el formulario se
  // comporta como siempre. Nadie escribe estas URLs a mano, pero llegan
  // recortadas de un WhatsApp más a menudo de lo que parece.
  const productoInicial = productoPedido
    ? (tiers.find((t) => t.code === productoPedido && (!tierPedido || t.tier === tierPedido))
        ?? tiers.find((t) => t.code === productoPedido))?.productId
    : undefined;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-4 flex justify-end">
        <ThemeToggle />
      </div>
      <div className="mb-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Kairikos</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Crea tu cuenta</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          Elige un producto, crea tu cuenta y paga — sin esperar a que nadie te dé de alta.
        </p>
      </div>

      {tiers.length === 0 ? (
        <EmptyState title="Sin productos disponibles" description="Ahora mismo no hay ningún producto en autoservicio. Escríbenos a hola@kairikos.com." />
      ) : (
        <SelfServeSignupForm tiers={tiers} codigoInicial={codigoInicial} productoInicial={productoInicial} />
      )}

      <p className="mt-8 text-center text-xs text-kairikos-muted">
        ¿Ya tienes cuenta?{' '}
        <Link className="underline" href="/portal/login">
          Inicia sesión
        </Link>
        .
      </p>
    </div>
  );
}
