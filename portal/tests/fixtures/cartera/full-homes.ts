// Cartera — una casa en venta y otra en alquiler completas, con agentes de la
// demo (lucia, elena): validan tal cual con el esquema copiado de la web.
// Las usan los tests de las reglas y del flujo del panel al feed.

/** Una casa en venta completa: valida tal cual con el esquema de la web. */
export function fullVenta(): Record<string, unknown> {
  return {
    type: 'villa',
    zone: 'costa',
    title: { es: 'Villa con vistas al mar', en: 'Villa with sea views', de: 'Villa mit Meerblick' },
    summary: { es: 'Cuatro dormitorios y jardín.', en: 'Four bedrooms and a garden.', de: 'Vier Schlafzimmer und Garten.' },
    price: 850000,
    listedAt: '2026-11-01',
    usable: 210,
    built: 260,
    plot: 900,
    bedrooms: 4,
    bathrooms: 3,
    energy: { consumo: 'C', kwh: 98, emisiones: 'C', co2: 21 },
    ibi: 1400,
    agent: 'lucia',
    tags: ['vistas-mar', 'piscina'],
    lacks: [{ es: 'Sin garaje', en: 'No garage', de: 'Keine Garage' }],
    media: [{ kind: 'youtube', id: 'dQw4w9WgXcQ' }],
  };
}

export function fullAlquiler(): Record<string, unknown> {
  return {
    term: 'temporada',
    type: 'piso',
    zone: 'pueblo',
    title: { es: 'Piso en el casco', en: 'Flat in the old town', de: 'Wohnung in der Altstadt' },
    summary: { es: 'Luminoso.', en: 'Bright.', de: 'Hell.' },
    rent: 1200,
    listedAt: '2026-11-01',
    availableFrom: '2026-12-01',
    months: [3, 11],
    furnished: true,
    pets: false,
    guarantee: 1,
    includes: ['agua', 'internet'],
    usable: 70,
    built: 85,
    bedrooms: 2,
    bathrooms: 1,
    energy: { consumo: 'D', kwh: 120, emisiones: 'D', co2: 30 },
    agent: 'elena',
  };
}
