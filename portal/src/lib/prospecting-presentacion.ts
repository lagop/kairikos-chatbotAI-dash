// =============================================================================
// El primer mensaje de Prospección, y la frase con la que el cliente se
// presenta en él.
//
// NO lleva 'server-only' a propósito: lo importan TANTO el envío a Meta
// (prospecting-templates.ts, prospecting-contact.ts) COMO la vista previa del
// portal (ProspectingProfileCard.tsx). El texto de la plantilla vive aquí y en
// ningún otro sitio, para que lo que el cliente ve al autorizar sea
// literalmente lo que se envía. Una copia del texto en el componente sería la
// que se queda atrás — y aquí quedarse atrás significa que alguien autoriza un
// mensaje y se envía otro, en su nombre. Es puro y sin dependencias; no hay
// nada que proteger dejándolo fuera del cliente.
//
// POR QUÉ HAY UNA v2 (28/09/2026). La v1 decía «creemos que podríamos
// ayudarte a conseguir más clientes». Eso lo dice una agencia de marketing —
// era la mirada de Kairikos, que vende eso— y no una empresa de reformas que
// escribe a un administrador de fincas, que es el cliente real de este
// producto. La v2 no promete nada por el cliente: dice a qué se dedica, con
// sus propias palabras, y pregunta.
//
// Y POR QUÉ CON NOMBRE NUEVO. Cambiar el texto de una plantilla que ya está
// aprobada en Meta conservando el nombre no cambia lo que se envía: en
// WhatsApp viaja el cuerpo APROBADO. recall-templates.ts lo aprendió en
// producción — el código creía enviar un aviso y no lo enviaba. Nombre nuevo,
// siempre.
// =============================================================================

/**
 * El cuerpo de prospecting_first_contact_v2.
 *
 *   {{1}} el negocio al que se escribe (el prospecto)
 *   {{2}} el negocio que escribe (el cliente)
 *   {{3}} a qué se dedica el cliente, en sus palabras
 *
 * Cumple las dos reglas de Meta que ya rechazaron borradores en vivo (ver
 * recall-templates.ts): no empieza ni termina en una variable
 * (error_subcode 2388299) y lleva bastantes palabras por variable
 * (2388293). Hay un test que comprueba las dos.
 *
 * «te» y no «os»: la web se dirige también a Latinoamérica, donde el
 * «vosotros» suena a otro país.
 */
export const PRIMER_CONTACTO_TEXTO =
  'Hola {{1}}, te escribo de {{2}}. Nos dedicamos a {{3}} y creemos que te puede interesar. ¿Te cuento en dos líneas, sin compromiso?';

/** Cuánto puede medir la presentación. Es media frase dentro de otra: más
 *  larga, el mensaje deja de leerse de un vistazo en un móvil. */
export const PRESENTACION_MAX = 80;

/** El tope diario de mensajes automáticos (los tres toques cuentan). Vive
 *  aquí porque el texto del consentimiento lo cita: si un día cambia, el
 *  cliente tiene que leer el número nuevo, no el viejo. El porqué del tope,
 *  en MAX_AUTO_CONTACTS_PER_DAY (prospecting-contact.ts). */
export const MAX_CONTACTOS_POR_DIA = 20;

/** Lo que se usa en la vista previa cuando el prospecto aún no existe. */
export const PROSPECTO_DE_EJEMPLO = 'Fincas Ribera';

/**
 * Sustituye {{n}} por los parámetros, en orden. Lo mismo que hace Meta al
 * enviar, para que la vista previa sea exactamente el mensaje.
 */
export function rellenarPlantilla(texto: string, params: readonly string[]): string {
  return texto.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? `{{${n}}}`);
}

