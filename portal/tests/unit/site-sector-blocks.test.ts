import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DETAIL_BLOCK_ID, vacio, withSectorExamples } from '@/lib/site-sector-blocks';
import { BEAUTY_PHOTO_COUNTS, beautyPhotoSet, tradeHeroPhoto } from '@/lib/trade-photos';
import { parseSiteContent } from '@/lib/site-content';
import { renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { buildDesignedWebsiteFiles, hasPortalReferences } from '@/lib/website-build';
import { pendingExampleData } from '@/lib/website-publish';

const BELLEZA = join(process.cwd(), 'public', 'web-draft', 'belleza');
const base = () => ({ ...structuredClone(SITE_CONTENT_SAMPLES.normal), ejemplos: [] as string[] });

describe('fotos de belleza', () => {
  it('están todas, ninguna pesa de más, y las de portada salen según el negocio', () => {
    for (const f of readdirSync(BELLEZA)) expect(statSync(join(BELLEZA, f)).size, f).toBeLessThan(400 * 1024);
    for (const [set, n] of Object.entries(BEAUTY_PHOTO_COUNTS)) for (let i = 1; i <= n; i++) expect(existsSync(join(BELLEZA, `${set}-${i}.jpg`))).toBe(true);
    expect(beautyPhotoSet('Barbería El Puerto', 'hair_salon')).toBe('barberia');
    expect(beautyPhotoSet('Liso & Rizo', 'barber_shop')).toBe('barberia');
    expect(beautyPhotoSet('Liso & Rizo Peluquería', 'hair_salon')).toBe('peluqueria');
    expect(tradeHeroPhoto('beauty', 'Liso & Rizo Peluquería', 'hair_salon')).toMatch(/^\/web-draft\/belleza\/peluqueria-[123]\.jpg$/);
    // Uñas o estética: la del sector de siempre, no una de pelo.
    expect(tradeHeroPhoto('beauty', 'Nails Bar', 'nail_salon')).toBeNull();
  });
});

describe('bloques de ejemplo del sector', () => {
  it('una peluquería trae pestañas con precios, galería y antes y después, colocados tras sus secciones', () => {
    const c = withSectorExamples(base(), { familia: 'beauty', businessName: 'Liso & Rizo', primaryType: 'hair_salon' });
    expect(c.bloques.map((b) => b.tipo)).toEqual(expect.arrayContaining(['pestanas', 'galeria', 'antes_despues']));
    const orden = c.paginas[0].secciones.map((s) => (s.tipo === 'bloque' ? s.id : s.tipo));
    expect(orden[orden.indexOf('servicios') + 1]).toBe('servicios-por-persona');
    expect(orden.slice(orden.indexOf('sobre') + 1, orden.indexOf('sobre') + 3)).toEqual(['trabajos', 'cambio-de-color']);
    // Todas las fotos existen en el banco.
    const fotos = c.bloques.flatMap((b) => [...b.fotos.map((f) => f.foto), ...b.pestanas.map((p) => p.foto)]).filter(Boolean);
    for (const f of fotos) expect(existsSync(join(process.cwd(), 'public', f)), f).toBe(true);
    expect(parseSiteContent(c).ok).toBe(true);
  });

  it('lo ficticio va marcado como ejemplo: no se puede publicar sin revisarlo', () => {
    const c = withSectorExamples(base(), { familia: 'beauty', businessName: 'Liso & Rizo', primaryType: 'hair_salon' });
    expect(pendingExampleData(c)).toEqual(['bloques.servicios-por-persona.titulo', 'bloques.trabajos.titulo', 'bloques.cambio-de-color.titulo']);
    const home = renderSiteFiles(SITE_TEMPLATE_BASE, c, SAMPLE_RENDER_CONTEXT).find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toMatch(/id="bloque-trabajos"><div class="k-dentro"><div class="dato-ejemplo-bloque">/);
    expect(home).toContain('class="leyenda-ejemplos"');
  });

  it('una barbería trae los suyos; otros sectores y las uñas, nada', () => {
    const b = withSectorExamples(base(), { familia: 'beauty', businessName: 'Barbería El Puerto', primaryType: 'barber_shop' });
    expect(b.bloques.find((x) => x.id === 'servicios-por-persona')?.pestanas.map((p) => p.titulo)).toEqual(['Cortes', 'Barba', 'Combos']);
    expect(b.bloques.some((x) => x.tipo === 'antes_despues')).toBe(false);
    expect(withSectorExamples(base(), { familia: 'trades', businessName: 'Aluminios', primaryType: null })).toEqual(base());
    expect(withSectorExamples(base(), { familia: 'beauty', businessName: 'Nails Bar', primaryType: 'nail_salon' })).toEqual(base());
  });

  it('lo que incluye cada servicio: en oficios lleva fotos de su oficio; en peluquería lo sustituyen las pestañas del sector', () => {
    const conDetalle = () => {
      const c = base();
      c.bloques.push({ ...vacio(DETAIL_BLOCK_ID, 'pestanas', 'Qué incluye cada servicio'), pestanas: [0, 1, 2, 3].map((i) => ({ titulo: `S${i}`, texto: '- x', foto: '', alt: '' })) });
      c.paginas[0].secciones.splice(3, 0, { tipo: 'bloque', id: DETAIL_BLOCK_ID });
      c.ejemplos = [`bloques.${DETAIL_BLOCK_ID}.titulo`];
      return c;
    };
    const t = withSectorExamples(conDetalle(), { familia: 'trades', businessName: 'Aluminios Telde', primaryType: null });
    const fotos = t.bloques.find((b) => b.id === DETAIL_BLOCK_ID)!.pestanas.map((p) => p.foto);
    expect(fotos).toEqual(['/web-draft/oficios/aluminio-2.jpg', '/web-draft/oficios/aluminio-3.jpg', '/web-draft/oficios/aluminio-1.jpg', '/web-draft/oficios/aluminio-2.jpg']);
    for (const f of fotos) expect(existsSync(join(process.cwd(), 'public', f)), f).toBe(true);
    expect(parseSiteContent(t).ok).toBe(true);
    // Un oficio que no se reconoce se queda sin fotos, no con la de otro.
    expect(withSectorExamples(conDetalle(), { familia: 'trades', businessName: 'Servicios Pérez', primaryType: null })).toEqual(conDetalle());

    const p = withSectorExamples(conDetalle(), { familia: 'beauty', businessName: 'Liso & Rizo', primaryType: 'hair_salon' });
    expect(p.bloques.some((b) => b.id === DETAIL_BLOCK_ID)).toBe(false);
    expect(p.paginas[0].secciones.some((s) => s.tipo === 'bloque' && s.id === DETAIL_BLOCK_ID)).toBe(false);
    expect(p.ejemplos.some((r) => r.includes(DETAIL_BLOCK_ID))).toBe(false);
  });

  it('al publicar, las fotos de banco viajan con la web y ninguna página apunta al portal', async () => {
    const c = withSectorExamples(base(), { familia: 'beauty', businessName: 'Liso & Rizo', primaryType: 'hair_salon' });
    const files = await buildDesignedWebsiteFiles({ template: SITE_TEMPLATE_BASE, content: c, businessName: 'Liso & Rizo', primaryType: 'hair_salon', themeKey: 'beauty-1', phone: null, address: null, now: new Date('2026-10-28') });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['assets/muestra/belleza-trabajo-1.jpg', 'assets/muestra/belleza-despues-1.jpg', 'assets/muestra/belleza-peluqueria-2.jpg']));
    const home = files.find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toContain('assets/muestra/belleza-trabajo-1.jpg');
    expect(hasPortalReferences(home)).toBe(false);
  });
});
