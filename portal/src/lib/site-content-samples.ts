import { defaultHomePage, emptySiteTitles, SITE_TITLED_SECTIONS, type SiteContent } from './site-content';
import type { SiteRenderContext } from './site-template';
import { renderCitasHtml, renderResenasHtml, SAMPLE_DRAFT_MARKUP } from './site-draft-markup';

// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — contenidos de muestra para probar una
// plantilla antes de que pinte la web de nadie.
//
// Los tres de las pruebas del 26/10, que fueron los que encontraron los
// fallos:
// - normal: lo que escribiría la IA para un negocio real.
// - exagerado: lo peor que puede escribir un dueño dentro de los topes del
//   esquema (12 servicios, títulos de tres líneas, precios largos). Una
//   plantilla que no lo aguante se rompe el día que el cliente edite.
// - minimo: lo poco que pondría un dueño con prisa. Con uno o dos elementos,
//   las filas no pueden quedarse arrinconadas con media pantalla en blanco.
//
// Negocio inventado («Fontanería Ejemplo»): nada de esto debe parecer un
// cliente real.
// =============================================================================

export const SAMPLE_RENDER_CONTEXT: SiteRenderContext = {
  negocio: {
    nombre: 'Fontanería Ejemplo',
    telefono: '600 00 00 00',
    direccion: 'Calle de Muestra, 1, Las Palmas de Gran Canaria',
    mapsUrl: 'https://maps.google.com/',
    valoracion: '4,9',
    numResenas: '32',
  },
  fotos: { portada: 'assets/portada.jpg', equipo: null, trabajo: null },
  formAction: null,
  borrador: true,
  bannerHtml: null,
  // 27/10/2026 — con las citas y reseñas pintadas: sin ellas ninguna
  // comprobación vería si la plantilla les da estilo, y el borrador real
  // las lleva casi siempre.
  ...SAMPLE_DRAFT_MARKUP,
};

const normal: SiteContent = {
  version: 2,
  paginas: [defaultHomePage()],
  datos: {
    titular: 'Localizamos la avería sin romperle la casa',
    subtitulo: 'Fugas, desatascos, grifería y termos. Le explicamos qué pasa antes de tocar nada y dejamos todo limpio.',
    sobre:
      'Somos un fontanero de barrio que trabaja con **puntualidad** y explica cada paso.\n\nVamos preparados para resolver en la primera visita:\n- Detector de fugas\n- Cámara de inspección',
    llamada_accion: 'Llame y le decimos cuándo podemos ir',
    servicios: [
      { nombre: 'Detección de fugas', descripcion: 'Encontramos el origen sin abrir de más.', icono: 'herramienta' },
      { nombre: 'Desatascos', descripcion: 'Fregaderos, baños y bajantes.', icono: 'check' },
      { nombre: 'Termos y calentadores', descripcion: 'Reparación y sustitución.', icono: 'reloj' },
      { nombre: 'Grifería y sanitarios', descripcion: 'Cambio de grifos, cisternas e inodoros.', icono: 'casa' },
    ],
    cifras: [
      { valor: 'Mismo día', etiqueta: 'en urgencias, siempre que se pueda' },
      { valor: '15 años', etiqueta: 'de oficio en la ciudad' },
    ],
    proceso: [
      { titulo: 'Nos llama', texto: 'Nos cuenta qué pasa y le orientamos por teléfono.' },
      { titulo: 'Diagnóstico', texto: 'Localizamos el problema antes de tocar nada.' },
      { titulo: 'Reparación', texto: 'Hacemos el trabajo y dejamos todo limpio.' },
    ],
    precios: {
      nota: 'Precios orientativos; el presupuesto se cierra antes de empezar.',
      filas: [
        { concepto: 'Visita y diagnóstico', precio: 'Desde 40 €', detalle: '' },
        { concepto: 'Desatasco', precio: 'Desde 60 €', detalle: 'Sin obra en la mayoría de casos.' },
        { concepto: 'Cambio de grifo', precio: 'Desde 45 €', detalle: 'El grifo se presupuesta aparte.' },
      ],
    },
    garantias: [
      { titulo: 'Trabajo garantizado', texto: 'Cada reparación queda cubierta por escrito durante tres meses.' },
      { titulo: 'Presupuesto cerrado', texto: 'Le decimos el precio antes de empezar.' },
    ],
    zona: { texto: 'Atendemos la ciudad y los municipios cercanos.', lugares: [{ nombre: 'Telde' }, { nombre: 'Arucas' }, { nombre: 'Santa Brígida' }] },
    faq: [
      { pregunta: '¿Cobran el desplazamiento?', respuesta: 'Va incluido en el presupuesto que le damos antes de empezar.' },
      { pregunta: '¿Trabajan los fines de semana?', respuesta: 'Sí, **todos los días** en el horario indicado.' },
    ],
    horario: [{ dias: 'Todos los días', horas: '8:00 – 20:00' }],
    titulos: emptySiteTitles(),
  },
  bloques: [
    { id: 'historia', tipo: 'texto', titulo: 'Nuestra historia', texto: 'Empezamos con una furgoneta y muchas ganas.', foto: '', fotoAlt: '', items: [], fotos: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], video: '' },
    { id: 'agosto', tipo: 'aviso', titulo: 'Agosto', texto: 'Cerrado del 10 al 20 de agosto.', foto: '', fotoAlt: '', items: [], fotos: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], video: '' },
  ],
  ejemplos: [
    'cifras.0.valor',
    'cifras.1.valor',
    'precios.filas.0.precio',
    'precios.filas.1.precio',
    'precios.filas.2.precio',
    'garantias.0.texto',
    'bloques.agosto.texto',
  ],
  legal: { titular: 'Fontanería Ejemplo S.L.', nif: 'B00000000', domicilio: 'Calle de Muestra, 1, Las Palmas de Gran Canaria', email: 'hola@fontaneria-ejemplo.invalid', registro: '' },
  seccionesConfirmadas: [],
  // Entrega 5: con blog, para que las comprobaciones con navegador prueben
  // también la lista y el artículo de cada plantilla.
  blog: {
    titulo: 'Blog',
    intro: 'Consejos de fontanería para casa, contados sin tecnicismos.',
    entradas: [
      {
        slug: 'como-detectar-una-fuga',
        titulo: 'Cómo saber si tiene una fuga de agua sin romper nada',
        metaTitulo: '',
        metaDescripcion: '',
        fecha: '2026-10-20',
        extracto: 'Tres comprobaciones que puede hacer usted mismo antes de llamar a nadie.',
        texto:
          'Una fuga pequeña puede pasar meses sin verse.\n\n## Mire el contador\n\nCierre todos los grifos y apunte la lectura. Si al cabo de una hora ha cambiado, hay una fuga.\n\n## Revise las juntas\n\n- Debajo del fregadero\n- Detrás del inodoro\n- En la toma de la lavadora\n\nSi no la encuentra, [escríbanos](mailto:hola@fontaneria-ejemplo.invalid).',
        foto: '',
        fotoAlt: '',
        publicada: true,
        origen: 'cliente',
        html: '',
      },
      {
        slug: 'termo-o-calentador',
        titulo: '¿Termo eléctrico o calentador de gas?',
        metaTitulo: '',
        metaDescripcion: '',
        fecha: '2026-09-02',
        extracto: '',
        texto: 'Depende de cuántos son en casa y de la instalación que ya tiene.\n\nUn termo es más barato de poner; un calentador gasta menos si se usa mucho.',
        foto: '',
        fotoAlt: '',
        publicada: true,
        origen: 'cliente',
        html: '',
      },
    ],
  },
  urlPublica: '',
  verificacionGoogle: '',
  imagenes: { logo: '', portada: '' },
};
normal.paginas[0].secciones.splice(4, 0, { tipo: 'bloque', id: 'historia' });
normal.paginas[0].secciones.unshift({ tipo: 'bloque', id: 'agosto' });

