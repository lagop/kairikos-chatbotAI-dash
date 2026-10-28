import { describe, expect, it } from 'vitest';
import { renderRichBlock, richBlockHasContent, type RichBlockInput } from '@/lib/site-rich-blocks';
import { parseSiteContent, referencedUploads, type SiteContent } from '@/lib/site-content';
import { renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

const foto = 'assets/subidas/0123456789abcdef01.webp';
const block = (over: Partial<RichBlockInput>): RichBlockInput => ({ id: 'b', tipo: 'galeria', titulo: '', texto: '', fotos: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], ...over });

describe('renderRichBlock', () => {
  it('galería: cada foto enlaza a sí misma (sin JavaScript se abre igual) y sube de nivel en una página interior', () => {
    const html = renderRichBlock(block({ fotos: [{ foto, alt: 'Ventana', texto: 'En Telde' }, { foto: '', alt: '', texto: '' }] }), '../');
    expect(html).toContain(`<a class="k-galeria-foto" href="../${foto}" data-k-galeria="b" data-k-pie="En Telde"><img src="../${foto}" alt="Ventana"`);
    // La vacía no sale.
    expect(html.match(/<li>/g)).toHaveLength(1);
  });

  it('escapa todo lo que escribe el cliente', () => {
    const html = renderRichBlock(
      block({ tipo: 'catalogo', titulo: '<script>x</script>', productos: [{ nombre: '"><img onerror=x>', categoria: 'A&B', foto: '', alt: '', descripcion: '', caracteristicas: ['<b>'], precio: '' }] }),
      '',
    );
    expect(html).not.toMatch(/<script>|<img onerror|<b>/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('antes y después: el comparador con sus etiquetas; con una sola foto, la foto sola', () => {
    const two = renderRichBlock(block({ tipo: 'antes_despues', fotos: [{ foto, alt: 'baño', texto: '' }, { foto, alt: 'baño', texto: 'Reformado' }] }), '');
    expect(two).toContain('class="k-comparador" style="--k-pos:50%"');
    expect(two).toContain('>Antes</span>');
    expect(two).toContain('>Reformado</span>');
    expect(two).toContain('type="range"');
    const one = renderRichBlock(block({ tipo: 'antes_despues', fotos: [{ foto, alt: 'baño', texto: '' }] }), '');
    expect(one).toContain('k-comparador-sola');
    expect(one).not.toContain('type="range"');
  });

  it('catálogo: filtros solo con dos categorías o más, y ocultos hasta que arranque el JavaScript', () => {
    const p = (categoria: string) => ({ nombre: 'Modelo', categoria, foto: '', alt: '', descripcion: '', caracteristicas: [], precio: 'desde 300 €' });
    const una = renderRichBlock(block({ tipo: 'catalogo', productos: [p('Ventanas'), p('Ventanas')] }), '');
    expect(una).not.toContain('k-filtros');
    const dos = renderRichBlock(block({ tipo: 'catalogo', productos: [p('Ventanas'), p('Puertas de paso')] }), '');
    expect(dos).toContain('<div class="k-filtros" role="group" aria-label="Filtrar por categoría" hidden>');
    expect(dos).toContain('data-k-filtro="puertas-de-paso"');
    expect(dos).toContain('data-k-categoria="puertas-de-paso"');
    expect(dos).toContain('<p class="k-precio">desde 300 €</p>');
  });

  it('un bloque sin fotos ni modelos no tiene nada que enseñar', () => {
    expect(richBlockHasContent(block({ fotos: [{ foto: '', alt: '', texto: 'x' }] }))).toBe(false);
    expect(richBlockHasContent(block({ tipo: 'catalogo' }))).toBe(false);
  });
});

describe('en la web', () => {
  const content = (bloques: SiteContent['bloques']): SiteContent => ({
    ...SITE_CONTENT_SAMPLES.normal,
    bloques: [...SITE_CONTENT_SAMPLES.normal.bloques, ...bloques],
    paginas: [{ ...SITE_CONTENT_SAMPLES.normal.paginas[0], secciones: [...SITE_CONTENT_SAMPLES.normal.paginas[0].secciones, ...bloques.map((b) => ({ tipo: 'bloque' as const, id: b.id }))] }],
  });
  const galeria = { id: 'obras', tipo: 'galeria' as const, titulo: 'Obras', texto: '', foto: '', fotoAlt: '', items: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], fotos: [{ foto, alt: 'x', texto: '' }] };

  it('cualquier plantilla los pinta, con su estilo y su script, y solo en las páginas que los llevan', () => {
    const files = renderSiteFiles(SITE_TEMPLATE_BASE, content([galeria]), SAMPLE_RENDER_CONTEXT);
    const home = files.find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toContain('id="bloque-obras"');
    // El estilo base va ANTES del de la plantilla, para que la plantilla gane.
    expect(home.indexOf('id="bloques-kairikos"')).toBeLessThan(home.indexOf('<style>'));
    expect(home).toContain('a[data-k-galeria]');
    const sin = renderSiteFiles(SITE_TEMPLATE_BASE, SITE_CONTENT_SAMPLES.normal, SAMPLE_RENDER_CONTEXT).find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(sin).not.toContain('bloques-kairikos');
  });

  it('las fotos de los bloques ricos viajan con la web y no admiten URLs ajenas', () => {
    const c = content([galeria, { ...galeria, id: 'cat', tipo: 'catalogo', fotos: [], productos: [{ nombre: 'M', categoria: '', foto: 'assets/subidas/abcdefabcdefabcdef.jpg', alt: '', descripcion: '', caracteristicas: [], precio: '' }] }]);
    expect(parseSiteContent(c).ok).toBe(true);
    expect(referencedUploads(c)).toEqual(expect.arrayContaining([foto, 'assets/subidas/abcdefabcdefabcdef.jpg']));
    const ajena = content([{ ...galeria, fotos: [{ foto: 'https://otra-web.com/x.jpg', alt: '', texto: '' }] }]);
    expect(parseSiteContent(ajena).ok).toBe(false);
  });
});

describe('tanda 2', () => {
  const vacio = { pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [] };

  it('pestañas: sin JavaScript, secciones con su título; el script las convierte', () => {
    const html = renderRichBlock(
      block({ ...vacio, tipo: 'pestanas', pestanas: [{ titulo: 'Particulares', texto: '**Hola**', foto, alt: 'x' }, { titulo: 'Empresas', texto: 'Adiós', foto: '', alt: '' }] }),
      '',
    );
    expect(html).toContain('<div class="k-pestanas" data-k-pestanas>');
    expect(html).toContain('<h3 class="k-panel-titulo">Particulares</h3>');
    expect(html).toContain('data-k-titulo="Empresas"');
    expect(html).toContain('<strong>Hola</strong>');
  });

  it('comparativa: «sí» y «no» como marca con su texto para lectores; lo demás tal cual; la columna resaltada', () => {
    const html = renderRichBlock(
      block({ ...vacio, tipo: 'comparativa', comparativa: { columnas: ['PVC', 'Aluminio'], destacada: 1, filas: [{ concepto: 'Aislamiento', valores: ['Sí', '30 años'] }, { concepto: 'Precio', valores: ['no', ''] }] } }),
      '',
    );
    expect(html).toContain('<th scope="col" class="k-destacada">Aluminio</th>');
    expect(html).toContain('<span class="k-si" role="img" aria-label="Sí"></span>');
    expect(html).toContain('<span class="k-no" role="img" aria-label="No"></span>');
    expect(html).toContain('data-k-columna="Aluminio" class="k-destacada">30 años</td>');
    expect(html).toMatch(/data-k-columna="Aluminio" class="k-destacada"><\/td>/);
  });

  it('trayectoria y marcas; con más de cuatro marcas, en cinta con la copia oculta a los lectores', () => {
    const t = renderRichBlock(block({ ...vacio, tipo: 'trayectoria', hitos: [{ fecha: '1998', titulo: 'Abrimos', texto: '' }] }), '');
    expect(t).toContain('<p class="k-hito-fecha">1998</p>');
    const pocas = renderRichBlock(block({ ...vacio, tipo: 'marcas', fotos: Array.from({ length: 3 }, () => ({ foto, alt: 'Marca', texto: '' })) }), '');
    expect(pocas).not.toContain('k-marcas--cinta');
    const muchas = renderRichBlock(block({ ...vacio, tipo: 'marcas', fotos: Array.from({ length: 6 }, () => ({ foto, alt: 'Marca', texto: '' })) }), '');
    expect(muchas).toContain('k-marcas--cinta');
    expect(muchas).toContain('<ul class="k-marcas-pista" aria-hidden="true">');
    expect(muchas.split('aria-hidden="true">')[1]).not.toContain('alt="Marca"');
  });

  it('vacíos no se pintan', () => {
    expect(richBlockHasContent(block({ ...vacio, tipo: 'pestanas' }))).toBe(false);
    expect(richBlockHasContent(block({ ...vacio, tipo: 'comparativa', comparativa: { columnas: ['A'], destacada: -1, filas: [] } }))).toBe(false);
    expect(richBlockHasContent(block({ ...vacio, tipo: 'trayectoria' }))).toBe(false);
    expect(richBlockHasContent(block({ ...vacio, tipo: 'marcas' }))).toBe(false);
  });
});
