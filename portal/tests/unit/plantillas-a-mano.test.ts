import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_TEMPLATE_PARTS, renderSiteFiles, type SiteTemplatePart, type SiteTemplateSource } from '@/lib/site-template';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES, sectorSamples } from '@/lib/site-content-samples';
import { templateIconIds } from '@/lib/web-draft-design';

// Las plantillas escritas a mano (portal/plantillas/, scripts/plantilla-a-mano.ts)
// tienen que pasar el mismo validador que las de la IA, también después de
// que alguien las retoque. Las comprobaciones con navegador no corren aquí
// (no hay DOM): esas se pasan con el script antes de subirlas.

const DIR = join(__dirname, '..', '..', 'plantillas');

function load(name: string): SiteTemplateSource {
  const read = (part: string) => {
    const file = join(DIR, name, `${part}.html`);
    return existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() : '';
  };
  const secciones: Partial<Record<SiteTemplatePart, string>> = {};
  for (const part of SITE_TEMPLATE_PARTS) if (read(part)) secciones[part] = read(part);
  // La declaración de estilo (site-style.ts) va en plantilla.json y la
  // valida validateSiteTemplate con lo demás.
  const meta = JSON.parse(readFileSync(join(DIR, name, 'plantilla.json'), 'utf8')) as { estilo?: SiteTemplateSource['estilo'] };
  return { marco: read('marco'), secciones, estilo: meta.estilo ?? null };
}

const names = readdirSync(DIR).filter((n) => existsSync(join(DIR, n, 'plantilla.json')));

describe('plantillas escritas a mano', () => {
  it('hay alguna', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    describe(name, () => {
      const template = load(name);
      const meta = JSON.parse(readFileSync(join(DIR, name, 'plantilla.json'), 'utf8')) as Record<string, unknown>;

      it('pasa el validador sin quitarle nada', () => {
        const v = validateSiteTemplate(template);
        expect(v.problems).toEqual([]);
        expect(v.removedAttributes).toEqual([]);
      });

      it('trae nombre, sector y un encargo que se entiende', () => {
        expect(meta.nombre).toEqual(expect.any(String));
        expect(meta.sector).toEqual(expect.any(String));
        expect(String(meta.encargo).length).toBeGreaterThan(40);
      });

      it('pinta los tres contenidos de muestra y ofrece los iconos de siempre', () => {
        for (const sample of Object.values(SITE_CONTENT_SAMPLES)) {
          const files = renderSiteFiles(template, sample, SAMPLE_RENDER_CONTEXT);
          const home = files.find((f) => f.path === 'index.html')?.content.toString('utf8') ?? '';
          expect(home).toContain('id="kairikos-form"');
          expect(home).not.toMatch(/\{\{/);
        }
        expect(templateIconIds(template.marco)).toEqual(expect.arrayContaining(['check', 'telefono', 'estrella', 'herramienta', 'casa', 'reloj']));
      });

      // 30/10/2026 — el laboratorio la enseña con el texto de su sector: los
      // iconos de ese texto (un diente en salud) tienen que existir en ella.
      it('pinta los contenidos de muestra de su sector con iconos que tiene', () => {
        const { samples, context } = sectorSamples(String(meta.sector));
        const icons = templateIconIds(template.marco);
        for (const sample of Object.values(samples)) {
          const home = renderSiteFiles(template, sample, context).find((f) => f.path === 'index.html')?.content.toString('utf8') ?? '';
          expect(home).toContain('id="kairikos-form"');
          expect(home).not.toMatch(/\{\{/);
          for (const s of sample.datos.servicios) if (s.icono) expect(icons).toContain(s.icono);
        }
      });

      it('con logo subido, la cabecera lo enseña en vez del nombre, también en las páginas interiores', () => {
        const logo = 'assets/subidas/0123456789abcdef01.png';
        const portada = 'assets/subidas/abcdefabcdefabcdef.jpg';
        const content = { ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo, portada } };
        const files = renderSiteFiles(template, content, SAMPLE_RENDER_CONTEXT);
        const home = files.find((f) => f.path === 'index.html')?.content.toString('utf8') ?? '';
        const marca = home.match(/<a class="marca[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
        expect(marca).toContain(`<img src="${logo}"`);
        expect(marca).not.toContain('<span>');
        // La portada propia sustituye a la de su oficio.
        expect(home).toContain(`src="${portada}"`);
        expect(home).not.toContain('assets/portada.jpg');
        const inner = files.find((f) => f.path.startsWith('blog/') && f.path.endsWith('index.html'))?.content.toString('utf8') ?? '';
        expect(inner).toContain(`../${logo}`);
      });

      it('si admite el color del negocio, no le queda ningún color del acento escrito a mano', () => {
        if (!template.estilo?.acento) return;
        // Un tono del acento escrito tal cual (una sombra, un hover) no
        // seguiría al color del negocio: se quedaría del color original en una
        // web azul. Tienen que salir de la variable (color-mix).
        const all = [template.marco, ...Object.values(template.secciones)].join('\n');
        const css = all.replace(/:root\{[^}]*\}/, '');
        for (const m of template.estilo.acento.muestras.slice(0, 1)) {
          expect(css.toLowerCase()).not.toContain(m.color.toLowerCase());
        }
      });
    });
  }
});
