import { describe, expect, it } from 'vitest';
import { parseSiteContent } from '@/lib/site-content';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES, sectorSamples } from '@/lib/site-content-samples';

describe('contenidos de muestra por sector', () => {
  it('salud tiene los suyos, válidos y sin rastro de la fontanería', () => {
    const { samples, context } = sectorSamples('health');
    expect(context.negocio.nombre).toBe('Clínica Dental Ejemplo');
    for (const [name, sample] of Object.entries(samples)) {
      expect(parseSiteContent(sample).ok, name).toBe(true);
      const texto = JSON.stringify(sample) + (context.citasHtml ?? '') + (context.resenasHtml ?? '');
      expect(texto, name).not.toMatch(/fontaner|aver[ií]a|desatasc|grifo/i);
    }
  });

  it('el exagerado de salud aguanta los mismos topes que el de oficios', () => {
    const h = sectorSamples('health').samples.exagerado.datos;
    const t = SITE_CONTENT_SAMPLES.exagerado.datos;
    expect(h.servicios).toHaveLength(t.servicios.length);
    expect(h.precios.filas).toHaveLength(t.precios.filas.length);
    expect(h.titular.length).toBeGreaterThanOrEqual(t.titular.length - 5);
    for (const k of Object.keys(t.titulos) as (keyof typeof t.titulos)[]) expect(h.titulos[k].length).toBeGreaterThanOrEqual(t.titulos[k].length - 5);
  });

  it('un sector sin muestra propia usa la de siempre', () => {
    for (const sector of ['trades', null, undefined, 'otro']) {
      expect(sectorSamples(sector).samples).toBe(SITE_CONTENT_SAMPLES);
      expect(sectorSamples(sector).context).toBe(SAMPLE_RENDER_CONTEXT);
    }
  });
});

describe('belleza', () => {
  it('tiene los suyos, válidos y sin rastro de la fontanería', () => {
    const { samples, context } = sectorSamples('beauty');
    expect(context.negocio.nombre).toBe('Peluquería Ejemplo');
    for (const [name, sample] of Object.entries(samples)) {
      expect(parseSiteContent(sample).ok, name).toBe(true);
      const texto = JSON.stringify(sample) + (context.citasHtml ?? '') + (context.resenasHtml ?? '');
      expect(texto, name).not.toMatch(/fontaner|aver[ií]a|desatasc|grifo/i);
    }
  });
});

describe('los bloques del exagerado', () => {
  it.each(['health', 'beauty', 'food', 'professional'])('%s los trae con sus palabras y las mismas medidas que oficios', (sector) => {
    const bloques = sectorSamples(sector).samples.exagerado.bloques;
    const oficio = SITE_CONTENT_SAMPLES.exagerado.bloques;
    // 31/10/2026: «Así quedó el baño de la calle Triana» en un restaurante.
    expect(JSON.stringify(bloques)).not.toMatch(/Triana|baño|ventana|mampara|aluminio|reforma completa|taller|Sebadal|instalador/i);
    expect(bloques.map((b) => [b.id, b.fotos.length, b.productos.length, b.pestanas.length, b.comparativa.filas.length, b.hitos.length])).toEqual(
      oficio.map((b) => [b.id, b.fotos.length, b.productos.length, b.pestanas.length, b.comparativa.filas.length, b.hitos.length]),
    );
    for (const [i, b] of bloques.entries()) if (oficio[i].titulo.length > 60) expect(b.titulo.length, b.id).toBeGreaterThanOrEqual(60);
    expect(parseSiteContent(sectorSamples(sector).samples.exagerado).ok).toBe(true);
  });
});

describe('restauración y profesionales', () => {
  it.each([
    ['food', 'Restaurante Ejemplo'],
    ['professional', 'Asesoría Ejemplo'],
  ])('%s tiene los suyos, válidos y sin rastro de la fontanería', (sector, nombre) => {
    const { samples, context } = sectorSamples(sector);
    expect(context.negocio.nombre).toBe(nombre);
    for (const [name, sample] of Object.entries(samples)) {
      expect(parseSiteContent(sample).ok, name).toBe(true);
      const texto = JSON.stringify(sample) + (context.citasHtml ?? '') + (context.resenasHtml ?? '');
      expect(texto, name).not.toMatch(/fontaner|aver[ií]a|desatasc|grifo/i);
    }
  });
});
