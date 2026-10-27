import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SITE_FONT_CATALOG } from '@/lib/site-fonts-catalog';
import { declaredFontFamilies, googleFontFamilies, linkedFontSlugs, localizeGoogleFonts } from '@/lib/site-fonts';
import { renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SITE_CONTENT_SAMPLES, SAMPLE_RENDER_CONTEXT } from '@/lib/site-content-samples';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { renderWebDraftHtml, themeForVariant } from '@/lib/web-draft-html';
import { buildDesignedWebsiteFiles, buildWebsiteFiles, hasPortalReferences } from '@/lib/website-build';

// Webs con IA (27/10/2026) — ninguna web nuestra le pide nada a Google al
// cargarse: las tipografías salen de la propia web (site-fonts.ts).
const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;

describe('el catálogo', () => {
  it('todos sus archivos están en public/fuentes (si no, la web cae a la tipografía de respaldo)', () => {
    for (const font of Object.values(SITE_FONT_CATALOG)) {
      for (const file of ['fuentes.css', ...font.files]) {
        expect(existsSync(path.join(process.cwd(), 'public', 'fuentes', font.slug, file)), `${font.slug}/${file}`).toBe(true);
      }
    }
  });

  it('cubre las tipografías del borrador de siempre y de la plantilla base', () => {
    for (const family of ['beauty', 'trades', 'health', 'food', 'professional']) {
      const heading = themeForVariant(`${family}-1`).theme.headingFont.split(':')[0].replace(/\+/g, ' ');
      expect(SITE_FONT_CATALOG, heading).toHaveProperty([heading]);
    }
    expect(declaredFontFamilies(SITE_TEMPLATE_BASE.marco)).toEqual({ known: ['Fraunces', 'Inter'], unknown: [] });
  });
});

describe('localizeGoogleFonts', () => {
  const head =
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&amp;family=Comic+Neue&family=Source+Sans+3:wght@400&display=swap" rel="stylesheet">';

  it('lee las familias de css2, con &amp; y ejes', () => {
    expect(googleFontFamilies('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&amp;family=Source+Sans+3')).toEqual(['Fraunces', 'Source Sans 3']);
  });

  it('cambia el enlace por las hojas propias y quita los preconnect; lo que no está en el catálogo no se sirve', () => {
    const out = localizeGoogleFonts(head, '../');
    expect(out).not.toMatch(GOOGLE);
    expect(out).toContain('<link rel="stylesheet" href="../fuentes/fraunces/fuentes.css">');
    expect(out).toContain('<link rel="stylesheet" href="../fuentes/source-sans-3/fuentes.css">');
    expect(out).not.toContain('comic');
    expect(linkedFontSlugs(out)).toEqual(['fraunces', 'source-sans-3']);
  });
});

describe('las páginas pintadas', () => {
  it('la web publicada enlaza sus tipografías relativas a cada página, también las legales', () => {
    const files = renderSiteFiles(SITE_TEMPLATE_BASE, SITE_CONTENT_SAMPLES.normal, { ...SAMPLE_RENDER_CONTEXT, borrador: false, legales: true });
    for (const f of files) expect(f.content.toString('utf8'), f.path).not.toMatch(GOOGLE);
    expect(files[0].content.toString('utf8')).toContain('href="fuentes/inter/fuentes.css"');
    expect(files.find((f) => f.path === 'aviso-legal/index.html')?.content.toString('utf8')).toContain('href="../fuentes/inter/fuentes.css"');
  });

  it('el borrador las toma del portal', () => {
    const [index] = renderSiteFiles(SITE_TEMPLATE_BASE, SITE_CONTENT_SAMPLES.normal, SAMPLE_RENDER_CONTEXT);
    expect(index.content.toString('utf8')).toContain('href="/fuentes/fraunces/fuentes.css"');
  });

  it('el borrador de siempre tampoco llama a Google', () => {
    const html = renderWebDraftHtml({
      subject: { businessName: 'X', primaryType: 'plumber', city: null, address: null, phone: null, rating: null, reviewCount: null },
      copy: { headline: 'H', subheadline: 'S', about: 'A', services: [{ name: 'N', description: 'D' }], callToAction: 'C' },
      themeKey: 'beauty-1',
      generatedAt: new Date('2026-10-27'),
    });
    expect(html).not.toMatch(GOOGLE);
    expect(html).toContain('href="/fuentes/inter/fuentes.css"');
  });
});

describe('la web publicada lleva sus tipografías', () => {
  it('con plantilla: los .css y .woff2 de las familias que enlaza, y ningún enlace al portal', async () => {
    const files = await buildDesignedWebsiteFiles({
      template: SITE_TEMPLATE_BASE,
      content: SITE_CONTENT_SAMPLES.normal,
      businessName: 'Fontanería Ejemplo',
      themeKey: 'trades-1',
      phone: null,
      address: null,
      now: new Date('2026-10-27'),
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('fuentes/fraunces/fuentes.css');
    for (const file of SITE_FONT_CATALOG.Inter.files) expect(paths).toContain(`fuentes/inter/${file}`);
    expect(paths.some((p) => p.startsWith('fuentes/playfair'))).toBe(false);
    for (const f of files.filter((x) => x.path.endsWith('.html'))) expect(hasPortalReferences(f.content.toString('utf8')), f.path).toBe(false);
  });

  it('la de siempre: igual, con las rutas pasadas a relativas', async () => {
    const files = await buildWebsiteFiles({
      businessName: 'Fontanería Ejemplo',
      primaryType: 'plumber',
      themeKey: 'trades-2',
      phone: null,
      address: null,
      city: null,
      copy: { headline: 'H', subheadline: 'S', about: 'A', services: [{ name: 'N', description: 'D' }], callToAction: 'C' },
      generatedAt: new Date('2026-10-27'),
    });
    const index = files[0].content.toString('utf8');
    expect(index).toContain('href="fuentes/inter/fuentes.css"');
    expect(hasPortalReferences(index)).toBe(false);
    expect(files.map((f) => f.path)).toContain('fuentes/inter/fuentes.css');
  });
});

describe('validateSiteTemplate y las tipografías', () => {
  const withHead = (extra: string) => ({ ...SITE_TEMPLATE_BASE, marco: SITE_TEMPLATE_BASE.marco.replace('</head>', `${extra}\n</head>`) });

  it('una familia fuera del catálogo no pasa', () => {
    const r = validateSiteTemplate(withHead('<link href="https://fonts.googleapis.com/css2?family=Comic+Neue&display=swap" rel="stylesheet">'));
    expect(r.problems.join()).toMatch(/Comic Neue no están en el catálogo/);
  });

  it('ni un .woff2 de gstatic ni un @import de Google', () => {
    const r = validateSiteTemplate(
      withHead('<link rel="preload" href="https://fonts.gstatic.com/s/inter/v1/x.woff2" as="font"><style>@import url(https://fonts.googleapis.com/css2?family=Inter);</style>'),
    );
    expect(r.problems.join()).toMatch(/enlaza fonts\.gstatic\.com\/s\/inter/);
    expect(r.problems.join()).toMatch(/url\(\) o @import/);
  });
});
