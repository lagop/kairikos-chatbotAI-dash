// =============================================================================
// Plan de precios del 01/10/2026 — los complementos (Product.kind 'addon'):
// de qué producto cuelga cada uno y cómo se llama de cara al cliente.
//
// El precio no está aquí: es su fila Product, gestionada en Stripe desde el
// panel. Sin 'server-only': lo leen el catálogo público y las tarjetas.
// =============================================================================

export const ADDONS = {
  web_care: { appliesTo: 'web', label: 'Cuidado de la web' },
} as const;

export type AddonCode = keyof typeof ADDONS;

export function isAddonCode(value: string): value is AddonCode {
  return Object.prototype.hasOwnProperty.call(ADDONS, value);
}
