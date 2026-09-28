// =============================================================================
// Ningún módulo de email puede cargar Resend con `eval('require')`.
//
// Ese truco estuvo en siete módulos desde agosto de 2026. En desarrollo
// funciona (Node, CommonJS); en la compilación de producción de Next no
// existe `require`, así que cada envío moría con "require is not defined",
// se anotaba como warn y la ruta seguía adelante. Resultado: ningún email
// —presupuestos, leads, avisos al operador, reseñas, recuperación del
// wizard, resúmenes— salió nunca de producción. Solo auth-email.ts se
// salvó, porque usaba un import normal.
//
// Se detectó el 22/09/2026 al probar el aviso de derivación en producción.
// Este test es la valla: es fácil copiar el patrón viejo de un módulo
// hermano sin saber nada de esto.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB_DIR = join(__dirname, '../../src/lib');

function libFiles(): string[] {
  return readdirSync(LIB_DIR).filter((f) => f.endsWith('.ts'));
}

describe('carga del SDK de Resend', () => {
  it('ningún lib usa eval para hacerse con require', () => {
    const culpables = libFiles().filter((f) => {
      const source = readFileSync(join(LIB_DIR, f), 'utf8');
      return /\(\s*0\s*,\s*eval\s*\)\s*\(\s*['"]require['"]\s*\)/.test(source);
    });

    expect(culpables).toEqual([]);
  });

  // Solo los que construyen un cliente de verdad: hay libs que nombran
  // `resendMessageId` o `resendApiKey` sin mandar nada.
  it('los que mandan email lo cargan con import dinámico o estático', () => {
    const conResend = libFiles().filter((f) => readFileSync(join(LIB_DIR, f), 'utf8').includes('new Resend('));
    expect(conResend.length).toBeGreaterThan(0);

    for (const f of conResend) {
      const source = readFileSync(join(LIB_DIR, f), 'utf8');
      const cargaBien = /await import\(['"]resend['"]\)/.test(source)
        || /^import .*from ['"]resend['"]/m.test(source);
      expect(cargaBien, `${f} carga Resend de una forma que el bundle de producción no resuelve`).toBe(true);
    }
  });
});
