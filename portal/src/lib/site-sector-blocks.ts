import type { SiteBlock, SiteContent, SiteSectionRef } from './site-content';
import {
  beautyPhotoSet,
  foodPhotoSet,
  healthPhotoSet,
  isHairPhotoSet,
  normalize,
  professionalPhotoSet,
  tradeDetailPhotos,
  tradePhotoSet,
  type FoodPhotoSet,
  type HealthPhotoSet,
} from './trade-photos';

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
// Restauración y profesionales (31/10/2026), con sus primeras plantillas
// (Pizarra y Despacho). Un restaurante se elige por la carta: la suya va por
// apartados, con precios de ejemplo y una galería de platos, y sustituye a «Qué
// incluye cada servicio» de la IA, que en un restaurante no dice nada. Una
// asesoría o un despacho se eligen por quién te atiende: el equipo, con
// nombres de relleno como en salud, y la trayectoria, con «20XX» en vez de
// años inventados (una fecha falsa en una web real es una afirmación falsa).
// Una inmobiliaria, por lo que tiene a la venta: un catálogo de inmuebles con
// Venta y Alquiler. Las fotos de los inmuebles son de banco y de estancias
// sueltas: el catálogo entero sale de ejemplo y nadie lo publica sin cambiarlo.
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

/** Las fotos de la carta y de la galería: seis por grupo, aparte de las de
 *  portada (`restaurante-N`…), para que la galería no repita la de arriba. */
export const FOOD_EXAMPLE_PHOTOS: Readonly<Record<FoodPhotoSet, string>> = Object.freeze({ restaurante: 'plato', cafeteria: 'cafe', panaderia: 'obrador' });
export const EXAMPLE_PHOTOS_PER_SET = 6;

const fotoComida = (nombre: string) => `/web-draft/restauracion/${nombre}.jpg`;

type Apartado = { titulo: string; platos: [string, string][]; foto: string; alt: string };
type Carta = { titulo: string; texto: string; apartados: Apartado[]; galeria: string; pies: string[] };

