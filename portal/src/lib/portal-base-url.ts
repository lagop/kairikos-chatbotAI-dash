// =============================================================================
// La URL pública del portal, sin barra final.
//
// Con `||` y no con `??`: docker-compose declara NEXT_PUBLIC_PORTAL_URL aunque
// esté vacía, y una variable declarada y vacía no es lo mismo que ausente
// (trampa 4 de CLAUDE.md). Y el valor por defecto es el dominio real: varios
// módulos antiguos caen en «portal.kairikos.com», que no existe.
// =============================================================================

export const PORTAL_URL_POR_DEFECTO = 'https://portal.kairikos.cloud';

export function portalBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_PORTAL_URL?.trim() || PORTAL_URL_POR_DEFECTO).replace(/\/+$/, '');
}
