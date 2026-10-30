import type { SiteBlock, SiteContent, SiteSectionRef } from './site-content';
import { beautyPhotoSet, healthPhotoSet, tradeDetailPhotos, tradePhotoSet, type HealthPhotoSet } from './trade-photos';

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
// Salud (30/10/2026): el equipo con su número de colegiado y los seguros y
// mutuas, lo primero que mira un paciente antes de pedir cita. Los nombres
// van como «Dra. Nombre Apellido», no inventados: una clínica real con un
// médico que no existe engaña más que un precio orientativo. Y los seguros,
// sin nombres de aseguradoras, por lo mismo que las marcas de abajo.
//
// Sin vídeo de ejemplo (no hay vídeo «de muestra» que no sea de un tercero) ni
// marcas (los logos de marcas reales no se pueden usar de relleno).
// =============================================================================

type SectorInput = { familia: string; businessName: string; primaryType: string | null };

/** Los bloques de un sector, tras qué sección de la portada va cada uno y qué
 *  campos de cada uno se marcan como ejemplo. Sin `marcas`, el título: en un
 *  bloque rico basta para resaltarlo entero. */
type SectorSet = {
  bloques: SiteBlock[];
  tras: Partial<Record<SiteSectionRef['tipo'], string[]>>;
  marcas?: Record<string, string[]>;
};

/** Los bloques que añade la ampliación con IA (site-content-ai.ts): lo que
 *  incluye cada servicio, en pestañas, y la comparativa del oficio. */
export const DETAIL_BLOCK_ID = 'detalle-servicios';
export const COMPARISON_BLOCK_ID = 'comparativa';