const CARTA: Record<FoodPhotoSet, Carta> = {
  restaurante: {
    titulo: 'Nuestra carta',
    texto: 'Precios orientativos: la carta cambia con la temporada y el mercado.',
    apartados: [
      {
        titulo: 'Para empezar',
        platos: [['Croquetas caseras (6 unidades)', '7,50 €'], ['Ensalada de tomate de la tierra', '8,00 €'], ['Pimientos asados', '6,50 €'], ['Tostas del día', '9,00 €']],
        foto: 'plato-1',
        alt: 'Pimientos asados en cazuela',
      },
      {
        titulo: 'Principales',
        platos: [['Pescado del día a la plancha', 'según mercado'], ['Sardinas a la brasa', '11,00 €'], ['Paella de marisco (mínimo 2 personas)', '16,00 € por persona'], ['Entrecot a la brasa', '18,50 €']],
        foto: 'plato-3',
        alt: 'Sardinas a la brasa',
      },
      {
        titulo: 'Postres',
        platos: [['Tarta de queso casera', '5,00 €'], ['Flan de huevo', '4,00 €'], ['Fruta de temporada', '3,50 €']],
        foto: '',
        alt: '',
      },
    ],
    galeria: 'Algunos de nuestros platos',
    pies: ['Pimientos asados', 'Tostas variadas', 'Sardinas a la brasa', 'Pescado al horno con limón', 'Ensalada de tomate', 'Paella'],
  },
  cafeteria: {
    titulo: 'Nuestra carta',
    texto: 'Precios orientativos: pregúntenos por los dulces del día.',
    apartados: [
      { titulo: 'Cafés', platos: [['Café solo', '1,30 €'], ['Cortado', '1,40 €'], ['Café con leche', '1,60 €'], ['Capuchino', '2,20 €'], ['Infusiones', '1,50 €']], foto: 'cafe-1', alt: 'Café con leche con dibujo en la espuma' },
      { titulo: 'Desayunos', platos: [['Tostada con tomate y aceite', '2,50 €'], ['Tostada de aguacate', '4,50 €'], ['Cruasán', '1,80 €'], ['Desayuno completo: café, zumo y tostada', '4,90 €']], foto: 'cafe-2', alt: 'Tostadas con tomate y aguacate' },
      { titulo: 'Dulces', platos: [['Tarta de queso', '3,80 €'], ['Tarta de chocolate', '3,80 €'], ['Bizcocho casero', '2,50 €']], foto: 'cafe-4', alt: 'Porción de tarta de queso con arándanos' },
    ],
    galeria: 'De nuestra barra',
    pies: ['Café con leche', 'Tostada con tomate', 'Cruasán y café', 'Tarta de queso', 'Tarta de chocolate', 'Tostada de aguacate'],
  },
  panaderia: {
    titulo: 'Lo que hacemos cada día',
    texto: 'Precios orientativos. Los encargos, con un día de antelación.',
    apartados: [
      { titulo: 'Panes', platos: [['Barra tradicional', '1,10 €'], ['Hogaza de masa madre', '3,90 €'], ['Pan integral', '2,40 €'], ['Pan de pasas y nueces', '4,20 €']], foto: 'obrador-1', alt: 'Dos barras de pan recién hechas' },
      { titulo: 'Bollería', platos: [['Cruasán de mantequilla', '1,50 €'], ['Napolitana de chocolate', '1,60 €'], ['Magdalenas (4 unidades)', '2,80 €']], foto: 'obrador-4', alt: 'Bandeja de cruasanes' },
      { titulo: 'Pasteles y encargos', platos: [['Tartaleta de frutas', '3,20 €'], ['Tarta por encargo', 'desde 18,00 €']], foto: 'obrador-6', alt: 'Tartaletas de frutas en la vitrina' },
    ],
    galeria: 'De nuestro obrador',
    pies: ['Barras recién hechas', 'Pan recién salido del horno', 'Pan rústico', 'Cruasanes', 'Formando cruasanes en el obrador', 'Tartaletas de frutas'],
  },
};

function restauracion(set: FoodPhotoSet): SectorSet {
  const c = CARTA[set];
  const carta: SiteBlock = {
    ...vacio('carta', 'pestanas', c.titulo),
    texto: c.texto,
    pestanas: c.apartados.map((a) => ({
      titulo: a.titulo,
      texto: a.platos.map(([plato, precio]) => `- **${plato}** — ${precio}`).join('\n'),
      foto: a.foto ? fotoComida(a.foto) : '',
      alt: a.alt,
    })),
  };
  const galeria: SiteBlock = {
    ...vacio('platos', 'galeria', c.galeria),
    fotos: c.pies.map((pie, i) => ({ foto: fotoComida(`${FOOD_EXAMPLE_PHOTOS[set]}-${i + 1}`), alt: pie, texto: pie })),
  };
  return { bloques: [carta, galeria], tras: { servicios: ['carta'], sobre: ['platos'] } };
}

type Despacho = 'abogados' | 'seguros' | 'asesoria';

/** Abogados y corredurías tienen su equipo; lo demás (asesorías, gestorías,
 *  lo que no se reconoce) es el grueso del sector. */
function despacho(businessName: string, primaryType: string | null): Despacho {
  const name = normalize(businessName);
  if (/abogad|bufete|juridic|letrad|legal/.test(name) || primaryType === 'lawyer') return 'abogados';
  if (/seguros|corredur|insurance/.test(name) || primaryType === 'insurance_agency') return 'seguros';
  return 'asesoria';
}

