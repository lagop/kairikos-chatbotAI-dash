// =============================================================================
// Multi-instancia — que las TRES capas de unicidad no se separen.
//
// Qué productos se pueden contratar más de una vez está escrito en tres
// sitios, y tienen que decir lo mismo:
//
//   1. El índice único PARCIAL de ClientProduct, en Postgres. La garantía de
//      verdad: su predicado excluye los códigos multi-instancia.
//   2. createProductCheckoutSession — already_contracted, autoservicio.
//   3. activateClientProductForOperator — reutilizar la fila, alta manual.
//
// Las dos de aplicación comparten MULTI_INSTANCE_PRODUCT_CODES, así que no
// pueden separarse entre ellas. La que sí puede separarse en silencio es la
// primera, porque vive en SQL: añadir un código a la constante sin reescribir
// el predicado hace que el insert reviente contra la base de datos, y
// quitarlo del predicado sin quitarlo de la constante deja la puerta abierta
// sin que nada lo diga.
//
// Este test lee la migración y compara.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MULTI_INSTANCE_PRODUCT_CODES, isMultiInstanceProduct } from '@/lib/client-product-access';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');

/** La migración más reciente que reescribe el índice parcial es la que manda:
 *  las anteriores son historia y su predicado ya no está en la base de datos. */
function latestPartialIndexMigration(): string {
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  let found: string | null = null;
  for (const dir of dirs) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    if (/CREATE UNIQUE INDEX[\s\S]*?"ClientProduct"[\s\S]*?WHERE/i.test(sql)) found = sql;
  }
  if (!found) throw new Error('ninguna migración crea el índice único parcial de ClientProduct');
  return found;
}

describe('las tres capas de unicidad dicen lo mismo', () => {
  const sql = latestPartialIndexMigration();

  it('la migración vigente excluye exactamente los códigos multi-instancia', () => {
    // El predicado no lleva los códigos, lleva los ids resueltos en un bloque
    // DO — así que lo que se compara es la lista de códigos de ese SELECT.
    const match = sql.match(/FROM "Product" WHERE code IN \(([^)]*)\)/i);
    expect(match, 'la migración debe resolver los ids por código en un bloque DO').not.toBeNull();

    const codesInSql = (match![1].match(/'([^']+)'/g) ?? []).map((c) => c.slice(1, -1)).sort();
    expect(codesInSql).toEqual([...MULTI_INSTANCE_PRODUCT_CODES].sort());
  });

  it('el predicado es de exclusión, no de inclusión', () => {
    // Un `IN` en vez de un `<> ALL` invertiría el sentido: haría únicos
    // justo los que deben poder repetirse.
    expect(sql).toMatch(/"product_id" <> ALL/);
  });

  it('isMultiInstanceProduct responde a la lista, no a un literal suelto', () => {
    for (const code of MULTI_INSTANCE_PRODUCT_CODES) {
      expect(isMultiInstanceProduct(code)).toBe(true);
    }
    for (const code of ['chatbot', 'leads', 'reviews', 'recall', 'prospecting']) {
      expect(isMultiInstanceProduct(code)).toBe(false);
    }
  });

  it('la guarda de la guarda: detecta una lista que no cuadra', () => {
    // Si el test de arriba pasara con cualquier cosa, no comprobaría nada.
    const fake = "FROM \"Product\" WHERE code IN ('web')";
    const codes = (fake.match(/FROM "Product" WHERE code IN \(([^)]*)\)/i)![1].match(/'([^']+)'/g) ?? []).map((c) =>
      c.slice(1, -1),
    );
    expect(codes).not.toEqual([...MULTI_INSTANCE_PRODUCT_CODES].sort());
  });
});