const repeat = (s: string, n: number) => Array.from({ length: n }, () => s).join(' ');

/** Un bloque con todos sus campos vacíos, para rellenar solo lo suyo. */
const bloqueVacio = (id: string, tipo: SiteContent['bloques'][number]['tipo']): SiteContent['bloques'][number] => ({
  id,
  tipo,
  titulo: '',
  texto: '',
  foto: '',
  fotoAlt: '',
  items: [],
  fotos: [],
  productos: [],
  pestanas: [],
  comparativa: { columnas: [], destacada: -1, filas: [] },
  hitos: [], video: '',
});

const exagerado: SiteContent = {
  ...normal,
  // Entrega 5: varias páginas con el título más largo que admite el menú,
  // para que las comprobaciones midan el menú lleno y la cabecera de página.
  paginas: [
    defaultHomePage(),
    // 28/10/2026 — los bloques ricos (site-rich-blocks.ts), aquí para que el
    // laboratorio los mida en cada plantilla y cada ancho.
    {
      ruta: 'servicios',
      titulo: 'Servicios y precios completos',
      metaTitulo: '',
      metaDescripcion: '',
      secciones: [
        { tipo: 'servicios' },
        { tipo: 'bloque', id: 'catalogo' },
        { tipo: 'bloque', id: 'galeria' },
        { tipo: 'bloque', id: 'antes-despues' },
        { tipo: 'bloque', id: 'pestanas' },
        { tipo: 'bloque', id: 'comparativa' },
        { tipo: 'bloque', id: 'trayectoria' },
        { tipo: 'bloque', id: 'marcas' },
        { tipo: 'bloque', id: 'video' },
        { tipo: 'bloque', id: 'video-vimeo' },
        { tipo: 'precios' },
      ],
    },
    { ruta: 'empresa', titulo: 'Nuestra empresa y garantías', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'sobre' }, { tipo: 'proceso' }, { tipo: 'garantias' }] },
    { ruta: 'preguntas', titulo: 'Preguntas más frecuentes', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'faq' }] },
    { ruta: 'contacto', titulo: 'Contacto y zona de trabajo', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'contacto' }, { tipo: 'zona' }] },
  ],
  datos: {
    ...normal.datos,
    titular: 'Fontanería, desatascos, termos, calentadores y reformas de baño completas en toda la isla',
    subtitulo: repeat('Urgencias y trabajos programados con presupuesto cerrado antes de empezar,', 3).slice(0, 220),
    sobre: repeat('Somos una empresa familiar que trabaja con cuidado, explica cada paso y deja la casa limpia.', 12).slice(0, 1200),
    llamada_accion: 'Llámenos ahora y le decimos cuándo podemos ir a su casa sin compromiso',
    servicios: Array.from({ length: 12 }, (_, i) => ({
      nombre: i % 3 === 0 ? 'Instalaciones de fontanería completas para reformas integrales' : `Servicio número ${i + 1}`,
      descripcion: repeat('Descripción larga del servicio con detalles prácticos.', (i % 4) + 1).slice(0, 300),
      icono: i % 2 ? 'herramienta' : '',
    })),
    cifras: [
      { valor: '24/7', etiqueta: 'urgencias atendidas todos los días del año, también festivos' },
      { valor: '+1.500 clientes', etiqueta: 'en toda Gran Canaria' },
      { valor: '2 horas', etiqueta: 'de llegada media' },
      { valor: '100 %', etiqueta: 'de presupuestos cerrados' },
    ],
    proceso: Array.from({ length: 6 }, (_, i) => ({ titulo: `Paso ${i + 1}: ${repeat('revisión', (i % 3) + 1)}`, texto: repeat('Texto del paso con explicación.', 4) })),
    precios: {
      nota: 'Precios orientativos con impuestos incluidos; desplazamiento aparte fuera del área metropolitana y en festivos.',
      filas: Array.from({ length: 12 }, (_, i) => ({
        concepto: i % 2 ? `Concepto ${i + 1}` : 'Sustitución completa de termo eléctrico de cien litros con retirada del antiguo',
        precio: i % 3 ? `${30 + i * 5} €` : 'desde 1.250,00 €',
        detalle: repeat('Detalle del trabajo.', (i % 3) + 1),
      })),
    },
    garantias: Array.from({ length: 4 }, () => ({ titulo: 'Garantía por escrito de todos los trabajos', texto: repeat('Texto de la garantía bastante largo.', 4) })),
    zona: {
      texto: repeat('Trabajamos en toda la isla.', 8).slice(0, 400),
      lugares: ['Las Palmas de Gran Canaria', 'Telde', 'Arucas', 'Santa Brígida', 'Teror', 'Valsequillo de Gran Canaria', 'San Bartolomé de Tirajana', 'Mogán', 'Gáldar', 'Agaete', 'Ingenio', 'Agüimes'].map(
        (nombre) => ({ nombre }),
      ),
    },
    faq: Array.from({ length: 8 }, (_, i) => ({
      pregunta: i % 2 ? '¿Cuánto tarda?' : '¿Qué pasa si la avería es más grave de lo que parecía y hay que cambiar toda la instalación?',
      respuesta: repeat('Respuesta extensa con todos los detalles.', 10),
    })),
    horario: [
      { dias: 'Lunes a viernes', horas: '8:00 – 20:00' },
      { dias: 'Sábados', horas: '9:00 – 14:00' },
      { dias: 'Domingos y festivos', horas: 'Solo urgencias' },
    ],
    // 29/10/2026 — los títulos de sección los puede cambiar el cliente: la
    // plantilla tiene que aguantar uno de 90 caracteres donde puso «Precios».
    titulos: Object.fromEntries(
      SITE_TITLED_SECTIONS.map((t) => [t, 'Instalaciones de climatización y electrodomésticos en Las Palmas, Telde, Arucas y Gáldar']),
    ) as SiteContent['datos']['titulos'],
  },
  bloques: [
    { id: 'historia', tipo: 'texto_foto', titulo: 'Una historia larga de verdad, contada con calma y con muchos detalles', texto: repeat('Párrafo largo de la historia.', 40).slice(0, 2000), foto: 'assets/portada.jpg', fotoAlt: 'Foto', items: [], fotos: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], video: '' },
    { id: 'agosto', tipo: 'lista', titulo: 'Por qué elegirnos', texto: '', foto: '', fotoAlt: '', items: Array.from({ length: 8 }, (_, i) => ({ texto: repeat('Motivo número', (i % 3) + 1) + ` ${i + 1}`, icono: '' })), fotos: [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], video: '' },
    {
      id: 'galeria',
      tipo: 'galeria',
      titulo: 'Trabajos recientes en viviendas, locales y comunidades de toda la isla',
      texto: repeat('Una selección de obras terminadas.', 4),
      foto: '',
      fotoAlt: '',
      items: [],
      pestanas: [],
      comparativa: { columnas: [], destacada: -1, filas: [] },
      hitos: [], video: '',
      fotos: Array.from({ length: 13 }, (_, i) => ({ foto: 'assets/portada.jpg', alt: `Trabajo ${i + 1}`, texto: i % 3 ? '' : repeat('Pie de foto largo que explica el trabajo.', 3).slice(0, 160) })),
      productos: [],
    },
    {
      id: 'antes-despues',
      tipo: 'antes_despues',
      titulo: 'Así quedó el baño de la calle Triana después de la reforma completa',
      texto: '',
      foto: '',
      fotoAlt: '',
      items: [],
      pestanas: [],
      comparativa: { columnas: [], destacada: -1, filas: [] },
      hitos: [], video: '',
      fotos: [
        { foto: 'assets/portada.jpg', alt: 'El baño antes', texto: 'Antes de la reforma' },
        { foto: 'assets/portada.jpg', alt: 'El baño después', texto: 'Después de la reforma' },
      ],
      productos: [],
    },
    {
      id: 'catalogo',
      tipo: 'catalogo',
      titulo: 'Modelos de ventanas, puertas y mamparas que instalamos',
      texto: repeat('Todos a medida.', 3),
      foto: '',
      fotoAlt: '',
      items: [],
      pestanas: [],
      comparativa: { columnas: [], destacada: -1, filas: [] },
      hitos: [], video: '',
      fotos: [],
      productos: Array.from({ length: 9 }, (_, i) => ({
        nombre: i % 2 ? `Modelo ${i + 1}` : 'Ventana corredera de aluminio con rotura de puente térmico y doble vidrio',
        categoria: ['Ventanas', 'Puertas de entrada y de paso', 'Mamparas'][i % 3],
        foto: i === 4 ? '' : 'assets/portada.jpg',
        alt: `Modelo ${i + 1}`,
        descripcion: repeat('Descripción del modelo con sus ventajas.', (i % 3) + 1).slice(0, 300),
        caracteristicas: ['Rotura de puente térmico', 'Doble acristalamiento con cámara de aire', 'Herrajes de acero inoxidable'].slice(0, (i % 3) + 1),
        precio: i % 4 === 3 ? '' : i % 2 ? `desde ${300 + i * 50} €` : 'desde 1.250,00 € instalada',
      })),
    },
    // Tanda 2: pestañas, comparativa, trayectoria y marcas, al máximo.
    {
      ...bloqueVacio('pestanas', 'pestanas'),
      titulo: 'Soluciones para particulares, empresas y comunidades de propietarios',
      pestanas: Array.from({ length: 6 }, (_, i) => ({
        titulo: i % 2 ? `Pestaña ${i + 1}` : 'Comunidades de vecinos',
        texto: repeat('Texto largo de la pestaña con **negrita** y detalles.', 12).slice(0, 2000),
        foto: i % 3 ? 'assets/portada.jpg' : '',
        alt: 'Foto',
      })),
    },
    {
      ...bloqueVacio('comparativa', 'comparativa'),
      titulo: 'Aluminio con rotura de puente térmico frente a PVC y madera tratada',
      comparativa: {
        columnas: ['Aluminio RPT', 'PVC de alta gama', 'Madera tratada', 'Mixta'],
        destacada: 0,
        filas: Array.from({ length: 15 }, (_, i) => ({
          concepto: i % 2 ? `Característica ${i + 1}` : 'Aislamiento térmico y acústico en fachadas expuestas al viento',
          valores: ['sí', 'no', i % 3 ? 'Hasta 30 años con mantenimiento' : 'sí', ''],
        })),
      },
    },
    {
      ...bloqueVacio('trayectoria', 'trayectoria'),
      titulo: 'Más de treinta años trabajando en toda la isla',
      hitos: Array.from({ length: 12 }, (_, i) => ({
        fecha: i % 4 ? String(1990 + i * 3) : 'Primavera de 1994',
        titulo: i % 2 ? `Hito ${i + 1}` : 'Abrimos el primer taller en el polígono de El Sebadal',
        texto: repeat('Detalle del hito con algo de contexto.', (i % 3) + 1).slice(0, 300),
      })),
    },
    {
      ...bloqueVacio('marcas', 'marcas'),
      titulo: 'Trabajamos con las mejores marcas y certificaciones del sector',
      fotos: Array.from({ length: 9 }, (_, i) => ({ foto: 'assets/portada.jpg', alt: `Marca ${i + 1}`, texto: i % 2 ? 'Instalador oficial certificado' : '' })),
    },
    // Tanda 3: un vídeo con portada propia y otro sin ella. Son vídeos de
    // muestra de las propias plataformas; no se cargan si nadie los pulsa.
    {
      ...bloqueVacio('video', 'video'),
      titulo: 'Así instalamos una ventana corredera en una mañana, de principio a fin',
      texto: repeat('Un vídeo corto del trabajo.', 3),
      video: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      foto: 'assets/portada.jpg',
      fotoAlt: 'Instalación de una ventana',
    },
    { ...bloqueVacio('video-vimeo', 'video'), titulo: 'Nuestro taller', video: 'https://vimeo.com/76979871' },
  ],
  ejemplos: [],
  blog: {
    titulo: 'Consejos y noticias',
    intro: repeat('Todo lo que conviene saber sobre la fontanería de su casa, explicado con calma.', 4).slice(0, 300),
    entradas: Array.from({ length: 12 }, (_, i) => ({
      slug: `entrada-${i + 1}`,
      titulo: i % 2 ? `Entrada ${i + 1}` : 'Todo lo que debe revisar en la instalación de agua de una vivienda antigua antes de comprarla o reformarla',
      metaTitulo: '',
      metaDescripcion: '',
      fecha: `2026-${String(10 - (i % 9)).padStart(2, '0')}-${String(28 - i).padStart(2, '0')}`,
      extracto: i % 3 ? repeat('Extracto largo de la entrada con bastante detalle.', 6).slice(0, 300) : '',
      texto: [
        repeat('Párrafo largo de la entrada.', 30),
        '## Un subtítulo largo que ocupa más de una línea en el móvil y en escritorio',
        repeat('Otro párrafo.', 40),
        '- Punto uno bastante largo para ver cómo parte la línea\n- Punto dos\n- Punto tres',
        'https://ejemplo.invalid/una-direccion-muy-larga-sin-espacios-que-no-debe-desbordar-el-ancho-de-la-pagina-en-movil',
      ].join('\n\n'),
      foto: i === 0 ? 'assets/portada.jpg' : '',
      fotoAlt: 'Foto',
      publicada: true,
      origen: 'cliente' as const,
      html: '',
    })),
  },
};

