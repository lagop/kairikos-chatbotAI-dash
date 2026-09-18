// =============================================================================
// Los dos enlaces con los que el cliente contacta A MANO a un prospecto.
//
// Prospección encuentra negocios y saca su teléfono y su correo de su propia
// web, pero el envío automático por WhatsApp está parado (la app aún no es
// Tech Provider) y por correo no existe. Hasta entonces, el dato que ya
// tenemos no servía de nada: estaba escrito en la ficha y el cliente tenía
// que copiarlo a mano.
//
// Esto NO envía nada: son enlaces que abren WhatsApp o el gestor de correo
// del cliente con el texto ya escrito, que él revisa y manda. Quien comunica
// es el cliente, con sus medios — que es justo lo que mantiene el producto
// fuera del riesgo de las comunicaciones comerciales automatizadas.
//
// Puro y sin 'server-only': lo usa la página de leads y sus tests.
// =============================================================================

/** El texto sugerido. Se identifica desde la primera línea: un mensaje en
 *  frío sin decir quién escribe es lo que hace que lo reporten. */
export function suggestedOutreachMessage(input: { businessName: string; prospectName?: string | null }): string {
  const saludo = input.prospectName?.trim() ? `Hola, ${input.prospectName.trim()}` : 'Hola';
  return `${saludo}. Te escribo de ${input.businessName}. Trabajamos cerca y creo que podríamos echarte una mano. ¿Te viene bien que te cuente sin compromiso?`;
}

/** Solo dígitos, con el prefijo por delante: wa.me lo exige así, sin '+'. */
export function whatsappLink(phone: string | null | undefined, message: string): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  // Menos de nueve dígitos no es un número al que se pueda escribir; más de
  // quince no existe en E.164.
  if (digits.length < 9 || digits.length > 15) return null;
  // Un número nacional español (9 dígitos) necesita el 34 que Places omite.
  const international = digits.length === 9 ? `34${digits}` : digits;
  return `https://wa.me/${international}?text=${encodeURIComponent(message)}`;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function mailtoLink(
  email: string | null | undefined,
  input: { subject: string; body: string },
): string | null {
  const clean = (email ?? '').trim();
  if (!EMAIL_RE.test(clean)) return null;
  const params = new URLSearchParams({ subject: input.subject, body: input.body });
  // URLSearchParams codifica el espacio como '+', que en el cuerpo de un
  // mailto se ve literalmente como '+'. %20 es lo que entienden todos los
  // gestores de correo.
  return `mailto:${clean}?${params.toString().replace(/\+/g, '%20')}`;
}
