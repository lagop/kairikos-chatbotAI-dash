import { describe, expect, it } from 'vitest';
import { parseSiteContent, publishedEntries, type SiteContent } from '@/lib/site-content';
import { SITE_CONTENT_SAMPLES, SAMPLE_RENDER_CONTEXT } from '@/lib/site-content-samples';
import { buildMenu, entryExcerpt, formatEntryDate, renderSiteFiles, type SiteRenderContext, type SiteTemplateSource } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { renderSiteMarkdown } from '@/lib/site-markdown';
import { publicSiteUrl } from '@/lib/website-publish';

// Webs con IA, entrega 5 (27/10/2026) — varias páginas, blog, mapa del sitio
// y datos estructurados.

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const normal = () => clone(SITE_CONTENT_SAMPLES.normal) as SiteContent;
const published = (over: Partial<SiteRenderContext> = {}): SiteRenderContext => ({
  ...SAMPLE_RENDER_CONTEXT,
  borrador: false,
  bannerHtml: null,
  footerHtml: null,
  resenasHtml: null,
  citasHtml: null,
  atribucionGoogleHtml: null,
  fotos: { portada: 'assets/portada.jpg', equipo: null, trabajo: null },
  ...over,
});
const files = (c: SiteContent, ctx: SiteRenderContext, t: SiteTemplateSource = SITE_TEMPLATE_BASE) =>
  Object.fromEntries(renderSiteFiles(t, c, ctx).map((f) => [f.path, f.content.toString('utf8')]));

describe('el esquema', () => {
  it('una página no puede pisar las rutas del motor', () => {
    const c = normal();
    c.paginas.push({ ruta: 'blog', titulo: 'Blog', metaTitulo: '', metaDescripcion: '', secciones: [] });
    const r = parseSiteContent(c);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.map((i) => i.message)).toContain('reserved_page_path');
  });

  it('dos entradas con la misma dirección no; una dirección pública sin forma, tampoco', () => {
    const c = normal();
    c.blog.entradas[1].slug = c.blog.entradas[0].slug;
    c.urlPublica = 'fontaneria';
    const r = parseSiteContent(c);
    expect(!r.ok && r.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['duplicate_entry_slug', 'invalid_public_url']));
  });

  it('el contenido de antes (sin blog ni dirección) sigue valiendo', () => {
    const c = normal() as Partial<SiteContent>;
    delete c.blog;
    delete c.urlPublica;
    const r = parseSiteContent(c);
    expect(r.ok && r.content.blog).toEqual({ titulo: 'Blog', intro: '', entradas: [] });
  });

  it('las publicadas, de la más nueva a la más vieja; las sin publicar no salen', () => {
    const c = normal();
    c.blog.entradas.push({ ...c.blog.entradas[0], slug: 'a-medias', fecha: '2026-12-01', publicada: false });
    expect(publishedEntries(c).map((e) => e.slug)).toEqual(['como-detectar-una-fuga', 'termo-o-calentador']);
  });
});

describe('las páginas del blog', () => {
  it('lista y artículos, con enlaces relativos a su profundidad y la llamada final debajo', () => {
    const f = files(normal(), published());
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['blog/index.html', 'blog/como-detectar-una-fuga/index.html', 'blog/termo-o-calentador/index.html']));
    const lista = f['blog/index.html'];
    expect(lista).toContain('<h1>Blog</h1>');
    expect(lista.indexOf('como-detectar-una-fuga')).toBeLessThan(lista.indexOf('termo-o-calentador'));
    expect(lista).toContain('href="../blog/como-detectar-una-fuga/"');
    expect(lista).toContain('<time datetime="2026-10-20">20 de octubre de 2026</time>');
    // Sin extracto, el principio del texto.
    expect(lista).toContain('Depende de cuántos son en casa');

    const art = f['blog/como-detectar-una-fuga/index.html'];
    expect(art).toContain('<h1>Cómo saber si tiene una fuga de agua sin romper nada</h1>');
    expect(art).toContain('<h2>Mire el contador</h2>');
    expect(art).toContain('<a class="volver" href="../../blog/">Blog</a>');
    expect(art).toContain('<title>Cómo saber si tiene una fuga de agua sin romper nada</title>');
    expect(art.indexOf('id="articulo"')).toBeLessThan(art.indexOf('id="llamada"'));
    expect(art).toContain('href="../../fuentes/fraunces/fuentes.css"');
  });

  it('sin entradas publicadas no hay blog: ni páginas ni enlace', () => {
    const c = normal();
    c.blog.entradas.forEach((e) => (e.publicada = false));
    const f = files(c, published());
    expect(Object.keys(f).some((p) => p.startsWith('blog/'))).toBe(false);
    expect(f['index.html']).not.toContain('blog/');
  });

  it('una plantilla sin las piezas del blog (de antes de la entrega 5) lo pinta igual, con lo básico', () => {
    const vieja: SiteTemplateSource = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, blog_lista: undefined, blog_articulo: undefined } };
    const f = files(normal(), published(), vieja);
    expect(f['blog/index.html']).toContain('<a href="../blog/termo-o-calentador/">¿Termo eléctrico o calentador de gas?</a>');
    expect(f['blog/termo-o-calentador/index.html']).toContain('<h1>¿Termo eléctrico o calentador de gas?</h1>');
  });
});