const minimo: SiteContent = {
  ...normal,
  datos: {
    ...normal.datos,
    sobre: '',
    servicios: normal.datos.servicios.slice(0, 1),
    cifras: normal.datos.cifras.slice(0, 1),
    proceso: normal.datos.proceso.slice(0, 1),
    precios: { nota: '', filas: normal.datos.precios.filas.slice(0, 1) },
    garantias: normal.datos.garantias.slice(0, 1),
    zona: { texto: '', lugares: normal.datos.zona.lugares.slice(0, 1) },
    faq: normal.datos.faq.slice(0, 1),
  },
  ejemplos: ['cifras.0.valor', 'precios.filas.0.precio'],
  blog: { titulo: 'Blog', intro: '', entradas: [{ ...normal.blog.entradas[1], extracto: '', texto: 'Una línea.' }] },
};

export const SITE_CONTENT_SAMPLES = { normal, exagerado, minimo } as const;
export type SiteContentSampleName = keyof typeof SITE_CONTENT_SAMPLES;

// -----------------------------------------------------------------------------
// 30/10/2026 — el contenido de muestra de cada sector. Hasta hoy todas las
// plantillas se veían en el laboratorio con «Fontanería Ejemplo»: con la de
// salud, Orlando vio un fontanero con colores de clínica («Localizamos la
// avería…» junto a un sillón de dentista) y no había forma de juzgarla. Ahora
// la vista previa y plantilla-a-mano.ts usan el del sector de la plantilla.
//
// SITE_CONTENT_SAMPLES se queda como estaba (lo usan muchas pruebas y es el de
// oficios). El «exagerado» de salud cambia los textos, no las medidas: los
// mismos topes, los mismos títulos de tres líneas.
// -----------------------------------------------------------------------------

