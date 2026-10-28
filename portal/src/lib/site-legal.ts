import type { SiteLegal } from './site-content';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — las páginas legales de la web de un
// cliente: aviso legal (art. 10 LSSI), privacidad (RGPD) y cookies.
//
// Las escribe el CÓDIGO con los datos del titular, no la IA: un texto legal
// que cambia cada vez que se genera no se puede revisar una vez y darlo por
// bueno. Salen en formato básico (site-markdown.ts) y se pintan con la pieza
// «bloque_texto» de la plantilla, así que se ven con el diseño de su web.
//
// PENDIENTE: que el abogado revise estos tres textos antes de publicar la
// primera web de un cliente. Están escritos para el caso real de hoy: una web
// de una página, sin cookies, con un formulario cuyos mensajes recoge
// Kairikos como encargado del tratamiento (art. 28 RGPD; el contrato de
// encargo está en Kairikos/legal).
//
// Dos cosas que conviene saber y que están escritas en los propios textos:
// - Las webs no ponen cookies (ni analítica ni publicidad), así que no hace
//   falta aviso de cookies. El día que se añada Google Analytics (entrega 6,
//   el SEO), hará falta el aviso y bloquear la analítica hasta que acepten.
// - Las tipografías se sirven desde la propia web (site-fonts.ts, desde el
//   27/10/2026): el navegador del visitante no se conecta a Google, y por eso
//   la política de privacidad ya no lo menciona. Si algún día una web vuelve
//   a cargar algo de un tercero, hay que declararlo aquí.
// - 28/10/2026: eso ya pasa con el bloque de vídeo (site-rich-blocks.ts). No
//   carga nada de YouTube o Vimeo hasta que el visitante pulsa, y entonces lo
//   hace en su modo más privado (youtube-nocookie.com, Vimeo con «dnt»). Pulsar
//   es la acción con la que el visitante pide el vídeo, así que no hace falta
//   aviso al entrar; pero cookies y privacidad lo explican cuando la web tiene
//   algún vídeo. PENDIENTE también de la revisión del abogado.
// =============================================================================

export type LegalOptions = { videos?: ('youtube' | 'vimeo')[] };

const VIDEO_PROVIDERS = {
  youtube: { nombre: 'YouTube (Google)', politica: 'https://policies.google.com/privacy' },
  vimeo: { nombre: 'Vimeo', politica: 'https://vimeo.com/privacy' },
} as const;

export const LEGAL_PAGES = [
  { ruta: 'aviso-legal', titulo: 'Aviso legal' },
  { ruta: 'privacidad', titulo: 'Privacidad' },
  { ruta: 'cookies', titulo: 'Cookies' },
] as const;
export type LegalPagePath = (typeof LEGAL_PAGES)[number]['ruta'];

export function legalPageMarkdown(ruta: LegalPagePath, legal: SiteLegal, businessName: string, options: LegalOptions = {}): { titulo: string; texto: string } {
  const titular = legal.titular || businessName;
  const videos = (options.videos ?? []).map((v) => VIDEO_PROVIDERS[v]);
  const quienes = videos.map((v) => v.nombre).join(' y ');
  const politicas = videos.map((v) => `[${v.nombre}](${v.politica})`).join(' y ');
  const ident = [
    `**Titular:** ${titular}`,
    `**NIF:** ${legal.nif}`,
    `**Domicilio:** ${legal.domicilio}`,
    `**Correo electrónico:** [${legal.email}](mailto:${legal.email})`,
    legal.registro ? `**Datos registrales:** ${legal.registro}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  switch (ruta) {
    case 'aviso-legal':
      return {
        titulo: 'Aviso legal',
        texto: [
          `En cumplimiento del artículo 10 de la Ley 34/2002, de servicios de la sociedad de la información y de comercio electrónico (LSSI), se informa de los datos del titular de esta web:`,
          ident,
          `**Uso de la web.** Quien navega por esta web acepta usarla de buena fe y conforme a la ley. Los contenidos tienen carácter informativo; los precios que se indiquen son orientativos salvo que se diga lo contrario, y el presupuesto definitivo se da antes de empezar cada trabajo.`,
          `**Propiedad intelectual.** Los textos, imágenes y diseño de esta web pertenecen a su titular o se usan con permiso. No se pueden reproducir sin autorización.`,
          `**Responsabilidad.** El titular no se hace responsable de los daños derivados de un uso indebido de la web ni de los contenidos de las webs de terceros a las que pueda enlazar.`,
        ].join('\n\n'),
      };
    case 'privacidad':
      return {
        titulo: 'Política de privacidad',
        texto: [
          `**Responsable del tratamiento.**`,
          ident,
          `**Qué datos tratamos y para qué.** Si nos escribe por el formulario de contacto, tratamos su nombre, su teléfono o correo y su mensaje para responder a su consulta y, si lo pide, preparar un presupuesto. No usamos sus datos para nada más ni los cedemos a terceros, salvo obligación legal.`,
          `**Base legal.** Su consentimiento al enviar el formulario y, cuando pide un presupuesto, la aplicación de medidas precontractuales a petición suya (art. 6.1.a y 6.1.b del RGPD).`,
          `**Encargado del tratamiento.** El alojamiento de esta web y la recepción de los mensajes del formulario los presta Kairikos, como encargado del tratamiento, con un contrato que le obliga a usar los datos solo para ese fin (art. 28 del RGPD).`,
          `**Cuánto tiempo.** Conservamos los mensajes mientras sean necesarios para atender su consulta y, después, durante los plazos que exija la ley.`,
          ...(videos.length
            ? [
                `**Vídeos.** Esta web incluye vídeos de ${quienes}. No se cargan hasta que usted pulsa para reproducirlos; al hacerlo, su navegador se conecta a ${quienes}, que recibe su dirección IP y datos técnicos de su navegador y los trata según su propia política de privacidad (${politicas}). Si no pulsa, no se le envía nada.`,
              ]
            : []),
          `**Sus derechos.** Puede pedir acceso, rectificación, supresión, oposición, limitación y portabilidad de sus datos escribiendo a [${legal.email}](mailto:${legal.email}). Si considera que no se han atendido, puede reclamar ante la Agencia Española de Protección de Datos ([www.aepd.es](https://www.aepd.es)).`,
        ].join('\n\n'),
      };
    case 'cookies':
      return {
        titulo: 'Cookies',
        texto: [
          videos.length
            ? `Esta web **no instala cookies** al entrar: ni propias ni de terceros, ni de análisis, ni de publicidad, ni de seguimiento. Por eso no le pedimos que acepte ninguna.`
            : `Esta web **no utiliza cookies** propias ni de terceros: ni de análisis, ni de publicidad, ni de seguimiento. Por eso no le pedimos que acepte ninguna al entrar.`,
          ...(videos.length
            ? [
                `**Vídeos de ${quienes}.** Algunas páginas muestran vídeos de ${quienes}. Mientras no los pulse, el vídeo es solo una imagen de esta web y no se conecta con ${quienes}. Si pulsa para reproducirlo, el vídeo se carga desde ${quienes} en su modo de privacidad reforzada, y a partir de ese momento ${quienes} puede instalar cookies o guardar datos en su navegador según su propia política (${politicas}). Si prefiere evitarlo, no pulse el vídeo.`,
              ]
            : []),
          `Si en el futuro se añadieran cookies que no sean estrictamente necesarias, se le pedirá su consentimiento antes de instalarlas y esta página lo explicará.`,
          `Para cualquier duda puede escribir a [${legal.email}](mailto:${legal.email}).`,
        ].join('\n\n'),
      };
  }
}