describe('el menú', () => {
  it('una página con blog: secciones, Blog y Contacto el último, cinco como mucho; desde el artículo sube de nivel', () => {
    const f = files(normal(), published());
    const nav = (html: string) => /<nav class="menu"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    const home = nav(f['index.html']);
    expect(home.match(/<a /g)).toHaveLength(5);
    expect(home).toMatch(/<a href="blog\/">Blog<\/a><a href="#contacto">Contacto<\/a>$/);
    const art = nav(f['blog/como-detectar-una-fuga/index.html']);
    expect(art).toContain('<a href="../../#servicios">Servicios</a>');
    expect(art).toContain('<a href="../../blog/" aria-current="page">Blog</a>');
  });

  it('varias páginas: las páginas sin la portada, y Blog antes de la última', () => {
    const c = normal();
    c.paginas.push(
      { ruta: 'servicios', titulo: 'Servicios', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'servicios' }] },
      { ruta: 'contacto', titulo: 'Contacto', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'contacto' }] },
    );
    expect(buildMenu(c, { ruta: '' }, []).map((l) => l.titulo)).toEqual(['Servicios', 'Blog', 'Contacto']);
    // Si la última no es la de contacto, Blog va al final.
    c.paginas.pop();
    expect(buildMenu(c, { ruta: '' }, []).map((l) => l.titulo)).toEqual(['Servicios', 'Blog']);
  });
});

describe('la cabecera de las páginas interiores', () => {
  it('una página sin portada lleva su título en un h1; la portada y el blog no la llevan', () => {
    const c = normal();
    c.paginas.push({ ruta: 'desatascos', titulo: 'Desatascos en Telde', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'servicios' }] });
    const f = files(c, published({ legales: true }));
    expect(f['desatascos/index.html']).toMatch(/<header class="cabecera-pagina" id="cabecera">[\s\S]*<h1>Desatascos en Telde<\/h1>/);
    expect(f['index.html']).not.toContain('cabecera-pagina"');
    expect(f['blog/index.html']).not.toContain('cabecera-pagina"');
    // Las legales también, sin repetir el título en el bloque.
    expect(f['aviso-legal/index.html'].match(/Aviso legal<\/h[12]>/g)).toHaveLength(1);
  });

  it('las muestras de varias páginas se pintan sin huecos', () => {
    const f = files(clone(SITE_CONTENT_SAMPLES.exagerado) as SiteContent, SAMPLE_RENDER_CONTEXT);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['servicios/index.html', 'empresa/index.html', 'contacto/index.html', 'blog/entrada-1/index.html']));
    for (const [path, html] of Object.entries(f)) expect(html, path).not.toMatch(/\{\{/);
  });
});

describe('anclas entre páginas', () => {
  it('el «#contacto» de la portada apunta a la página que tiene el formulario', () => {
    const c = normal();
    c.blog.entradas = [];
    c.paginas[0].secciones = c.paginas[0].secciones.filter((s) => s.tipo !== 'contacto');
    c.paginas.push({ ruta: 'contacto', titulo: 'Contacto', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'contacto' }] });
    const f = files(c, published());
    expect(f['index.html']).toContain('href="contacto/#contacto"');
    expect(f['index.html']).not.toContain('href="#contacto"');
    // En la página de contacto, el ancla es suya.
    expect(f['contacto/index.html']).toContain('id="contacto"');
  });

  it('si no lo tiene ninguna, el botón llama por teléfono', () => {
    const c = normal();
    c.blog.entradas = [];
    c.paginas[0].secciones = c.paginas[0].secciones.filter((s) => s.tipo !== 'contacto');
    const f = files(c, published());
    expect(f['index.html']).toContain('href="tel:+34600000000">Escribirnos');
    // Los iconos (#i-…) y el salto al contenido no se tocan.
    expect(f['index.html']).toContain('href="#i-check"');
    expect(f['index.html']).toContain('href="#contenido"');
  });
});

