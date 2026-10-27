import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { applyTemplateEdits, estimateCostUsd, parseRepairResponse, parseTemplateResponse } from '@/lib/site-template-ai';
import { summarizeCheckRuns, contrastRatio } from '@/lib/site-template-checks';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SITE_TEMPLATE_PARTS } from '@/lib/site-template';

describe('parseTemplateResponse', () => {
  const serialized = ['===MARCO===', SITE_TEMPLATE_BASE.marco, ...SITE_TEMPLATE_PARTS.map((p) => `===SECCION ${p}===\n${SITE_TEMPLATE_BASE.secciones[p]}`)].join('\n');

  it('recupera el marco y todas las secciones', () => {
    const t = parseTemplateResponse(serialized);
    expect(t?.marco).toBe(SITE_TEMPLATE_BASE.marco);
    for (const p of SITE_TEMPLATE_PARTS) expect(t?.secciones[p]).toBe(SITE_TEMPLATE_BASE.secciones[p]);
  });

  it('aguanta vallas de markdown alrededor del todo y de cada pieza', () => {
    const fenced = '```html\n===MARCO===\n```html\n<html></html>\n```\n===SECCION portada===\n<section id="{{ancla}}"></section>\n```';
    const t = parseTemplateResponse(fenced);
    expect(t?.marco).toBe('<html></html>');
    expect(t?.secciones.portada).toBe('<section id="{{ancla}}"></section>');
  });

  it('sin marco no hay plantilla', () => {
    expect(parseTemplateResponse('Aquí tienes la plantilla: …')).toBeNull();
    expect(parseTemplateResponse('===SECCION portada===\n<section></section>')).toBeNull();
  });
});

describe('ronda de corrección', () => {
  it('interpreta el JSON y descarta cambios mal formados', () => {
    const r = parseRepairResponse(
      '```json\n{"diagnostico":"auto-fill","cambios":[{"pieza":"marco","buscar":"a","reemplazar":"b"},{"pieza":"x"},{"pieza":"servicios","buscar":"","reemplazar":"c"}]}\n```',
    );
    expect(r?.diagnostico).toBe('auto-fill');
    expect(r?.cambios).toEqual([{ pieza: 'marco', buscar: 'a', reemplazar: 'b' }]);
    expect(parseRepairResponse('no es json')).toBeNull();
  });

  it('aplica solo los cambios que aparecen exactamente una vez, y escribe piezas que faltaban', () => {
    const base = { marco: '<style>.a{}</style><p>uno</p><p>uno</p>', secciones: { portada: '<section id="{{ancla}}">x</section>' } };
    const { template, applied, failed } = applyTemplateEdits(base, [
      { pieza: 'marco', buscar: '</style>', reemplazar: '.b{}\n</style>' },
      { pieza: 'marco', buscar: '<p>uno</p>', reemplazar: '<p>dos</p>' },
      { pieza: 'faq', buscar: '(vacía)', reemplazar: '<section id="{{ancla}}">faq</section>' },
      { pieza: 'inventada' as never, buscar: 'x', reemplazar: 'y' },
    ]);
    expect(applied).toBe(2);
    expect(template.marco).toContain('.b{}\n</style>');
    expect(template.marco).toContain('<p>uno</p><p>uno</p>');
    expect(template.secciones.faq).toBe('<section id="{{ancla}}">faq</section>');
    expect(failed).toEqual(['«<p>uno</p>» aparece 2 veces en marco', 'pieza desconocida «inventada»']);
    // No toca la plantilla original.
    expect(base.secciones).not.toHaveProperty('faq');
  });

  it('calcula el coste con los precios de cada modelo', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', { input_tokens: 4597, output_tokens: 25472 })).toBe(0.2639);
    expect(estimateCostUsd('modelo-desconocido', { output_tokens: 1 })).toBeNull();
  });
});

describe('summarizeCheckRuns', () => {
  it('el mismo fallo en varias pasadas sale una vez, con dónde se vio', () => {
    const out = summarizeCheckRuns([
      { ancho: 360, contenido: 'normal', problemas: ['Desborde: la página mide 389 px y la ventana 360.'] },
      { ancho: 1100, contenido: 'exagerado', problemas: ['Desborde: la página mide 1135 px y la ventana 1085.', 'Contraste insuficiente (2.20)'] },
      { ancho: 1280, contenido: 'minimo', problemas: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/389 px.*\(visto a 360 px, contenido normal; 1100 px, contenido exagerado\)/);
  });

  it('el contraste se calcula como WCAG', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 0);
    expect(contrastRatio({ r: 13, g: 38, b: 51, a: 1 }, { r: 232, g: 121, b: 58, a: 1 })).toBeGreaterThan(4.5);
  });
});