const EQUIPO_DESPACHO: Record<Despacho, { texto: string; personas: { papel: string; detalle: string }[]; colegiado: string | null }> = {
  abogados: {
    texto: 'Le atiende siempre un abogado del despacho, desde la primera consulta hasta el final del asunto.',
    personas: [
      { papel: 'Socia directora. Derecho civil y de familia', detalle: 'Herencias, divorcios, contratos y reclamaciones.' },
      { papel: 'Derecho laboral', detalle: 'Despidos, reclamaciones de salarios y negociación con la empresa.' },
      { papel: 'Derecho mercantil', detalle: 'Sociedades, contratos entre empresas y deudas de clientes.' },
    ],
    colegiado: 'Abogado colegiado nº 0000',
  },
  seguros: {
    texto: 'Le atiende siempre la misma persona, también cuando hay un siniestro.',
    personas: [
      { papel: 'Mediadora de seguros', detalle: 'Compara las pólizas y le explica qué cubre cada una.' },
      { papel: 'Siniestros', detalle: 'Se ocupa del parte y habla con la aseguradora por usted.' },
      { papel: 'Seguros para empresas', detalle: 'Responsabilidad civil, flotas y seguros de comercio.' },
    ],
    colegiado: null,
  },
  asesoria: {
    texto: 'Cada cliente tiene un asesor que conoce su negocio y le contesta el mismo día.',
    personas: [
      { papel: 'Asesoría fiscal', detalle: 'Impuestos trimestrales, renta y sociedades.' },
      { papel: 'Asesoría laboral', detalle: 'Nóminas, contratos, altas y seguros sociales.' },
      { papel: 'Contabilidad', detalle: 'Libros al día y cuentas anuales.' },
    ],
    colegiado: null,
  },
};

const TRAYECTORIA: Record<Despacho, [string, string][]> = {
  abogados: [['Abrimos el despacho', 'Empezamos atendiendo a los vecinos del barrio.'], ['Crece el equipo', 'Se incorporan las áreas laboral y mercantil.'], ['Seguimos aquí', 'En el mismo sitio y con el mismo trato.']],
  seguros: [['Abrimos la correduría', 'Empezamos con los seguros de los negocios del barrio.'], ['Empresas', 'Empezamos a asegurar comercios y flotas.'], ['Seguimos aquí', 'En el mismo sitio y con el mismo trato.']],
  asesoria: [['Abrimos la asesoría', 'Empezamos llevando los papeles de los negocios del barrio.'], ['Área laboral', 'Empezamos a llevar nóminas y contratos.'], ['Seguimos aquí', 'En el mismo sitio y con el mismo trato.']],
};

function profesionales(kind: Despacho): SectorSet {
  const e = EQUIPO_DESPACHO[kind];
  const equipo: SiteBlock = {
    ...vacio('equipo', 'catalogo', 'Nuestro equipo'),
    texto: e.texto,
    // Sin foto ni categoría, como en salud: ni retratos de banco con nombre,
    // ni filtros.
    productos: e.personas.map((p) => ({
      nombre: 'Nombre Apellido',
      categoria: '',
      foto: '',
      alt: '',
      descripcion: `${p.papel}. ${p.detalle}`,
      caracteristicas: e.colegiado ? [e.colegiado] : [],
      precio: '',
    })),
  };
  const trayectoria: SiteBlock = {
    ...vacio('trayectoria', 'trayectoria', 'Nuestra trayectoria'),
    hitos: TRAYECTORIA[kind].map(([titulo, texto], i, all) => ({ fecha: i === all.length - 1 ? 'Hoy' : '20XX', titulo, texto })),
  };
  // La trayectoria antes que el equipo: detrás suele venir «Cómo trabajamos»,
  // otra línea con hitos, y las dos seguidas se ven repetidas.
  return { bloques: [equipo, trayectoria], tras: { sobre: ['trayectoria', 'equipo'] } };
}

/** Seis inmuebles de ejemplo, uno por foto (`inmueble-N`). Sin calles ni
 *  barrios: un piso en una calle real que no está a la venta engaña. */