const healthNormal: SiteContent = {
  ...normal,
  paginas: [defaultHomePage()],
  datos: {
    ...normal.datos,
    titular: 'Tu sonrisa en buenas manos, sin prisas y sin sustos',
    subtitulo: 'Revisiones, limpiezas, implantes y ortodoncia. Te explicamos cada tratamiento y su precio antes de empezar.',
    sobre:
      'Somos una clínica de barrio donde te atiende **siempre el mismo equipo** y te explicamos cada paso.\n\nEn la primera visita revisamos:\n- Dientes y encías, con radiografía si hace falta\n- Lo que te preocupa y las opciones que tienes',
    llamada_accion: 'Llámanos y te damos cita esta misma semana',
    servicios: [
      { nombre: 'Limpieza y revisión', descripcion: 'Una vez al año, para evitar problemas mayores.', icono: 'diente' },
      { nombre: 'Implantes', descripcion: 'Recupera la pieza que falta con un plan claro.', icono: 'escudo' },
      { nombre: 'Ortodoncia', descripcion: 'Brackets o alineadores transparentes.', icono: 'chispa' },
      { nombre: 'Urgencias dentales', descripcion: 'Dolor, un golpe o una pieza rota: te vemos el mismo día.', icono: 'reloj' },
    ],
    cifras: [
      { valor: 'Mismo día', etiqueta: 'en urgencias, siempre que se pueda' },
      { valor: '20 años', etiqueta: 'cuidando sonrisas en el barrio' },
    ],
    proceso: [
      { titulo: 'Pides cita', texto: 'Por teléfono o por el formulario, a la hora que te venga bien.' },
      { titulo: 'Primera visita', texto: 'Revisamos tu boca y te contamos qué vemos, sin compromiso.' },
      { titulo: 'Tu plan', texto: 'Te damos el tratamiento por escrito, con su precio y sus plazos.' },
    ],
    precios: {
      nota: 'Precios orientativos; el plan con su precio cerrado te lo damos en la primera visita.',
      filas: [
        { concepto: 'Primera visita y revisión', precio: 'Gratis', detalle: '' },
        { concepto: 'Limpieza dental', precio: 'Desde 45 €', detalle: 'Con pulido y revisión de encías.' },
        { concepto: 'Empaste', precio: 'Desde 50 €', detalle: 'Según la pieza y el tamaño.' },
      ],
    },
    garantias: [
      { titulo: 'Primera visita sin compromiso', texto: 'Te explicamos lo que vemos y las opciones, y decides con calma.' },
      { titulo: 'Financiación sin intereses', texto: 'Los tratamientos largos, en cómodos plazos.' },
    ],
    zona: { texto: 'Pacientes de toda la ciudad y de los municipios cercanos.', lugares: normal.datos.zona.lugares },
    faq: [
      { pregunta: '¿La primera visita tiene coste?', respuesta: 'No: la revisión y el presupuesto son **gratis** y sin compromiso.' },
      { pregunta: '¿Trabajáis con mutuas?', respuesta: 'Sí, con las principales aseguradoras. Pregúntanos por la tuya.' },
    ],
    horario: [
      { dias: 'Lunes a viernes', horas: '9:00 – 20:00' },
      { dias: 'Sábados', horas: '9:00 – 13:00' },
    ],
  },
  bloques: [
    { ...bloqueVacio('historia', 'texto'), titulo: 'Nuestra historia', texto: 'Abrimos en 2006 con un solo sillón y las mismas ganas que hoy.' },
    { ...bloqueVacio('agosto', 'aviso'), titulo: 'Agosto', texto: 'Cerrado del 10 al 20 de agosto. Para urgencias, llámanos y te indicamos.' },
  ],
  legal: { titular: 'Clínica Dental Ejemplo S.L.', nif: 'B00000000', domicilio: 'Calle de Muestra, 1, Las Palmas de Gran Canaria', email: 'hola@clinica-ejemplo.invalid', registro: '' },
  blog: {
    titulo: 'Blog',
    intro: 'Consejos para cuidar tus dientes, contados sin tecnicismos.',
    entradas: [
      {
        ...normal.blog.entradas[0],
        slug: 'cada-cuanto-una-limpieza',
        titulo: '¿Cada cuánto hay que hacerse una limpieza dental?',
        extracto: 'Depende de tus encías más que del calendario: te contamos cómo saberlo.',
        texto:
          'Para la mayoría basta con una al año.\n\n## Cuándo conviene antes\n\n- Si te sangran las encías al cepillarte\n- Si fumas\n- Si llevas ortodoncia\n\nSi tienes dudas, [escríbenos](mailto:hola@clinica-ejemplo.invalid).',
      },
      {
        ...normal.blog.entradas[1],
        slug: 'brackets-o-alineadores',
        titulo: 'Brackets o alineadores transparentes: cuál te conviene',
        texto: 'Los dos corrigen lo mismo; cambian la comodidad y el precio.\n\nLos alineadores se quitan para comer; los brackets no dependen de que te acuerdes de ponerlos.',
      },
    ],
  },
};
healthNormal.paginas[0].secciones.splice(4, 0, { tipo: 'bloque', id: 'historia' });
healthNormal.paginas[0].secciones.unshift({ tipo: 'bloque', id: 'agosto' });