/** Un bloque con todo vacío salvo id, tipo y título. */
export const vacio = (id: string, tipo: SiteBlock['tipo'], titulo: string): SiteBlock => ({
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

function peluqueria(): SectorSet {
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

function barberia(): SectorSet {
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

type Profesional = { nombre: string; papel: string; detalle: string; colegiado: boolean };

const EQUIPO: Record<HealthPhotoSet, Profesional[]> = {
  dental: [
    { nombre: 'Dra. Nombre Apellido', papel: 'Odontología general', detalle: 'Directora médica. Revisiones, empastes, endodoncias e implantes.', colegiado: true },
    { nombre: 'Dr. Nombre Apellido', papel: 'Ortodoncia', detalle: 'Ortodoncia invisible y con brackets, en niños y adultos.', colegiado: true },
    { nombre: 'Nombre Apellido', papel: 'Higiene bucodental', detalle: 'Limpiezas, blanqueamientos y prevención.', colegiado: false },
  ],
  fisioterapia: [
    { nombre: 'Nombre Apellido', papel: 'Fisioterapia deportiva', detalle: 'Lesiones musculares, esguinces y vuelta al deporte.', colegiado: true },
    { nombre: 'Nombre Apellido', papel: 'Suelo pélvico', detalle: 'Embarazo, posparto e incontinencia.', colegiado: true },
    { nombre: 'Nombre Apellido', papel: 'Fisioterapia neurológica', detalle: 'Rehabilitación tras un ictus y en enfermedades neurológicas.', colegiado: true },
  ],
  veterinaria: [
    { nombre: 'Dra. Nombre Apellido', papel: 'Medicina general', detalle: 'Consultas, vacunas y revisiones de perros y gatos.', colegiado: true },
    { nombre: 'Dr. Nombre Apellido', papel: 'Cirugía y traumatología', detalle: 'Esterilizaciones, fracturas y cirugía de tejidos blandos.', colegiado: true },
    { nombre: 'Nombre Apellido', papel: 'Auxiliar técnico veterinario', detalle: 'Le recibe y cuida de su mascota mientras está con nosotros.', colegiado: false },
  ],
  clinica: [
    { nombre: 'Dra. Nombre Apellido', papel: 'Medicina general', detalle: 'Consultas, revisiones y certificados médicos.', colegiado: true },
    { nombre: 'Dr. Nombre Apellido', papel: 'Especialista', detalle: 'La especialidad de la consulta: dermatología, pediatría…', colegiado: true },
    { nombre: 'Nombre Apellido', papel: 'Enfermería', detalle: 'Curas, análisis, vacunas e inyectables.', colegiado: true },
  ],
};

const SEGUROS: Record<HealthPhotoSet, { titulo: string; texto: string; items: string[] }> = {
  dental: {
    titulo: 'Seguros, financiación y formas de pago',
    texto: 'Atendemos a pacientes privados y de las principales aseguradoras. Pregúntenos por la suya.',
    items: [
      'Trabajamos con las principales aseguradoras de salud',
      'Le decimos qué cubre su seguro antes de empezar',
      'Financiación del tratamiento hasta en 12 meses sin intereses',
      'Pago con tarjeta, Bizum o transferencia',
    ],
  },
  fisioterapia: {
    titulo: 'Mutuas, seguros y formas de pago',
    texto: 'Atendemos por mutua, por seguro privado y a pacientes particulares. Pregúntenos por la suya.',
    items: [
      'Trabajamos con las principales mutuas y aseguradoras',
      'Accidentes de tráfico: lo gestionamos con la aseguradora, sin coste para usted',
      'Bonos de sesiones a precio reducido',
      'Factura detallada para pedir el reembolso a su seguro',
    ],
  },
  veterinaria: {
    titulo: 'Seguros y planes de salud',
    texto: 'Trabajamos con los seguros para mascotas más habituales. Pregúntenos por el suyo.',
    items: [
      'Aceptamos los principales seguros para mascotas',
      'Plan de salud anual: vacunas y revisiones a cuota fija',
      'Pago fraccionado en cirugías',
      'Pago con tarjeta o Bizum',
    ],
  },
  clinica: {
    titulo: 'Seguros y formas de pago',
    texto: 'Consulta privada y por aseguradora. Pregúntenos por la suya.',
    items: [
      'Trabajamos con las principales aseguradoras de salud',
      'Le decimos qué cubre su seguro antes de la consulta',
      'Informes y justificantes para su empresa o su seguro',
      'Pago con tarjeta, Bizum o transferencia',
    ],
  },
};

function salud(set: HealthPhotoSet): SectorSet {
  const equipo: SiteBlock = {
    ...vacio('equipo', 'catalogo', 'Nuestro equipo'),
    texto: 'Profesionales sanitarios colegiados, que le atienden en cada visita.',
    // Sin foto: un retrato de banco con el nombre de un médico es justo lo que
    // no se puede poner de relleno. Sin categoría, para que no salgan filtros.
    productos: EQUIPO[set].map((p) => ({
      nombre: p.nombre,
      categoria: '',
      foto: '',
      alt: '',
      descripcion: `${p.papel}. ${p.detalle}`,
      caracteristicas: p.colegiado ? ['Nº de colegiado: 00000'] : [],
      precio: '',
    })),
  };
  const s = SEGUROS[set];
  // Un bloque de lista lo pinta la plantilla, que solo resalta lo marcado:
  // se marca cada línea.
  const seguros: SiteBlock = { ...vacio('seguros', 'lista', s.titulo), texto: s.texto, items: s.items.map((texto) => ({ texto, icono: '' })) };
  return {
    bloques: [equipo, seguros],
    tras: { sobre: ['equipo'], precios: ['seguros'] },
    marcas: { seguros: ['titulo', 'texto', ...s.items.map((_, i) => `items.${i}.texto`)] },
  };
}

/**
 * Añade al contenido de un borrador los bloques de ejemplo de su sector, si
 * los tiene. Devuelve el contenido nuevo (no toca el que recibe).
 */
export function withSectorExamples(content: SiteContent, input: SectorInput): SiteContent {
  if (input.familia === 'trades') return withTradePhotos(content, input);
  if (input.familia === 'health') return withBlocks(structuredClone(content), salud(healthPhotoSet(input.businessName, input.primaryType)));
  if (input.familia !== 'beauty') return content;
  // Estética, uñas o spa: estas fotos (todas de pelo) no les valen.
  if (input.primaryType && !['hair_salon', 'barber_shop'].includes(input.primaryType)) return content;
  const set = beautyPhotoSet(input.businessName, input.primaryType) === 'barberia' ? barberia() : peluqueria();
  return withBlocks(withoutBlock(structuredClone(content), DETAIL_BLOCK_ID), set);
}

/** Pone los bloques del sector que no estén ya, tras sus secciones, y los
 *  marca como ejemplo. Cambia `next`. */
function withBlocks(next: SiteContent, { bloques, tras, marcas = {} }: SectorSet): SiteContent {
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
  // prefijo «bloques.<id>»), y el motor lo resalta entero. Los de siempre
  // (una lista) los pinta la plantilla, que solo resalta lo marcado: esos
  // traen sus campos en `marcas`.
  next.ejemplos = [...next.ejemplos, ...libres.flatMap((b) => (marcas[b.id] ?? ['titulo']).map((campo) => `bloques.${b.id}.${campo}`))];
  return next;
}

/** Quita un bloque, su sitio en las páginas y sus marcas de ejemplo. En
 *  peluquería y barbería, las pestañas de la IA sobran: las de sector traen
 *  precios y fotos y van en el mismo sitio. */
function withoutBlock(content: SiteContent, id: string): SiteContent {
  content.bloques = content.bloques.filter((b) => b.id !== id);
  for (const p of content.paginas) p.secciones = p.secciones.filter((s) => !(s.tipo === 'bloque' && s.id === id));
  content.ejemplos = content.ejemplos.filter((r) => !r.startsWith(`bloques.${id}.`));
  return content;
}

/** En oficios, una foto de SU oficio en cada pestaña de lo que incluye cada
 *  servicio: las que no son de portada (trade-photos.ts), así que ninguna
 *  pestaña la repite. Son de banco: el bloque ya va entero de ejemplo. */
function withTradePhotos(content: SiteContent, input: SectorInput): SiteContent {
  const set = tradePhotoSet(input.businessName, input.primaryType);
  const detail = content.bloques.find((b) => b.id === DETAIL_BLOCK_ID);
  if (!set || !detail) return content;
  const next = structuredClone(content);
  const fotos = tradeDetailPhotos(set, input.businessName);
  next.bloques
    .find((b) => b.id === DETAIL_BLOCK_ID)!
    .pestanas.forEach((p, i) => {
      p.foto = fotos[i % fotos.length];
      p.alt = p.titulo;
    });
  return next;
}
