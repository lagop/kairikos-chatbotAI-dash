// =============================================================================
// Fase 1 multi-instancia — el trinquete.
//
// La regla, de docs/plan-multi-instancia-fase-1.md:
//
//   isProductContracted        decide QUÉ SE VE    (pestaña, mosaico, menú)
//   resolveContractedInstance  decide QUÉ SE TOCA  (toda escritura)
//
// Una ruta que ESCRIBE y resuelve la contratación por cliente —sea con
// isProductContracted, sea con un prisma.clientProduct.findFirst en línea—
// elige una instancia arbitraria en cuanto un cliente tenga dos. Hoy no se
// nota porque `already_contracted` impide la segunda; en cuanto se levante,
// se nota y no falla: la auditoría corre sobre una web y el artículo se
// publica en la otra.
//
// Este test NO exige que las 18 rutas de hoy estén convertidas: la fase 1
// deliberadamente no convierte ningún producto. Lo que hace es congelar la
// lista. Si aparece una ruta nueva que escribe y resuelve por cliente, falla.
// Según cada producto se convierta (fases 2-5), su ruta sale de PENDIENTES —
// y si alguien la saca sin convertirla, también falla.
//
// El findFirst en línea importa tanto como el helper: seo/profile no llama a
// isProductContracted en absoluto, resuelve a mano. Un guardia que solo
// mirase el helper habría dado luz verde al caso más claro del problema.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PORTAL_API = join(process.cwd(), 'src', 'app', 'api', 'portal');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name === 'route.ts' ? [full] : [];
  });
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const WRITES = /export async function (POST|PATCH|PUT|DELETE)\b/;
/** Resolver la contratación por cliente, de las dos formas que existen. */
const BY_CLIENT =
  /isProductContracted\(|hasLeadsInboxAccess\(|hasGoogleBusinessConnectAccess\(|(prisma|tx)\.clientProduct\.findFirst/;

/**
 * Rutas que escriben y hoy resuelven por cliente. NO es una lista de fallos:
 * es la deuda conocida, congelada. Cada fase vacía su parte.
 */
const PENDING = new Set([
  // Fase 3 — Reseñas, por ficha de Google. (Recall salió de aquí al
  // convertirse en 20260929090000_recall_multi_line.)
  'google-business/campaigns/route.ts',
  'google-business/reviews/[reviewId]/draft/route.ts',
  'google-business/reviews/[reviewId]/publish/route.ts',
  'google-business/sync/route.ts',
  // Fase 4 — Prospección.
  'prospecting/campaign/route.ts',
  'prospecting/campaign/consent/route.ts',
  // Fase 5 — Chatbot y sus canales.
  'channels/meta/complete-signup/route.ts',
  'chatbot/knowledge/route.ts',
  'wizard/[product]/[step]/route.ts',
  // Fase 5 también, pero por otra razón: la bandeja de leads NO será
  // multi-instancia (ver el plan). Estas dos pasarán a filtrar por sitio,
  // no a separarse por instancia.
  'leads/qualification/route.ts',
  'leads/webhook/route.ts',
]);

/**
 * Rutas que resuelven por cliente Y ESTÁ BIEN QUE LO HAGAN, para siempre.
 * No hay instancia que resolver porque todavía no existe, o porque la
 * petición no escribe nada de un producto ya contratado.
 */
const CLIENT_SCOPED_BY_NATURE = new Set([
  // Crea la contratación: antes de ella no hay instancia a la que apuntar.
  'web-quote/request/route.ts',
  // POST que no escribe: devuelve una propuesta y el cliente la confirma
  // con el PATCH de siempre (Fase A de Prospección).
  'prospecting/campaign/suggest/route.ts',
]);

const offenders = walk(PORTAL_API)
  .filter((file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    return WRITES.test(src) && BY_CLIENT.test(src);
  })
  .map((file) => relative(PORTAL_API, file).replace(/\\/g, '/'));

describe('autorización por instancia en las rutas que escriben', () => {
  it('el guardia encuentra rutas (si no, no está mirando nada)', () => {
    // La guarda de la guarda: si un refactor moviera las rutas o cambiara la
    // forma de declarar los handlers, este test pasaría a no comprobar nada
    // y nadie se enteraría.
    expect(offenders.length).toBeGreaterThan(5);
    expect(offenders).toContain('chatbot/knowledge/route.ts');
  });

  it('ninguna ruta nueva resuelve la contratación por cliente', () => {
    const unexpected = offenders.filter(
      (r) => !PENDING.has(r) && !CLIENT_SCOPED_BY_NATURE.has(r),
    );
    expect(unexpected).toEqual([]);
  });

  it('la lista de pendientes no se queda obsoleta', () => {
    // Si una ruta se convierte, hay que sacarla de PENDING. Si se borra o se
    // renombra, también. Un pendiente que ya no existe hace creer que queda
    // trabajo que no queda.
    const stale = [...PENDING].filter((r) => !offenders.includes(r));
    expect(stale).toEqual([]);
  });

  it('lo permitido para siempre sigue existiendo', () => {
    const stale = [...CLIENT_SCOPED_BY_NATURE].filter((r) => !offenders.includes(r));
    expect(stale).toEqual([]);
  });
});