const healthExagerado: SiteContent = {
  ...exagerado,
  datos: {
    ...exagerado.datos,
    titular: 'Odontología, implantes, ortodoncia invisible, periodoncia y estética dental en la isla',
    subtitulo: repeat('Primera visita y presupuesto sin compromiso, con financiación para tratamientos largos,', 3).slice(0, 220),
    sobre: repeat('Somos una clínica familiar que atiende con calma, explica cada tratamiento y cuida cada detalle.', 12).slice(0, 1200),
    llamada_accion: 'Llámanos ahora y te buscamos un hueco esta semana para tu primera visita sin compromiso',
    servicios: exagerado.datos.servicios.map((s, i) => ({
      ...s,
      nombre: i % 3 === 0 ? 'Implantología avanzada y rehabilitación oral completa con carga inmediata' : `Tratamiento número ${i + 1}`,
      icono: i % 2 ? 'diente' : '',
    })),
    precios: {
      ...exagerado.datos.precios,
      filas: exagerado.datos.precios.filas.map((f, i) => ({ ...f, concepto: i % 2 ? f.concepto : 'Implante dental de titanio con corona de zirconio y estudio radiológico incluido' })),
    },
    garantias: exagerado.datos.garantias.map((g) => ({ ...g, titulo: 'Garantía por escrito de todos los tratamientos' })),
    faq: exagerado.datos.faq.map((f, i) => ({ ...f, pregunta: i % 2 ? '¿Duele?' : '¿Qué pasa si en la primera visita vemos que el tratamiento es más largo de lo que esperabas?' })),
    titulos: Object.fromEntries(
      SITE_TITLED_SECTIONS.map((t) => [t, 'Tratamientos de implantología y ortodoncia invisible en Las Palmas, Telde, Arucas y Gáldar']),
    ) as SiteContent['datos']['titulos'],
  },
  legal: healthNormal.legal,
  blog: { ...exagerado.blog, intro: repeat('Todo lo que conviene saber para cuidar tu boca, explicado con calma.', 4).slice(0, 300) },
};

