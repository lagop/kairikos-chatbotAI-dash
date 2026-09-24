// =============================================================================
// A10 — unit tests de las estadísticas de mercado.
//
// Lo que se fija:
//
// 1. Que un grupo pequeño NO se publique. Con tres negocios, "el 33 % no
//    tiene web" es uno solo y el que lo lea puede deducir cuál. Esto agrega a
//    través de todos los clientes, así que la discreción no es un adorno.
// 2. Que las reseñas se resuman con la MEDIANA. Un negocio con 1.129 reseñas
//    entre nueve con 20 desplaza la media hasta volverla inútil.
// 3. Que un "sin dato" no cuente como cero, igual que en el resto del repo.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { aggregateSectorStats, buildSectorStatsCsv, MIN_GROUP_SIZE } from '@/lib/sector-stats';

function negocio(over: Record<string, unknown> = {}) {
  return {
    searchCategory: 'peluquerías',
    searchLocation: 'Las Palmas',
    contactName: 'Negocio Ejemplo',
    website: null,
    rating: 4.5,
    reviewCount: 20,
    ...over,
  } as Parameters<typeof aggregateSectorStats>[0][number];
}

function grupo(n: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => negocio({ contactName: `Negocio ${i}`, ...over }));
}

describe('aggregateSectorStats', () => {
  it('un grupo por debajo del mínimo no se publica', () => {
    expect(aggregateSectorStats(grupo(MIN_GROUP_SIZE - 1))).toEqual([]);
  });

  it('a partir del mínimo sí', () => {
    const rows = aggregateSectorStats(grupo(MIN_GROUP_SIZE));
    expect(rows).toHaveLength(1);
    expect(rows[0].negocios).toBe(MIN_GROUP_SIZE);
  });

  it('separa web propia, ficha de directorio y sin web', () => {
    const rows = aggregateSectorStats([
      ...grupo(4, { contactName: 'Peluquería Aurora', website: 'https://peluqueriaaurora.es' }),
      ...grupo(4, { contactName: 'Otra', website: 'https://directorio.example/peluquerias/gc/otra' }),
      ...grupo(4, { website: null }),
    ]);
    expect(rows[0]).toMatchObject({ conWebPropia: 4, conFichaDeDirectorio: 4, sinWeb: 4 });
  });

  it('resume las reseñas con la mediana, que no la desplaza un gigante', () => {
    const rows = aggregateSectorStats([
      ...grupo(9, { reviewCount: 20 }),
      ...grupo(1, { reviewCount: 1129 }),
    ]);
    expect(rows[0].resenasMedianas).toBe(20);
  });

  it('un negocio sin valoración no cuenta como cero', () => {
    const rows = aggregateSectorStats([
      ...grupo(5, { rating: 5 }),
      ...grupo(5, { rating: null, reviewCount: null }),
    ]);
    expect(rows[0].valoracionMedia).toBe(5);
  });

  it('agrupa por sector Y zona, no solo por sector', () => {
    const rows = aggregateSectorStats([
      ...grupo(MIN_GROUP_SIZE, { searchLocation: 'Las Palmas' }),
      ...grupo(MIN_GROUP_SIZE, { searchLocation: 'Telde' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('ordena de más a menos negocios: los grupos grandes dan titulares', () => {
    const rows = aggregateSectorStats([
      ...grupo(MIN_GROUP_SIZE, { searchLocation: 'Telde' }),
      ...grupo(MIN_GROUP_SIZE + 5, { searchLocation: 'Las Palmas' }),
    ]);
    expect(rows[0].zona).toBe('Las Palmas');
  });
});

describe('buildSectorStatsCsv', () => {
  it('incluye el porcentaje sin web propia, que es el titular', () => {
    const rows = aggregateSectorStats([
      ...grupo(3, { contactName: 'Peluquería Aurora', website: 'https://peluqueriaaurora.es' }),
      ...grupo(7, { website: null }),
    ]);
    const csv = buildSectorStatsCsv(rows);
    expect(csv.split('\r\n')[0]).toContain('% sin web propia');
    expect(csv).toContain('"70"');
  });

  it('escapa las fórmulas: una celda con = la ejecuta Excel al abrirla', () => {
    const csv = buildSectorStatsCsv(
      aggregateSectorStats(grupo(MIN_GROUP_SIZE, { searchCategory: '=cmd|calc' })),
    );
    expect(csv).toContain(`"'=cmd|calc"`);
  });
});
