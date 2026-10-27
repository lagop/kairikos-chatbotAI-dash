import { defaultHomePage, type SiteContent } from './site-content';
import type { SiteRenderContext } from './site-template';

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
  },
  bloques: [
    { id: 'historia', tipo: 'texto', titulo: 'Nuestra historia', texto: 'Empezamos con una furgoneta y muchas ganas.', foto: '', fotoAlt: '', items: [] },
    { id: 'agosto', tipo: 'aviso', titulo: 'Agosto', texto: 'Cerrado del 10 al 20 de agosto.', foto: '', fotoAlt: '', items: [] },
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
  seccionesConfirmadas: [],
};
normal.paginas[0].secciones.splice(4, 0, { tipo: 'bloque', id: 'historia' });
normal.paginas[0].secciones.unshift({ tipo: 'bloque', id: 'agosto' });

const repeat = (s: string, n: number) => Array.from({ length: n }, () => s).join(' ');

const exagerado: SiteContent = {
  ...normal,
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
  },
  bloques: [
    { id: 'historia', tipo: 'texto_foto', titulo: 'Una historia larga de verdad, contada con calma y con muchos detalles', texto: repeat('Párrafo largo de la historia.', 40).slice(0, 2000), foto: 'assets/portada.jpg', fotoAlt: 'Foto', items: [] },
    { id: 'agosto', tipo: 'lista', titulo: 'Por qué elegirnos', texto: '', foto: '', fotoAlt: '', items: Array.from({ length: 8 }, (_, i) => ({ texto: repeat('Motivo número', (i % 3) + 1) + ` ${i + 1}`, icono: '' })) },
  ],
  ejemplos: [],
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
};

export const SITE_CONTENT_SAMPLES = { normal, exagerado, minimo } as const;
export type SiteContentSampleName = keyof typeof SITE_CONTENT_SAMPLES;
