// Cartera — tipos compartidos por el panel y el servidor. schema.ts es una
// copia literal del de la plantilla web y no se edita, así que lo propio del
// portal vive aquí.

export type CarteraOperation = 'venta' | 'alquiler';
export const CARTERA_OPERATIONS: readonly CarteraOperation[] = ['venta', 'alquiler'];

export function isCarteraOperation(value: unknown): value is CarteraOperation {
  return value === 'venta' || value === 'alquiler';
}
