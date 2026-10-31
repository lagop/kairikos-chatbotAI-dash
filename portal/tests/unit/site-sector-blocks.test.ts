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
    // 31/10/2026 — uñas, estética y spa tienen las suyas: nada de pelo.
    expect(tradeHeroPhoto('beauty', 'Nails Bar', 'nail_salon')).toMatch(/^\/web-draft\/belleza\/unas-[1-4]\.jpg$/);
    expect(tradeHeroPhoto('beauty', 'Centro Lola', 'beauty_salon')).toMatch(/^\/web-draft\/belleza\/estetica-[1-3]\.jpg$/);
    expect(tradeHeroPhoto('beauty', 'Oasis', 'spa')).toMatch(/^\/web-draft\/belleza\/spa-[1-3]\.jpg$/);
  });

  it('el nombre manda sobre Google, y «belleza» no decide nada', () => {
    expect(beautyPhotoSet('Uñas Marta', 'hair_salon')).toBe('unas');
    expect(beautyPhotoSet('Masajes Zen', 'beauty_salon')).toBe('spa');
    expect(beautyPhotoSet('Estética Ana', null)).toBe('estetica');
    expect(beautyPhotoSet('Peluquería y Estética Ana', 'beauty_salon')).toBe('peluqueria');
    expect(beautyPhotoSet('Salón de Belleza Carmen', 'hair_salon')).toBe('peluqueria');
    expect(beautyPhotoSet('Belleza Lola', 'beauty_salon')).toBe('estetica');
    // «spa» y «uñas» como palabras, no dentro de otra: «España», «Lunas».
    expect(beautyPhotoSet('Peluquería España', null)).toBe('peluqueria');
    expect(beautyPhotoSet('Lunas', 'hair_salon')).toBe('peluqueria');
    // Sin nada, peluquería, que en el sector es casi todo.
    expect(beautyPhotoSet('Liso & Rizo', null)).toBe('peluqueria');
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

  it('una barbería trae los suyos; los oficios y las uñas, nada', () => {
    const b = withSectorExamples(base(), { familia: 'beauty', businessName: 'Barbería El Puerto', primaryType: 'barber_shop' });
    expect(b.bloques.find((x) => x.id === 'servicios-por-persona')?.pestanas.map((p) => p.titulo)).toEqual(['Cortes', 'Barba', 'Combos']);
    expect(b.bloques.some((x) => x.tipo === 'antes_despues')).toBe(false);
    expect(withSectorExamples(base(), { familia: 'trades', businessName: 'Aluminios', primaryType: null })).toEqual(base());
    expect(withSectorExamples(base(), { familia: 'beauty', businessName: 'Nails Bar', primaryType: 'nail_salon' })).toEqual(base());
    // Ni sin tipo de Google, si el nombre lo dice (31/10/2026).
    expect(withSectorExamples(base(), { familia: 'beauty', businessName: 'Nails Bar', primaryType: null })).toEqual(base());
  });

  it('una clínica trae su equipo y sus seguros, de su especialidad, colocados tras sus secciones', () => {
    const dental = withSectorExamples(base(), { familia: 'health', businessName: 'Clínica Dental Sonrisa', primaryType: 'dentist' });
    const equipo = dental.bloques.find((b) => b.id === 'equipo')!;
    expect(equipo.tipo).toBe('catalogo');
    expect(equipo.productos.map((p) => p.descripcion.split('.')[0])).toEqual(['Odontología general', 'Ortodoncia', 'Higiene bucodental']);
    // Sin fotos ni categorías: ni retratos de banco con nombre, ni filtros.
    expect(equipo.productos.every((p) => !p.foto && !p.categoria)).toBe(true);
    expect(dental.bloques.find((b) => b.id === 'seguros')?.tipo).toBe('lista');
    const orden = dental.paginas[0].secciones.map((s) => (s.tipo === 'bloque' ? s.id : s.tipo));
    expect(orden[orden.indexOf('sobre') + 1]).toBe('equipo');
    expect(orden[orden.indexOf('precios') + 1]).toBe('seguros');
    expect(parseSiteContent(dental).ok).toBe(true);

    const vet = withSectorExamples(base(), { familia: 'health', businessName: 'Hospital Veterinario San Bernardo', primaryType: 'veterinary_care' });
    expect(vet.bloques.find((b) => b.id === 'seguros')?.titulo).toBe('Seguros y planes de salud');
    const fisio = withSectorExamples(base(), { familia: 'health', businessName: 'Fisio Arena', primaryType: 'physiotherapist' });
    expect(fisio.bloques.find((b) => b.id === 'seguros')?.items.some((i) => /tráfico/.test(i.texto))).toBe(true);
    // Ningún nombre de aseguradora real, ni de persona inventada.
    const todo = JSON.stringify([dental, vet, fisio].map((c) => c.bloques));
    expect(todo).not.toMatch(/Sanitas|Adeslas|DKV|Asisa|Mapfre|Caser|Mutua Madrile/i);
    for (const c of [dental, vet, fisio]) for (const p of c.bloques.find((b) => b.id === 'equipo')!.productos) expect(p.nombre).toMatch(/Nombre Apellido$/);
  });

  it('en salud se marca cada línea de la lista, que la plantilla solo resalta lo marcado', () => {
    const c = withSectorExamples(base(), { familia: 'health', businessName: 'Consultorio Médico Ejemplo', primaryType: 'doctor' });
    const seguros = c.bloques.find((b) => b.id === 'seguros')!;
    expect(pendingExampleData(c)).toEqual([
      'bloques.equipo.titulo',
      'bloques.seguros.titulo',
      'bloques.seguros.texto',
      ...seguros.items.map((_, i) => `bloques.seguros.items.${i}.texto`),
    ]);
    const home = renderSiteFiles(SITE_TEMPLATE_BASE, c, SAMPLE_RENDER_CONTEXT).find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toMatch(/id="bloque-equipo"><div class="k-dentro"><div class="dato-ejemplo-bloque">/);
    // Tarjetas solo de texto: sin el hueco rayado de la foto que falta.
    const equipo = home.slice(home.indexOf('id="bloque-equipo"'), home.indexOf('</section>', home.indexOf('id="bloque-equipo"')));
    expect(equipo).not.toContain('k-producto-sin-foto');
    expect(equipo).toContain('Nº de colegiado');
    const lista = home.slice(home.indexOf('id="bloque-seguros"'));
    for (const item of seguros.items) expect(lista).toContain(`<span class="dato-ejemplo">${item.texto}</span>`);
  });

  it('un restaurante trae su carta por apartados y su galería de platos, sin repetir la portada', () => {
    const c = withSectorExamples(base(), { familia: 'food', businessName: 'Casa Pepe', primaryType: 'restaurant' });
    const carta = c.bloques.find((b) => b.id === 'carta')!;
    expect(carta.tipo).toBe('pestanas');
    expect(carta.pestanas.map((p) => p.titulo)).toEqual(['Para empezar', 'Principales', 'Postres']);
    // Cada línea, un plato con su precio.
    for (const p of carta.pestanas) for (const linea of p.texto.split('\n')) expect(linea).toMatch(/^- \*\*.+\*\* — .+$/);
    const platos = c.bloques.find((b) => b.id === 'platos')!;
    expect(platos.fotos).toHaveLength(6);
    for (const f of platos.fotos) expect(f.foto).toMatch(/^\/web-draft\/restauracion\/plato-[1-6]\.jpg$/);
    const fotos = c.bloques.flatMap((b) => [...b.fotos.map((f) => f.foto), ...b.pestanas.map((p) => p.foto)]).filter(Boolean);
    for (const f of fotos) expect(existsSync(join(process.cwd(), 'public', f)), f).toBe(true);
    expect(fotos).not.toContain(tradeHeroPhoto('food', 'Casa Pepe', 'restaurant'));
    const orden = c.paginas[0].secciones.map((s) => (s.tipo === 'bloque' ? s.id : s.tipo));
    expect(orden[orden.indexOf('servicios') + 1]).toBe('carta');
    expect(orden[orden.indexOf('sobre') + 1]).toBe('platos');
    expect(pendingExampleData(c)).toEqual(['bloques.carta.titulo', 'bloques.platos.titulo']);
    expect(parseSiteContent(c).ok).toBe(true);
  });

  it('una cafetería y una panadería traen la suya; la carta sustituye a lo que incluye cada servicio', () => {
    const cafe = withSectorExamples(base(), { familia: 'food', businessName: 'Café del Puerto', primaryType: 'cafe' });
    expect(cafe.bloques.find((b) => b.id === 'carta')?.pestanas.map((p) => p.titulo)).toEqual(['Cafés', 'Desayunos', 'Dulces']);
    expect(cafe.bloques.find((b) => b.id === 'platos')?.fotos.every((f) => /\/cafe-\d\.jpg$/.test(f.foto))).toBe(true);
    const pan = withSectorExamples(base(), { familia: 'food', businessName: 'Panadería La Espiga', primaryType: 'cafe' });
    expect(pan.bloques.find((b) => b.id === 'carta')?.pestanas.map((p) => p.titulo)).toEqual(['Panes', 'Bollería', 'Pasteles y encargos']);
    expect(pan.bloques.find((b) => b.id === 'platos')?.fotos.every((f) => /\/obrador-\d\.jpg$/.test(f.foto))).toBe(true);

    const c = base();
    c.bloques.push({ ...vacio(DETAIL_BLOCK_ID, 'pestanas', 'Qué incluye cada servicio'), pestanas: [{ titulo: 'Menú', texto: '- x', foto: '', alt: '' }] });
    c.paginas[0].secciones.splice(3, 0, { tipo: 'bloque', id: DETAIL_BLOCK_ID });
    c.ejemplos = [`bloques.${DETAIL_BLOCK_ID}.titulo`];
    const r = withSectorExamples(c, { familia: 'food', businessName: 'Casa Pepe', primaryType: null });
    expect(r.bloques.some((b) => b.id === DETAIL_BLOCK_ID)).toBe(false);
    expect(r.ejemplos.some((e) => e.includes(DETAIL_BLOCK_ID))).toBe(false);
  });

  it('un despacho trae su equipo y su trayectoria, sin nombres ni años inventados', () => {
    const casos = [
      ['Asesoría Gómez', 'accounting', 'Asesoría fiscal', false],
      ['Bufete Álvarez', null, 'Socia directora', true],
      ['Pérez Abogados', 'lawyer', 'Socia directora', true],
      ['Correduría de Seguros Insular', 'insurance_agency', 'Mediadora de seguros', false],
    ] as const;
    for (const [nombre, tipo, primero, colegiado] of casos) {
      const c = withSectorExamples(base(), { familia: 'professional', businessName: nombre, primaryType: tipo });
      const equipo = c.bloques.find((b) => b.id === 'equipo')!;
      expect(equipo.tipo, nombre).toBe('catalogo');
      expect(equipo.productos[0].descripcion.startsWith(primero), nombre).toBe(true);
      expect(equipo.productos.every((p) => p.nombre === 'Nombre Apellido' && !p.foto && !p.categoria), nombre).toBe(true);
      expect(equipo.productos.every((p) => p.caracteristicas.some((x) => /colegiado nº 0000/.test(x))), nombre).toBe(colegiado);
      const hitos = c.bloques.find((b) => b.id === 'trayectoria')!.hitos;
      expect(hitos.map((h) => h.fecha), nombre).toEqual(['20XX', '20XX', 'Hoy']);
      // Ni «Hoy / Hoy»: la fecha y el título del hito no se repiten.
      expect(hitos.every((h) => h.titulo !== h.fecha), nombre).toBe(true);
      const orden = c.paginas[0].secciones.map((s) => (s.tipo === 'bloque' ? s.id : s.tipo));
      expect(orden.slice(orden.indexOf('sobre') + 1, orden.indexOf('sobre') + 3)).toEqual(['trayectoria', 'equipo']);
      expect(pendingExampleData(c)).toEqual(['bloques.equipo.titulo', 'bloques.trayectoria.titulo']);
      expect(parseSiteContent(c).ok).toBe(true);
    }
  });

  it('una inmobiliaria trae un catálogo de inmuebles en venta y alquiler, con fotos y precios de ejemplo', () => {
    const c = withSectorExamples(base(), { familia: 'professional', businessName: 'Inmobiliaria Costa', primaryType: null });
    expect(c.bloques.some((b) => b.id === 'equipo')).toBe(false);
    const inmuebles = c.bloques.find((b) => b.id === 'inmuebles')!;
    expect(inmuebles.tipo).toBe('catalogo');
    expect(new Set(inmuebles.productos.map((p) => p.categoria))).toEqual(new Set(['Venta', 'Alquiler']));
    for (const p of inmuebles.productos) {
      expect(p.precio).toMatch(/€/);
      expect(existsSync(join(process.cwd(), 'public', p.foto)), p.foto).toBe(true);
    }
    const orden = c.paginas[0].secciones.map((s) => (s.tipo === 'bloque' ? s.id : s.tipo));
    expect(orden[orden.indexOf('servicios') + 1]).toBe('inmuebles');
    expect(pendingExampleData(c)).toEqual(['bloques.inmuebles.titulo']);
    expect(parseSiteContent(c).ok).toBe(true);
    // Y se pinta entero de ejemplo, con sus filtros.
    const home = renderSiteFiles(SITE_TEMPLATE_BASE, c, SAMPLE_RENDER_CONTEXT).find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toMatch(/id="bloque-inmuebles"><div class="k-dentro"><div class="dato-ejemplo-bloque">/);
    expect(home).toContain('k-filtros');
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
    // Cuatro distintas, ninguna de portada (1..3).
    expect(new Set(fotos).size).toBe(4);
    for (const f of fotos) expect(f).toMatch(/^\/web-draft\/oficios\/aluminio-[4-8]\.jpg$/);
    expect(fotos).not.toContain(tradeHeroPhoto('trades', 'Aluminios Telde', null));
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
