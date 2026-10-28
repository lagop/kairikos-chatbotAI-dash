import type { SiteBlock, SiteContent, SiteSectionRef } from './site-content';
import { beautyPhotoSet } from './trade-photos';

// =============================================================================
// Bloques de ejemplo por sector (28/10/2026).
//
// Los bloques ricos (site-rich-blocks.ts) los añade el cliente con lo suyo.
// Pero un borrador de peluquería sin galería ni carta de servicios se queda
// corto justo en lo que vende una peluquería: los trabajos. Así que el
// borrador de ciertos sectores trae ya algunos, con contenido FICTICIO:
// fotos de banco (public/web-draft/<sector>/) y precios inventados.
//
// Lo ficticio va marcado como dato de ejemplo (`ejemplos`), igual que las
// cifras que inventa la IA: se ve resaltado en la web (dato-ejemplo-bloque),
// el editor lo cuenta como pendiente y NO se puede publicar hasta que el
// cliente lo cambie o lo confirme (website-publish.ts, example_data_pending).
// Ningún precio inventado sale a internet sin que alguien lo haya mirado.
//
// Sin vídeo de ejemplo (no hay vídeo «de muestra» que no sea de un tercero) ni
// marcas (los logos de marcas reales no se pueden usar de relleno).
// =============================================================================

type SectorInput = { familia: string; businessName: string; primaryType: string | null };

const vacio = (id: string, tipo: SiteBlock['tipo'], titulo: string): SiteBlock => ({
  id,
  tipo,
  titulo,
  texto: '',
  foto: '',
  fotoAlt: '',
  items: [],
  fotos: [],
  productos: [],
  pestanas: [],
  comparativa: { columnas: [], destacada: -1, filas: [] },
  hitos: [],
  video: '',
});

const foto = (nombre: string) => `/web-draft/belleza/${nombre}.jpg`;

function peluqueria(): { bloques: SiteBlock[]; tras: Partial<Record<SiteSectionRef['tipo'], string[]>> } {
  const servicios: SiteBlock = {
    ...vacio('servicios-por-persona', 'pestanas', 'Servicios y precios'),
    texto: 'Precios orientativos: le decimos el precio exacto antes de empezar.',
    pestanas: [
      {
        titulo: 'Mujer',
        texto: '- **Corte y peinado** — desde 28 €\n- **Color completo** — desde 45 €\n- **Mechas o balayage** — desde 70 €\n- **Tratamiento de hidratación** — desde 25 €\n- **Recogido para eventos** — desde 40 €',
        foto: foto('peluqueria-3'),
        alt: 'Peluquera rizando una melena',
      },
      {
        titulo: 'Hombre',
        texto: '- **Corte clásico o degradado** — desde 15 €\n- **Arreglo de barba** — desde 10 €\n- **Corte y barba** — desde 22 €\n- **Cobertura de canas** — desde 20 €',
        foto: foto('barberia-1'),
        alt: 'Sillones de barbería',
      },
      {
        titulo: 'Niños',
        texto: '- **Corte infantil** (hasta 12 años) — desde 12 €\n- **Peinado para comuniones y fiestas** — desde 20 €',
        foto: '',
        alt: '',
      },
    ],
  };
  const trabajos: SiteBlock = {
    ...vacio('trabajos', 'galeria', 'Algunos de nuestros trabajos'),
    fotos: [
      { foto: foto('peluqueria-2'), alt: 'Sillón del salón junto a la ventana', texto: 'Nuestro salón' },
      { foto: foto('trabajo-4'), alt: 'Melena larga con ondas doradas', texto: 'Ondas doradas' },
      { foto: foto('trabajo-2'), alt: 'Trenza larga de espiga', texto: 'Trenza de espiga' },
      { foto: foto('trabajo-6'), alt: 'Recogido bajo con mechones sueltos', texto: 'Recogido desenfadado' },
      { foto: foto('trabajo-3'), alt: 'Moño bajo rubio', texto: 'Moño bajo' },
      { foto: foto('trabajo-5'), alt: 'Melena castaña con brillo', texto: 'Castaño con brillo' },
      { foto: foto('trabajo-7'), alt: 'Carta de color y útiles de tinte', texto: 'Nuestra carta de color' },
      { foto: foto('trabajo-9'), alt: 'Manos cortando el pelo a tijera', texto: 'Corte a tijera' },
    ],
  };
  const cambio: SiteBlock = {
    ...vacio('cambio-de-color', 'antes_despues', 'Un cambio de color'),
    fotos: [
      { foto: foto('trabajo-1'), alt: 'Melena rizada castaña antes del cambio', texto: 'Antes' },
      { foto: foto('despues-1'), alt: 'Melena con balayage rubio después del cambio', texto: 'Después' },
    ],
  };
  return { bloques: [servicios, trabajos, cambio], tras: { servicios: ['servicios-por-persona'], sobre: ['trabajos', 'cambio-de-color'] } };
}

