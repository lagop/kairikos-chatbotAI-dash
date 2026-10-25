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

async function requestWebQuote(): Promise<ContinueResult> {
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

export async function continueToPurchase(
  productId: string,
  requiresQuote: boolean,
  /** 25/10/2026 — la web comprada desde su borrador (`borrador` en el enlace). */
  webDraftToken?: string,
): Promise<ContinueResult> {
  if (webDraftToken) {
    const res = await fetch('/api/portal/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, webDraftToken }),
    });
    if (res.ok) {
      const data = (await res.json()) as { url: string };
      return { ok: true, redirectTo: data.url };
    }
    // El tope del mes se llenó entre el alta y este clic: en vez de dejarle
    // con un error, su petición pasa a presupuesto y le llamamos. Lo que no
    // puede pasar es perder a alguien que ya dijo «la quiero».
    if (res.status === 409) return requestWebQuote();
    return {
      ok: false,
      message: 'Tu cuenta ya está activa. No se pudo iniciar el pago: vuelve a abrir el enlace de tu borrador o escríbenos.',
    };
  }

  if (requiresQuote) return requestWebQuote();

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