/** El «mínimo» de un sector, recortado de su «normal» igual que el de oficios. */
function minimoDe(n: SiteContent): SiteContent {
  return {
    ...n,
    datos: {
      ...n.datos,
      sobre: '',
      servicios: n.datos.servicios.slice(0, 1),
      cifras: n.datos.cifras.slice(0, 1),
      proceso: n.datos.proceso.slice(0, 1),
      precios: { nota: '', filas: n.datos.precios.filas.slice(0, 1) },
      garantias: n.datos.garantias.slice(0, 1),
      zona: { texto: '', lugares: n.datos.zona.lugares.slice(0, 1) },
      faq: n.datos.faq.slice(0, 1),
    },
    ejemplos: ['cifras.0.valor', 'precios.filas.0.precio'],
    blog: { titulo: 'Blog', intro: '', entradas: [{ ...n.blog.entradas[1], extracto: '', texto: 'Una línea.' }] },
  };
}

const healthMinimo = minimoDe(healthNormal);

const HEALTH_RENDER_CONTEXT: SiteRenderContext = {
  ...SAMPLE_RENDER_CONTEXT,
  negocio: { ...SAMPLE_RENDER_CONTEXT.negocio, nombre: 'Clínica Dental Ejemplo' },
  citasHtml: renderCitasHtml([
    { title: 'Te lo explican todo', quote: 'Me explicaron todo con mucha paciencia.', author: 'Paciente A.' },
    { title: 'Sin miedo', quote: 'Venía con miedo y no sentí nada.', author: 'Paciente B.' },
    { title: 'Trato cercano', quote: 'Un trato muy cercano y profesional.', author: 'Paciente C.' },
  ]),
  resenasHtml: renderResenasHtml([
    { ref: 'a', rating: 5, text: 'Me explicaron todo con mucha paciencia y sin prisas. Muy recomendable.', translated: false, author: 'Paciente A.', authorUri: null, relativeTime: 'Hace un año' },
    { ref: 'b', rating: 5, text: 'Venía con miedo después de una mala experiencia y no sentí nada. Un equipo encantador.', translated: false, author: 'Paciente B.', authorUri: null, relativeTime: 'Hace 10 meses' },
    { ref: 'c', rating: 4, text: 'Buen trato y puntuales con la cita; volveré.', translated: true, author: 'Paciente C.', authorUri: null, relativeTime: 'Hace 2 meses' },
  ]),
};