function barberia(): { bloques: SiteBlock[]; tras: Partial<Record<SiteSectionRef['tipo'], string[]>> } {
  const servicios: SiteBlock = {
    ...vacio('servicios-por-persona', 'pestanas', 'Servicios y precios'),
    texto: 'Precios orientativos: le decimos el precio exacto antes de empezar.',
    pestanas: [
      { titulo: 'Cortes', texto: '- **Corte clásico** — desde 14 €\n- **Degradado (fade)** — desde 16 €\n- **Corte infantil** — desde 12 €', foto: foto('barberia-2'), alt: 'Sillón de barbero' },
      { titulo: 'Barba', texto: '- **Arreglo de barba con navaja** — desde 10 €\n- **Afeitado clásico con toalla caliente** — desde 15 €', foto: foto('trabajo-8'), alt: 'Peines y tijeras de barbero' },
      { titulo: 'Combos', texto: '- **Corte y barba** — desde 22 €\n- **Corte, barba y lavado** — desde 26 €', foto: '', alt: '' },
    ],
  };
  const local: SiteBlock = {
    ...vacio('trabajos', 'galeria', 'Nuestro local'),
    fotos: [
      { foto: foto('barberia-1'), alt: 'Sillones de barbería con pared de ladrillo', texto: '' },
      { foto: foto('barberia-2'), alt: 'Sillón rojo de barbero', texto: '' },
      { foto: foto('trabajo-8'), alt: 'Peines y tijeras', texto: '' },
      { foto: foto('trabajo-9'), alt: 'Corte a tijera', texto: '' },
    ],
  };
  return { bloques: [servicios, local], tras: { servicios: ['servicios-por-persona'], sobre: ['trabajos'] } };
}

/**
 * Añade al contenido de un borrador los bloques de ejemplo de su sector, si
 * los tiene. Devuelve el contenido nuevo (no toca el que recibe).
 */
export function withSectorExamples(content: SiteContent, input: SectorInput): SiteContent {
  if (input.familia !== 'beauty') return content;
  // Estética, uñas o spa: estas fotos (todas de pelo) no les valen.
  if (input.primaryType && !['hair_salon', 'barber_shop'].includes(input.primaryType)) return content;
  const { bloques, tras } = beautyPhotoSet(input.businessName, input.primaryType) === 'barberia' ? barberia() : peluqueria();
  const next = structuredClone(content);
  const libres = bloques.filter((b) => !next.bloques.some((x) => x.id === b.id));
  next.bloques.push(...libres);
  const home = next.paginas.find((p) => p.ruta === '') ?? next.paginas[0];
  for (const [tipo, ids] of Object.entries(tras) as [SiteSectionRef['tipo'], string[]][]) {
    const refs = ids.filter((id) => libres.some((b) => b.id === id)).map((id) => ({ tipo: 'bloque' as const, id }));
    const at = home.secciones.findIndex((s) => s.tipo === tipo);
    home.secciones.splice(at >= 0 ? at + 1 : home.secciones.length, 0, ...refs);
  }
  // Marcado como ejemplo por el título: basta una ruta para que el bloque
  // entero cuente como pendiente (el editor y la publicación miran el
  // prefijo «bloques.<id>»), y el motor lo resalta entero.
  next.ejemplos = [...next.ejemplos, ...libres.map((b) => `bloques.${b.id}.titulo`)];
  return next;
}
