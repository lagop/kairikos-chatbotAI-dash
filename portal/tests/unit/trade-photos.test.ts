import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRADE_PHOTO_COUNTS, tradeHeroPhoto, tradePhotoSet, type TradePhotoSet } from '@/lib/trade-photos';

const DIR = join(process.cwd(), 'public', 'web-draft', 'oficios');

describe('fotos de oficio', () => {
  it('están todas en public/ y ninguna sobra ni pesa de más', () => {
    const expected = Object.entries(TRADE_PHOTO_COUNTS).flatMap(([set, n]) => Array.from({ length: n }, (_, i) => `${set}-${i + 1}.jpg`));
    expect(readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort()).toEqual(expected.sort());
    // Se sirven en el móvil del prospecto, a veces con mala cobertura.
    for (const f of expected) expect(statSync(join(DIR, f)).size).toBeLessThan(400 * 1024);
  });

  // Nombres reales de prospectos de producción (28/10/2026).
  const cases: [string, string | null, TradePhotoSet | null][] = [
    ['Aluminios Marrero', 'manufacturer', 'aluminio'],
    ['Carpintería de Aluminio Luis Santana', 'manufacturer', 'aluminio'],
    ['Talleres Camacho Carpinteria de Aluminio', 'manufacturer', 'aluminio'],
    ['Carpintería Metálica Cristalería MEDINA', 'manufacturer', 'aluminio'],
    ['Sin Fin PVC SL', 'manufacturer', 'aluminio'],
    ['CARPINTERÍA CANARIAS - Carpintería de Madera', 'manufacturer', 'carpinteria'],
    ['Yuba Solar', 'service', 'solar'],
    ['Grupo Cymasol Renovables S.L.', 'service', 'solar'],
    ['Reformas Atlantico - Empresa de Reformas en Las Palmas', 'service', 'reformas'],
    ['ESCAYOLAS Y REFORMAS BOLAÑOS. SL', 'service', 'reformas'],
    ['Desatascos Jumbo', 'service', 'fontaneria'],
    ['Electrolabat', 'service', 'electricidad'],
    ['Taller Chapa y Pintura Hermanos', 'car_repair', 'taller'],
    // El nombre no dice nada: manda el tipo de Google.
    ['Hermanos Pérez', 'plumber', 'fontaneria'],
    ['Juan y Ana', 'locksmith', 'cerrajeria'],
    ['Construmax', 'general_contractor', 'reformas'],
    // Ni el nombre ni el tipo: la foto genérica de siempre.
    ['Oficina Endesa Octavio Guerra', 'service', null],
    ['José Diepa Perera', 'manufacturer', null],
    ['Huve', null, null],
  ];
  it.each(cases)('%s (%s) → %s', (name, type, set) => {
    expect(tradePhotoSet(name, type)).toBe(set);
  });

  it('el mismo negocio, la misma foto; otros negocios, fotos distintas', () => {
    const a = tradeHeroPhoto('trades', 'Aluminios Marrero', 'manufacturer');
    expect(a).toMatch(/^\/web-draft\/oficios\/aluminio-[123]\.jpg$/);
    expect(tradeHeroPhoto('trades', 'ALUMINIOS MARRERO ', 'manufacturer')).toBe(a);
    const many = new Set(['Aluminios Marrero', 'Aluminios Beyra', 'Aluminios Armas', 'Aluminios Schamann', 'Aluminios Breval', 'Aluminios RMG'].map((n) => tradeHeroPhoto('trades', n, null)));
    expect(many.size).toBeGreaterThan(1);
  });

  it('solo en oficios, y lo que no se reconoce cae a la del sector', () => {
    // Una peluquería que se llame «Solar» no sale con placas: sale con la suya.
    expect(tradeHeroPhoto('beauty', 'Peluquería Solar', 'hair_salon')).toMatch(/^\/web-draft\/belleza\/peluqueria-/);
    expect(tradeHeroPhoto('trades', 'Huve', null)).toBeNull();
    for (const [set, n] of Object.entries(TRADE_PHOTO_COUNTS)) {
      for (let i = 1; i <= n; i++) expect(existsSync(join(DIR, `${set}-${i}.jpg`))).toBe(true);
    }
  });
});