// Belleza (30/10/2026): Atelier y Estudio también se veían con la fontanería.
// Una peluquería, que es lo que son todos los prospectos del sector.
const beautyNormal: SiteContent = {
  ...normal,
  paginas: [defaultHomePage()],
  datos: {
    ...normal.datos,
    titular: 'Tu pelo como lo imaginas, sin prisas y sin sorpresas',
    subtitulo: 'Cortes, color, mechas y peinados. Te asesoramos antes de empezar y te decimos el precio de entrada.',
    sobre:
      'Somos un salón de barrio donde **escuchamos antes de cortar** y te explicamos qué le va a tu pelo.\n\nTrabajamos con:\n- Color sin amoniaco\n- Tratamientos para cabello dañado',
    llamada_accion: 'Pide tu cita y te buscamos hueco esta semana',
    servicios: [
      { nombre: 'Corte y peinado', descripcion: 'Para mujer, hombre y niños.', icono: 'tijeras' },
      { nombre: 'Color y mechas', descripcion: 'Balayage, mechas y tinte sin amoniaco.', icono: 'gota' },
      { nombre: 'Tratamientos', descripcion: 'Hidratación y keratina para recuperar el brillo.', icono: 'hoja' },
      { nombre: 'Recogidos y novias', descripcion: 'Peinados para bodas y ocasiones especiales.', icono: 'chispa' },
    ],
    cifras: [
      { valor: 'Sin esperas', etiqueta: 'trabajamos siempre con cita' },
      { valor: '12 años', etiqueta: 'cuidando melenas en el barrio' },
    ],
    proceso: [
      { titulo: 'Pides cita', texto: 'Por teléfono o por el formulario, a la hora que te venga bien.' },
      { titulo: 'Te asesoramos', texto: 'Vemos tu pelo y te proponemos lo que mejor te va.' },
      { titulo: 'Sales como querías', texto: 'Y con consejos para mantenerlo en casa.' },
    ],
    precios: {
      nota: 'Precios orientativos; según el largo te decimos el precio antes de empezar.',
      filas: [
        { concepto: 'Corte y peinado', precio: 'Desde 25 €', detalle: '' },
        { concepto: 'Color', precio: 'Desde 35 €', detalle: 'Raíz o completo, según el largo.' },
        { concepto: 'Mechas balayage', precio: 'Desde 70 €', detalle: 'Con matiz y peinado.' },
      ],
    },
    garantias: [
      { titulo: 'Asesoramiento sin compromiso', texto: 'Te decimos qué le va a tu pelo antes de empezar.' },
      { titulo: 'Productos profesionales', texto: 'Y te recomendamos los que te van para casa.' },
    ],
    zona: { texto: 'Clientes de toda la ciudad y de los municipios cercanos.', lugares: normal.datos.zona.lugares },
    faq: [
      { pregunta: '¿Hace falta cita?', respuesta: 'Sí, así **no esperas**. Llámanos o escríbenos.' },
      { pregunta: '¿Cortáis a niños?', respuesta: 'Sí, a partir de los dos años.' },
    ],
    horario: [
      { dias: 'Martes a viernes', horas: '9:30 – 19:30' },
      { dias: 'Sábados', horas: '9:00 – 14:00' },
    ],
  },
  bloques: [
    { ...bloqueVacio('historia', 'texto'), titulo: 'Nuestra historia', texto: 'Abrimos en 2014 con dos sillones y las mismas ganas que hoy.' },
    { ...bloqueVacio('agosto', 'aviso'), titulo: 'Agosto', texto: 'Cerrado del 10 al 20 de agosto.' },
  ],
  legal: { titular: 'Peluquería Ejemplo S.L.', nif: 'B00000000', domicilio: 'Calle de Muestra, 1, Las Palmas de Gran Canaria', email: 'hola@peluqueria-ejemplo.invalid', registro: '' },
  blog: {
    titulo: 'Blog',
    intro: 'Consejos para cuidar tu pelo entre visita y visita.',
    entradas: [
      {
        ...normal.blog.entradas[0],
        slug: 'cada-cuanto-cortar-las-puntas',
        titulo: '¿Cada cuánto hay que cortar las puntas?',
        extracto: 'Depende de tu pelo y de cómo lo lleves: te contamos cómo saberlo.',
        texto:
          'Para la mayoría, cada dos o tres meses.\n\n## Cuándo conviene antes\n\n- Si se te abren las puntas\n- Si usas plancha a diario\n- Si te has hecho mechas\n\nSi tienes dudas, [escríbenos](mailto:hola@peluqueria-ejemplo.invalid).',
      },
      {
        ...normal.blog.entradas[1],
        slug: 'mechas-o-balayage',
        titulo: 'Mechas o balayage: en qué se diferencian',
        texto: 'Las dos aclaran; cambia cómo se reparte el color.\n\nEl balayage se pinta a mano y crece sin que se note la raíz; las mechas marcan más.',
      },
    ],
  },
};
beautyNormal.paginas[0].secciones.splice(4, 0, { tipo: 'bloque', id: 'historia' });
beautyNormal.paginas[0].secciones.unshift({ tipo: 'bloque', id: 'agosto' });

