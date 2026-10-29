// La vista previa en vivo del editor (29/10/2026): el modo edición del motor y
// el cuerpo del POST de vista previa.
import { describe, expect, it } from 'vitest';
import { EDIT_MODE_HEAD, renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { parsePreviewOverride } from '@/lib/website-preview';

const home = (edicion?: boolean) =>
  renderSiteFiles(SITE_TEMPLATE_BASE, SITE_CONTENT_SAMPLES.normal, { ...SAMPLE_RENDER_CONTEXT, edicion })
    .find((f) => f.path === 'index.html')!
    .content.toString('utf8');

describe('modo edición del motor', () => {
  it('solo en la vista previa del editor, al principio de <head>', () => {
    const html = home(true);
    expect(html.indexOf(EDIT_MODE_HEAD)).toBeGreaterThan(-1);
    expect(html.indexOf(EDIT_MODE_HEAD)).toBeLessThan(html.indexOf('<style'));
  });

  it('nunca en lo que se publica: la página sale igual que sin él', () => {
    expect(home()).not.toContain('IntersectionObserver=IO');
    expect(home(true).replace(`\n${EDIT_MODE_HEAD}`, '')).toBe(home());
  });
});

describe('el cuerpo del POST de vista previa', () => {
  it('contenido obligatorio; teléfono y dirección opcionales y recortados', () => {
    expect(parsePreviewOverride(null)).toBeNull();
    expect(parsePreviewOverride({ phone: '600' })).toBeNull();
    expect(parsePreviewOverride({ content: 'x' })).toBeNull();
    expect(parsePreviewOverride({ content: { datos: {} }, phone: '  ', address: 'a'.repeat(500) })).toEqual({ content: { datos: {} }, phone: null, address: 'a'.repeat(300) });
  });
});
