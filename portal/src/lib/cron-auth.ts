import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Autenticación de /api/cron/* — `Authorization: Bearer ${CRON_SECRET}`,
// cerrada si la variable no está.
//
// Revisión de seguridad del 22/09/2026: las quince rutas de cron tenían cada
// una su copia de `header === \`Bearer ${secret}\``, una comparación que se
// corta en el primer carácter distinto y deja medir por tiempos cuánto del
// secreto se ha acertado. Las rutas internas ya comparaban en tiempo
// constante (internal-auth.ts); esto las iguala.
//
// Se comparan los hashes, no las cadenas: timingSafeEqual exige la misma
// longitud, y comparar longitudes antes filtraría la del secreto.
// =============================================================================

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function isAuthorizedCronRequest(req: { headers: Headers }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