describe('lo que Google necesita de una web publicada', () => {
  const siteUrl = 'https://fontaneria-ejemplo.es/';

  it('canónica, tarjetas para redes y el negocio en datos estructurados en la portada', () => {
    const f = files(normal(), published({ siteUrl }));
    const home = f['index.html'];
    expect(home).toContain('<link rel="canonical" href="https://fontaneria-ejemplo.es/">');
    expect(home).toContain('<meta property="og:image" content="https://fontaneria-ejemplo.es/assets/portada.jpg">');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(home)?.[1] ?? '{}');
    expect(ld).toMatchObject({ '@type': 'LocalBusiness', name: 'Fontanería Ejemplo', url: siteUrl, telephone: '+34600000000' });
    expect(ld).not.toHaveProperty('aggregateRating');
  });

  it('cada artículo: su canónica, og:type article y BlogPosting', () => {
    const art = files(normal(), published({ siteUrl }))['blog/termo-o-calentador/index.html'];
    expect(art).toContain('<link rel="canonical" href="https://fontaneria-ejemplo.es/blog/termo-o-calentador/">');
    expect(art).toContain('<meta property="og:type" content="article">');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(art)?.[1] ?? '{}');
    expect(ld).toMatchObject({ '@type': 'BlogPosting', headline: '¿Termo eléctrico o calentador de gas?', datePublished: '2026-09-02' });
  });

  it('un texto del cliente no puede cerrar el <script> de los datos estructurados', () => {
    const c = normal();
    c.datos.subtitulo = 'Hola </script><script>alert(1)</script>';
    const home = files(c, published({ siteUrl }))['index.html'];
    expect(home).not.toContain('</script><script>alert(1)');
    expect(home).toContain('\\u003c/script>');
  });

  it('sitemap.xml con las páginas y las entradas, y robots.txt que lo señala', () => {
    const f = files(normal(), published({ siteUrl, legales: true }));
    expect(f['sitemap.xml']).toContain('<url><loc>https://fontaneria-ejemplo.es/</loc></url>');
    expect(f['sitemap.xml']).toContain('<url><loc>https://fontaneria-ejemplo.es/blog/</loc><lastmod>2026-10-20</lastmod></url>');
    expect(f['sitemap.xml']).toContain('<loc>https://fontaneria-ejemplo.es/blog/termo-o-calentador/</loc><lastmod>2026-09-02</lastmod>');
    expect(f['sitemap.xml']).not.toContain('aviso-legal');
    expect(f['robots.txt']).toContain('Sitemap: https://fontaneria-ejemplo.es/sitemap.xml');
  });

  it('sin dirección conocida, ni canónica ni mapa; en el borrador, nada de eso', () => {
    const sin = files(normal(), published());
    expect(sin['index.html']).not.toContain('rel="canonical"');
    expect(sin['sitemap.xml']).toBeUndefined();
    expect(sin['index.html']).toContain('<meta property="og:title"');
    const borrador = files(normal(), { ...SAMPLE_RENDER_CONTEXT, siteUrl });
    expect(borrador['index.html']).not.toMatch(/og:title|canonical|ld\+json/);
    expect(borrador['sitemap.xml']).toBeUndefined();
  });

  it('la dirección pública: dominio propio, provisional o la que escribe el cliente', () => {
    const portal = 'https://portal.kairikos.cloud';
    expect(publicSiteUrl({ publishTarget: 'kairikos', slug: 'suarez', customDomain: 'suarez.es' }, '', portal)).toBe('https://suarez.es/');
    expect(publicSiteUrl({ publishTarget: 'kairikos', slug: 'suarez', customDomain: null }, 'https://otra.es', portal)).toBe('https://portal.kairikos.cloud/sitios/suarez/');
    expect(publicSiteUrl({ publishTarget: 'sftp', slug: null, customDomain: null }, 'https://suarez.es', portal)).toBe('https://suarez.es/');
    expect(publicSiteUrl({ publishTarget: 'sftp', slug: null, customDomain: null }, '', portal)).toBeNull();
  });
});

describe('piezas sueltas', () => {
  it('títulos en el texto de una entrada; nunca h1', () => {
    expect(renderSiteMarkdown('## Uno\n\n### Dos\n\n# Tres')).toBe('<h2>Uno</h2>\n<h3>Dos</h3>\n<p># Tres</p>');
  });

  it('el extracto corta en una palabra y quita el formato', () => {
    expect(entryExcerpt({ extracto: '', texto: '## Hola\n\n**Mucho** texto [con enlace](https://a.es) ' + 'palabra '.repeat(40) }, 60)).toMatch(/^Hola Mucho texto con enlace palabra.*…$/);
    expect(formatEntryDate('2026-01-05')).toBe('5 de enero de 2026');
  });

  it('el validador: la base pasa; sin piezas del blog, o con canónica propia, no', () => {
    expect(validateSiteTemplate(SITE_TEMPLATE_BASE).problems).toEqual([]);
    const sinBlog = validateSiteTemplate({ ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, blog_articulo: undefined } });
    expect(sinBlog.problems.join()).toMatch(/falta la sección «blog_articulo»/);
    const canonica = validateSiteTemplate({ ...SITE_TEMPLATE_BASE, marco: SITE_TEMPLATE_BASE.marco.replace('</head>', '<link rel="canonical" href="x">\n</head>') });
    expect(canonica.problems.join()).toMatch(/no pongas <link rel="canonical">/);
    const listaMuda = validateSiteTemplate({ ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, blog_lista: '<section id="{{ancla}}"><h1>{{blog.titulo}}</h1></section>' } });
    expect(listaMuda.problems.join()).toMatch(/blog_lista.*\{\{#entradas\}\}/);
  });
});
