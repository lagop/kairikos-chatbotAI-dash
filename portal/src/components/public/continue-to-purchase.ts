'use client';

// =============================================================================
// El último paso del alta de autoservicio, ya con sesión: pagar el producto
// elegido o, si es 'web' (sin precio fijo), pedir el presupuesto gratuito.
//
// Vivía dentro de SelfServeSignupForm, justo después de crear la cuenta.
// Desde la revisión de seguridad del 22/09/2026 la cuenta no se puede usar
// hasta confirmar el email, así que este paso se hace desde la página de
// verificación (/portal/verify-email), que sabe qué producto se eligió por
// el enlace del correo (que también dice si va por presupuesto: `quote=1`).
// =============================================================================

export type ContinueResult = { ok: true; redirectTo: string } | { ok: false; message: string };

export async function continueToPurchase(productId: string, requiresQuote: boolean): Promise<ContinueResult> {
  if (requiresQuote) {
    const quoteRes = await fetch('/api/portal/web-quote/request', { method: 'POST' });
    if (!quoteRes.ok) {
      return {
        ok: false,
        message: 'Tu cuenta ya está activa. No se pudo enviar la solicitud de presupuesto: inténtalo de nuevo desde el portal.',
      };
    }
    const quote = (await quoteRes.json()) as { clientProductId: string };
    return { ok: true, redirectTo: `/portal/web/${quote.clientProductId}` };
  }

  const checkoutRes = await fetch('/api/portal/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId }),
  });
  if (checkoutRes.ok) {
    const data = (await checkoutRes.json()) as { url: string };
    return { ok: true, redirectTo: data.url };
  }

  return {
    ok: false,
    message: 'Tu cuenta ya está activa. No se pudo iniciar el pago: inténtalo de nuevo desde "Añadir producto" en el portal.',
  };
}