const INMUEBLES: { nombre: string; categoria: 'Venta' | 'Alquiler'; alt: string; descripcion: string; caracteristicas: string[]; precio: string }[] = [
  { nombre: 'Piso de tres dormitorios con balcón', categoria: 'Venta', alt: 'Salón con balcón y mucha luz', descripcion: 'Luminoso, exterior y listo para entrar a vivir.', caracteristicas: ['3 dormitorios', '2 baños', '95 m²'], precio: '189.000 €' },
  { nombre: 'Apartamento con vistas', categoria: 'Alquiler', alt: 'Salón con sofá y vistas desde el balcón', descripcion: 'Amueblado, con aire acondicionado y vistas despejadas.', caracteristicas: ['2 dormitorios', '1 baño', '70 m²'], precio: '950 €/mes' },
  { nombre: 'Estudio reformado', categoria: 'Alquiler', alt: 'Dormitorio con cama de matrimonio', descripcion: 'Recién reformado, ideal para una o dos personas.', caracteristicas: ['1 dormitorio', '1 baño', '45 m²'], precio: '650 €/mes' },
  { nombre: 'Ático con terraza', categoria: 'Venta', alt: 'Terraza de madera con sillas', descripcion: 'Terraza de 30 m² para comer fuera todo el año.', caracteristicas: ['2 dormitorios', '2 baños', '85 m²'], precio: '265.000 €' },
  { nombre: 'Casa con piscina y jardín', categoria: 'Venta', alt: 'Casa de campo con piscina', descripcion: 'Una planta, con jardín, piscina y porche.', caracteristicas: ['4 dormitorios', '3 baños', '210 m²'], precio: '420.000 €' },
  { nombre: 'Chalet con jardín', categoria: 'Venta', alt: 'Chalet blanco entre palmeras', descripcion: 'Zona tranquila, cerca de todos los servicios.', caracteristicas: ['3 dormitorios', '2 baños', '160 m²'], precio: '310.000 €' },
];

function inmobiliaria(): SectorSet {
  const inmuebles: SiteBlock = {
    ...vacio('inmuebles', 'catalogo', 'Inmuebles destacados'),
    texto: 'Una selección de lo que tenemos ahora. Pregúntenos por lo que busca.',
    productos: INMUEBLES.map((p, i) => ({ ...p, foto: `/web-draft/profesionales/inmueble-${i + 1}.jpg` })),
  };
  return { bloques: [inmuebles], tras: { servicios: ['inmuebles'] } };
}

/**
 * Añade al contenido de un borrador los bloques de ejemplo de su sector, si
 * los tiene. Devuelve el contenido nuevo (no toca el que recibe).
 */
export function withSectorExamples(content: SiteContent, input: SectorInput): SiteContent {
  if (input.familia === 'trades') return withTradePhotos(content, input);
  if (input.familia === 'health') return withBlocks(structuredClone(content), salud(healthPhotoSet(input.businessName, input.primaryType)));
  if (input.familia === 'food') {
    return withBlocks(withoutBlock(structuredClone(content), DETAIL_BLOCK_ID), restauracion(foodPhotoSet(input.businessName, input.primaryType)));
  }
  if (input.familia === 'professional') {
    const set =
      professionalPhotoSet(input.businessName, input.primaryType) === 'inmobiliaria' ? inmobiliaria() : profesionales(despacho(input.businessName, input.primaryType));
    return withBlocks(structuredClone(content), set);
  }
  if (input.familia !== 'beauty') return content;
  // Estética, uñas o spa: estas fotos (todas de pelo) no les valen. Desde el
  // 31/10/2026 lo decide el mismo reparto que la portada, así que un «Nails
  // Bar» sin tipo de Google ya no recibe la galería de cortes.
  const photoSet = beautyPhotoSet(input.businessName, input.primaryType);
  if (!isHairPhotoSet(photoSet)) return content;
  const set = photoSet === 'barberia' ? barberia() : peluqueria();
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
