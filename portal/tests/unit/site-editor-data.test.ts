import { describe, expect, it } from 'vitest';
import { templateExtraFields } from '@/lib/site-editor-data';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

// 03/11/2026 — el editor enseña los campos que solo pintan algunas plantillas
// cuando la del cliente los usa.
describe('templateExtraFields', () => {
  it('la plantilla base no usa ninguno', () => {
    expect(templateExtraFields(SITE_TEMPLATE_BASE)).toEqual([]);
  });

  it('los encuentra en cualquier etiqueta, y el icono solo en las partes del proceso', () => {
    const t = {
      marco: '<p>{{#guardia}}{{guardia}}{{/guardia}}</p>',
      secciones: {
        portada: '{{#sellos.length}}x{{/sellos.length}}',
        servicios: '{{#servicios}}{{icono}}{{/servicios}}',
        zona: '{{#zona.lugares}}{{#tiempo}}{{tiempo}}{{/tiempo}}{{/zona.lugares}}',
      },
    };
    expect(templateExtraFields(t)).toEqual(['sellos', 'guardia', 'zona.tiempo']);
    expect(templateExtraFields({ ...t, secciones: { ...t.secciones, 'proceso@lineal': '{{#proceso}}{{{icono}}}{{/proceso}}' } })).toContain('proceso.icono');
    // «tiempos» o «guardias» no cuentan: el campo entero.
    expect(templateExtraFields({ marco: '{{guardias}} {{tiempos}}', secciones: {} })).toEqual([]);
  });
});