const beautyExagerado: SiteContent = {
  ...exagerado,
  datos: {
    ...exagerado.datos,
    titular: 'Cortes, color, mechas balayage, keratina, recogidos y peinados de novia en toda la isla',
    subtitulo: repeat('Asesoramiento personalizado antes de empezar y precio cerrado según el largo de tu pelo,', 3).slice(0, 220),
    sobre: repeat('Somos un salón familiar que escucha antes de cortar, cuida cada melena y explica cada tratamiento.', 12).slice(0, 1200),
    llamada_accion: 'Llámanos ahora y te buscamos un hueco esta semana para tu corte, color o tratamiento',
    servicios: exagerado.datos.servicios.map((s, i) => ({
      ...s,
      nombre: i % 3 === 0 ? 'Alisado de keratina con tratamiento hidratante y peinado profesional incluido' : `Servicio número ${i + 1}`,
      icono: i % 2 ? 'tijeras' : '',
    })),
    precios: {
      ...exagerado.datos.precios,
      filas: exagerado.datos.precios.filas.map((f, i) => ({ ...f, concepto: i % 2 ? f.concepto : 'Mechas balayage con matiz, tratamiento reparador y peinado en melena muy larga' })),
    },
    garantias: exagerado.datos.garantias.map((g) => ({ ...g, titulo: 'Asesoramiento personalizado antes de cada servicio' })),
    faq: exagerado.datos.faq.map((f, i) => ({ ...f, pregunta: i % 2 ? '¿Cuánto tarda?' : '¿Qué pasa si el color no queda como esperabas después de la primera sesión en el salón?' })),
    titulos: Object.fromEntries(
      SITE_TITLED_SECTIONS.map((t) => [t, 'Peluquería, coloración y tratamientos capilares en Las Palmas, Telde, Arucas y Gáldar']),
    ) as SiteContent['datos']['titulos'],
  },
  legal: beautyNormal.legal,
  blog: { ...exagerado.blog, intro: repeat('Todo lo que conviene saber para cuidar tu pelo, explicado con calma.', 4).slice(0, 300) },
};

const BEAUTY_RENDER_CONTEXT: SiteRenderContext = {
  ...SAMPLE_RENDER_CONTEXT,
  negocio: { ...SAMPLE_RENDER_CONTEXT.negocio, nombre: 'Peluquería Ejemplo' },
  citasHtml: renderCitasHtml([
    { title: 'Te escuchan', quote: 'Me escucharon antes de cortar.', author: 'Clienta A.' },
    { title: 'El color perfecto', quote: 'El color quedó justo como lo quería.', author: 'Clienta B.' },
    { title: 'Sin prisas', quote: 'Un sitio agradable donde no te meten prisa.', author: 'Cliente C.' },
  ]),
  resenasHtml: renderResenasHtml([
    { ref: 'a', rating: 5, text: 'Me escucharon antes de cortar y salí con el pelo que quería. Muy recomendable.', translated: false, author: 'Clienta A.', authorUri: null, relativeTime: 'Hace un año' },
    { ref: 'b', rating: 5, text: 'El color quedó justo como lo quería y me explicaron cómo cuidarlo en casa.', translated: false, author: 'Clienta B.', authorUri: null, relativeTime: 'Hace 10 meses' },
    { ref: 'c', rating: 4, text: 'Buen corte y buen ambiente; volveré.', translated: true, author: 'Cliente C.', authorUri: null, relativeTime: 'Hace 2 meses' },
  ]),
};

const BY_SECTOR: Readonly<Record<string, { samples: Record<SiteContentSampleName, SiteContent>; context: SiteRenderContext }>> = {
  health: { samples: { normal: healthNormal, exagerado: healthExagerado, minimo: healthMinimo }, context: HEALTH_RENDER_CONTEXT },
  beauty: { samples: { normal: beautyNormal, exagerado: beautyExagerado, minimo: minimoDe(beautyNormal) }, context: BEAUTY_RENDER_CONTEXT },
};

/** Los contenidos de muestra y el contexto con los que se ve una plantilla de
 *  ese sector. Un sector sin muestra propia usa la de oficios. */
export function sectorSamples(sector: string | null | undefined): { samples: Record<SiteContentSampleName, SiteContent>; context: SiteRenderContext } {
  return (sector && BY_SECTOR[sector]) || { samples: SITE_CONTENT_SAMPLES, context: SAMPLE_RENDER_CONTEXT };
}
