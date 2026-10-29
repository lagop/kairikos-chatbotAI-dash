import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffLines, diffSiteTemplates } from '@/lib/site-template-diff';

describe('qué cambia una corrección', () => {
  it('líneas quitadas y añadidas, sin las que no cambian', () => {
    expect(diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual({ quitadas: ['b'], anadidas: ['B', 'e'] });
    expect(diffLines('igual\r\n', 'igual\n')).toEqual({ quitadas: [], anadidas: [] });
  });

  it('con la corrección real de Cercano: una línea del marco y nada más', () => {
    const marco = readFileSync(join(process.cwd(), 'plantillas', 'oficios-cercano', 'marco.html'), 'utf8');
    const antes = marco.replace('width:min(74%,22rem)', 'width:min(100%,22rem)');
    const secciones = { zona: '<section>…</section>' };
    const cambios = diffSiteTemplates({ marco: antes, secciones, estilo: { x: 1 } }, { marco, secciones, estilo: { x: 1 } });
    expect(cambios).toHaveLength(1);
    expect(cambios[0].pieza).toBe('marco');
    expect(cambios[0].quitadas).toHaveLength(1);
    expect(cambios[0].quitadas[0]).toContain('width:min(100%,22rem)');
    expect(cambios[0].anadidas.some((l) => l.includes('width:min(74%,22rem)'))).toBe(true);
  });

  it('una sección nueva o un estilo distinto también salen; sin cambios, nada', () => {
    const a = { marco: 'm', secciones: { portada: 'p' }, estilo: null };
    expect(diffSiteTemplates(a, a)).toEqual([]);
    const cambios = diffSiteTemplates(a, { marco: 'm', secciones: { portada: 'p', zona: 'z' }, estilo: { acento: 1 } });
    expect(cambios.map((c) => c.pieza)).toEqual(['zona', 'estilo']);
  });
});
