// =============================================================================
// Cuándo caduca DE VERDAD un token de Meta, y cuándo no merece guardarse.
//
// 2026-09-15 — el único negocio conectado en producción llevaba un día
// entero sin WhatsApp y nada lo había notado. El token que se guardó al
// conectar caducó ~1 hora después (16:57 → 18:00 UTC del 14), pero
// token_expires_at estaba vacío: el intercambio por token de larga duración
// no devolvió nada útil, la conexión se quedó con el de corta duración, y
// como Meta no mandó `expires_in`, el código lo guardó como "no caduca".
// warnExpiringTokens solo mira tokens CON fecha, así que nunca avisó, y la
// conexión siguió en 'active' mientras cada envío fallaba.
//
// Dos decisiones:
//
//   1. La fecha sale de /debug_token, no de `expires_in`. `expires_in` es
//      opcional y su ausencia no significa "para siempre"; debug_token
//      devuelve expires_at, con 0 como "no caduca" de forma explícita (así
//      viene un token de usuario de sistema de integración de negocio, que
//      es lo que debería dar el registro insertado de Meta). Solo si
//      debug_token falla se cae al `expires_in` de antes.
//
//   2. Un token que caduca en menos de MIN_TOKEN_LIFETIME_DAYS no se guarda:
//      la conexión se rechaza con un error que se ve. Una conexión que
//      "funciona" una hora y luego muere en silencio es peor que un error
//      al conectar, porque el negocio cree que ya está.
//
// Puro y sin red a propósito: los flujos de conexión mockean meta-business
// entero, y esto tiene que seguir siendo lo real en sus tests.
// =============================================================================

/** Por debajo de esto la conexión se rechaza. Un token de usuario de larga
 *  duración dura ~60 días; uno de corta, 1–2 horas. Siete días deja margen
 *  de sobra entre los dos y da tiempo a que warnExpiringTokens avise. */
export const MIN_TOKEN_LIFETIME_DAYS = 7;

export interface InspectedMetaToken {
  isValid: boolean;
  /** null = Meta dice explícitamente que no caduca (expires_at: 0). */
  expiresAt: Date | null;
  type: string | null;
}

/** La respuesta de GET /debug_token, reducida a lo que se usa. */
export function parseDebugTokenResponse(json: unknown): InspectedMetaToken | null {
  if (!json || typeof json !== 'object' || !('data' in json)) return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const d = data as { is_valid?: unknown; expires_at?: unknown; type?: unknown };
  if (typeof d.expires_at !== 'number') return null;
  return {
    isValid: d.is_valid === true,
    expiresAt: d.expires_at === 0 ? null : new Date(d.expires_at * 1000),
    type: typeof d.type === 'string' ? d.type : null,
  };
}

/** La fecha que se guarda en token_expires_at. */
export function resolveTokenExpiry(input: {
  inspected: InspectedMetaToken | null;
  expiresIn: number | null;
  now: Date;
}): Date | null {
  if (input.inspected) return input.inspected.expiresAt;
  return input.expiresIn ? new Date(input.now.getTime() + input.expiresIn * 1000) : null;
}

/** Si la conexión debe rechazarse en vez de guardarse. */
export function isUnusableToken(input: { inspected: InspectedMetaToken | null; expiresAt: Date | null; now: Date }): boolean {
  if (input.inspected && !input.inspected.isValid) return true;
  if (!input.expiresAt) return false;
  return input.expiresAt.getTime() - input.now.getTime() < MIN_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
}
