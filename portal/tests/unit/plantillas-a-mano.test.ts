import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_TEMPLATE_PARTS, renderSiteFiles, type SiteTemplatePart, type SiteTemplateSource } from '@/lib/site-template';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
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
  return { marco: read('marco'), secciones };
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
    });
  }
});