/**
 * Deja la presentación lista para ir dentro de «Nos dedicamos a {{3}} y…».
 *
 * Tres correcciones, todas de errores que la gente comete de verdad al
 * rellenar un campo así:
 *
 * - Quita un «nos dedicamos a» delante. El campo ya va precedido de eso, y
 *   repetirlo da «Nos dedicamos a nos dedicamos a las reformas».
 * - Quita la puntuación final. Detrás va «y creemos que…», así que un punto
 *   al final daría «…de baños. y creemos».
 * - Junta los espacios y quita los saltos de línea. Meta RECHAZA el envío si
 *   un parámetro lleva saltos de línea, tabuladores o más de cuatro espacios
 *   seguidos — y ese fallo no llega al revisar la plantilla, llega al enviar,
 *   mensaje a mensaje.
 *
 * Devuelve null si no queda nada: una presentación vacía no se envía nunca.
 * NO recorta a PRESENTACION_MAX: una frase cortada a la mitad dentro de un
 * mensaje en nombre del cliente es peor que pedirle que la acorte. Eso lo
 * decide quien llama.
 */
export function normalizarPresentacion(bruta: string | null | undefined): string | null {
  if (!bruta) return null;

  const sinPuntoFinal = (s: string) => s.replace(/[\s.,;:!?¡¿…]+$/u, '').trim();

  // La puntuación final se quita ANTES del prefijo, no solo después: con
  // «Nos dedicamos a.» el prefijo no casaba (detrás de la «a» venía un
  // punto, no un espacio) y quedaba «a», que daba «Nos dedicamos a a y
  // creemos…». Lo encontró el test de la puerta de consentimiento.
  let t = sinPuntoFinal(bruta.replace(/\s+/g, ' ').trim());

  // «al» se quita entero, como «a»: «Nos dedicamos al mantenimiento» queda
  // «mantenimiento», y no «l mantenimiento». La palabra tiene que acabar ahí
  // —«alquileres» no se toca—.
  t = t.replace(/^nos\s+dedicamos(?:\s+al?)?(?:\s+|$)/i, '');

  // Un «el» delante daría «Nos dedicamos a el mantenimiento», que no es
  // español: «a el» se contrae en «al». Se quita el artículo y queda «a
  // mantenimiento de edificios», un poco telegráfico pero correcto. «la»,
  // «los» y «las» sí van bien detrás de «a», y se quedan.
  t = t.replace(/^el\s+/i, '');

  t = sinPuntoFinal(t);

  return t.length > 0 ? t : null;
}

/** El primer mensaje tal y como lo recibirá el prospecto. */
export function primerMensaje(p: { prospecto: string; negocio: string; presentacion: string }): string {
  return rellenarPlantilla(PRIMER_CONTACTO_TEXTO, [p.prospecto, p.negocio, p.presentacion]);
}

/**
 * Los dos seguimientos: su texto ({{1}} prospecto, {{2}} cliente) y cuántos
 * días esperan desde el toque ANTERIOR. Viven aquí por la misma razón que el
 * primer mensaje: el consentimiento enseña la secuencia entera, porque lo que
 * el cliente autoriza son los tres mensajes y no solo el primero.
 * prospecting-templates.ts somete estos textos y prospecting-contact.ts
 * espera estos días; ninguno de los dos tiene copia propia.
 *
 * Los textos son los de las plantillas ya sometidas con estos nombres
 * (prospecting_follow_up_1 / _2). Cambiarlos aquí NO cambia lo que se envía
 * —en WhatsApp viaja el cuerpo aprobado— y además dejaría la vista previa
 * mintiendo. Un texto nuevo exige un nombre nuevo, como el primer mensaje.
 */
export const SEGUIMIENTOS = [
  {
    texto:
      'Hola de nuevo, {{1}}. Somos {{2}} — te escribimos hace unos días. Si te interesa hablar, seguimos aquí; si no, no volvemos a escribirte.',
    diasDespues: 3,
  },
  {
    texto:
      'Última vez que te escribimos, {{1}}. Somos {{2}}, seguimos disponibles si en algún momento te interesa. ¡Que vaya bien!',
    diasDespues: 7,
  },
] as const;

/**
 * El nombre con el que el cliente firma los mensajes. `||` y no `??`: un
 * `companyName` guardado vacío ganaría el `??` y el mensaje diría «te
 * escribo de .» — la misma trampa que dejó sin remitente todos los correos
 * de producción (CLAUDE.md, trampa 4). Lo usan el envío y la vista previa,
 * para que las dos digan lo mismo.
 */
export function nombreRemitente(c: { name?: string | null; companyName?: string | null } | null): string {
  return c?.companyName?.trim() || c?.name?.trim() || '';
}
