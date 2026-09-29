// =============================================================================
// El WhatsApp del equipo, en un solo sitio (lib/portal-data.ts).
//
// El 22/08/2026 se corrigió en portal-data.ts un número de relleno (34 y
// nueve ceros) al que apuntaba «Hablar con el equipo». El 29/09/2026 seguía
// en /portal/sin-acceso, escrito a mano: la corrección se hizo en un sitio y
// no llegó a la copia. La web kairikos.com tenía el mismo fallo en su página
// de reseñas. Este test impide que vuelva a aparecer en el código del portal.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

import { supportWhatsappUrl } from '@/lib/portal-data';

function archivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? archivos(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('el WhatsApp del equipo', () => {
  it('ningún enlace del portal apunta al número de relleno (los comentarios que lo cuentan no cuentan)', () => {
    const culpables = archivos(join(process.cwd(), 'src')).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .map((linea, i) => ({ linea: linea.trim(), f, n: i + 1 }))
        .filter(({ linea }) => /34600000000/.test(linea) && !linea.startsWith('//') && !linea.startsWith('*')),
    );
    expect(culpables.map((c) => `${c.f}:${c.n}`)).toEqual([]);
  });

  it('supportWhatsappUrl lleva al número real con el mensaje ya escrito', () => {
    const url = supportWhatsappUrl('Hola, no tengo acceso');
    expect(url.startsWith(process.env.AUTH_SUPPORT_WHATSAPP || 'https://wa.me/34624514425')).toBe(true);
    expect(url).toContain('?text=Hola%2C%20no%20tengo%20acceso');
  });
});
