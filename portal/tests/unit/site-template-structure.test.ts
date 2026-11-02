import { describe, expect, it } from 'vitest';
import type { SiteContent } from '@/lib/site-content';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { conEstructura, parseTemplateStructure, templateStructureProblems } from '@/lib/site-template-structure';
import { diffSiteTemplates } from '@/lib/site-template-diff';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('la estructura propia de una plantilla', () => {
  it('se comprueba al subirla: tipos, disposiciones, repetidas y que empiece por la portada', () => {
    expect(templateStructureProblems({ portada: [{ tipo: 'portada' }, { tipo: 'servicios', variante: 'zigzag' }, { tipo: 'bloque', id: 'galeria' }] })).toEqual([]);
    expect(templateStructureProblems({ portada: [{ tipo: 'portada' }, { tipo: 'servicios', variante: 'inventada' }] }).join()).toMatch(/no tiene la disposición «inventada»/);
    expect(templateStructureProblems({ portada: [{ tipo: 'portada' }, { tipo: 'faq' }, { tipo: 'faq' }] }).join()).toMatch(/«faq» sale dos veces/);
    expect(templateStructureProblems({ portada: [{ tipo: 'servicios' }, { tipo: 'portada' }] }).join()).toMatch(/empezar por la portada/);
    expect(templateStructureProblems({ portada: [{ tipo: 'nada' }] }).length).toBeGreaterThan(0);
    expect(templateStructureProblems({ portada: [{ tipo: 'portada' }], otra: 1 }).length).toBeGreaterThan(0);
  });

  it('una guardada que no vale cuenta como ninguna: el borrador sale como siempre', () => {
    expect(parseTemplateStructure(null)).toBeNull();
    expect(parseTemplateStructure({ portada: [{ tipo: 'faq' }] })).toBeNull();
    expect(parseTemplateStructure({ portada: [{ tipo: 'portada' }] })).toEqual({ portada: [{ tipo: 'portada' }] });
  });

  it('ordena la portada; lo que no nombra no se pinta, pero su contenido se queda', () => {
    const c: SiteContent = clone(SITE_CONTENT_SAMPLES.normal);
    const out = conEstructura(c, { portada: [{ tipo: 'portada' }, { tipo: 'proceso' }, { tipo: 'servicios', variante: 'mosaico' }] });
    expect(out.paginas[0].secciones).toEqual([{ tipo: 'portada' }, { tipo: 'proceso' }, { tipo: 'servicios', variante: 'mosaico' }]);
    expect(out.datos.garantias).toEqual(c.datos.garantias);
    // Y no toca lo que recibe.
    expect(c.paginas[0].secciones.length).toBeGreaterThan(3);
  });

  it('un bloque nombrado sale si existe; uno sin sitio se quita con sus marcas de ejemplo', () => {
    const c: SiteContent = clone(SITE_CONTENT_SAMPLES.normal);
    const bloque = (id: string) => ({ ...clone(c.bloques[0] ?? {}), id, tipo: 'texto', titulo: id }) as SiteContent['bloques'][number];
    c.bloques = [bloque('galeria'), bloque('pestanas-ia')];
    c.paginas[0].secciones.push({ tipo: 'bloque', id: 'galeria' }, { tipo: 'bloque', id: 'pestanas-ia' });
    c.ejemplos = ['bloques.galeria.titulo', 'bloques.pestanas-ia.titulo', 'cifras.0.valor'];
    const out = conEstructura(c, { portada: [{ tipo: 'portada' }, { tipo: 'bloque', id: 'galeria' }, { tipo: 'bloque', id: 'no-existe' }] });
    expect(out.paginas[0].secciones).toEqual([{ tipo: 'portada' }, { tipo: 'bloque', id: 'galeria' }]);
    expect(out.bloques.map((b) => b.id)).toEqual(['galeria']);
    expect(out.ejemplos).toEqual(['bloques.galeria.titulo', 'cifras.0.valor']);
  });

  it('una corrección que cambia la estructura lo enseña en «qué cambia»', () => {
    const base = { marco: '<html></html>', secciones: {}, estilo: null, estructura: { portada: [{ tipo: 'portada' }] } };
    const fix = { ...base, estructura: { portada: [{ tipo: 'portada' }, { tipo: 'faq' }] } };
    expect(diffSiteTemplates(base, fix).map((p) => p.pieza)).toEqual(['estructura']);
  });
});
