import 'server-only';

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { suggestProspectingTargets } from '@/lib/prospecting-brief-ai';
import { esProvinciaConocida } from '@/lib/prospeccion-zona';
import { logError } from '@/lib/observability';

// =============================================================================
// «¿Qué vendes?» — el gancho público de /prospeccion/.
//
// El visitante describe lo que vende con sus palabras y le proponemos a qué
// TIPOS DE NEGOCIO vendérselo. Es la Fase A del producto —la que convierte
// «hago reformas» en «administradores de fincas», que es justo lo que un
// cliente no sabe pensar solo— enseñada antes de pedir nada.
//
// Sustituye a la foto de zona, que el 28/09/2026 resultó estar mirando con
// nuestras gafas: contaba negocios «sin web» del rubro del visitante, que es
// el criterio con el que KAIRIKOS encuentra clientes para sus webs, no el del
// cliente de Prospección. A un fontanero le enseñaba cuántos fontaneros no
// tienen web: sus competidores, vistos como los vería una agencia. La foto de
// zona se mudó a /web/, donde esa misma pregunta sí es la del visitante.
//
// LOS FRENOS, y por qué son éstos:
//
// Es la cuarta superficie pública, y se parece al borrador de web y no a las
// otras dos: CUESTA DINERO por pulsación (una llamada de IA) y la entrada es
// TEXTO LIBRE. La foto de zona se acotaba sola con dos listas cerradas; aquí
// no hay lista posible de «lo que alguien vende». La caché evita pagar dos
// veces el mismo texto, pero no acota nada. Los topes son el freno de verdad.
//
//   1. Tope global diario de consultas NUEVAS: el único que acota el gasto
//      máximo pase lo que pase.
//   2. Tope por IP: para el goteo de un curioso.
//   3. Campo trampa.
//   4. Sin web: el lib de sugerencias sabe leer la web del negocio, y aquí
//      NO se le pasa nunca. Una URL escrita por un anónimo es la puerta de la
//      auditoría pública, con sus propios frenos; esto no la abre.
//
// Lo que se guarda son LOS TIPOS DE NEGOCIO PROPUESTOS y un hash de la entrada.
// Ni el texto que escribió el visitante ni nada que lo parafrasee.
//
// Eso último no estaba así en la primera versión: se guardaba también el
// «resumen», la frase con la que el modelo dice cómo ha entendido el negocio.
// El test que comprueba que no se guarda el texto lo cazó: el resumen de
// «Hago reformas de baños y cocinas» es «Empresa de reformas de baños y
// cocinas». Una paráfrasis de lo que escribió alguien sigue siendo lo que
// escribió. El resumen se devuelve en la respuesta y se tira; una consulta
// repetida —rara, con texto libre— sale sin él.
// =============================================================================

/** Consultas nuevas al día, en todo el sitio. Una llamada de modelo barato
 *  cada una: el tope está para el día que alguien lo automatice. */
export const MAX_CONSULTAS_NUEVAS_POR_DIA = 100;

/** Consultas nuevas por IP y día. Las servidas de caché no cuentan. */
export const MAX_CONSULTAS_NUEVAS_POR_IP = 5;

/** Menos que esto no dice qué vende nadie; más es pegar un folleto. */
export const LARGO_MINIMO = 8;
export const LARGO_MAXIMO = 400;

export interface Propuesta {
  /** Tipos de negocio a los que venderle, como se buscarían en Google Maps. */
  aQuien: string[];
  /** Cómo hemos entendido su negocio, para que vea si acertamos. */
  resumen: string | null;
}

export type ResultadoQueVendes =
  | { ok: true; propuesta: Propuesta }
  | { ok: false; error: 'demasiado_corto' | 'demasiado_largo' | 'tope_global' | 'tope_ip' | 'no_disponible' | 'sin_propuesta' };

type PrismaQueVendes = Pick<PrismaClient, 'queVendesCache'>;

/**
 * La clave de la caché: el texto normalizado, más la provincia.
 *
 * Normalizar importa aunque no acote nada: «Hago reformas.» y «hago reformas»
 * son la misma pregunta, y pagarla dos veces es tirar el dinero de la forma más
 * tonta.
 */
export function claveDe(texto: string, provincia: string | null): string {
  const normal = texto
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return createHash('sha256').update(`${normal}|${provincia ?? ''}`).digest('hex');
}

function haceUnDia(ahora: Date): Date {
  return new Date(ahora.getTime() - 24 * 60 * 60 * 1000);
}

export async function queVendes(
  prisma: PrismaQueVendes,
  entrada: { texto: string; provincia?: string | null; ipHash: string },
  ahora: Date = new Date(),
): Promise<ResultadoQueVendes> {
  const texto = entrada.texto.trim();
  if (texto.length < LARGO_MINIMO) return { ok: false, error: 'demasiado_corto' };
  if (texto.length > LARGO_MAXIMO) return { ok: false, error: 'demasiado_largo' };

  // La provincia solo se acepta si es de la lista cerrada. Una escrita a mano
  // viajaría al prompt, y el prompt no es sitio para texto que nadie controla.
  const provincia = entrada.provincia && esProvinciaConocida(entrada.provincia) ? entrada.provincia : null;

  const clave = claveDe(texto, provincia);
  const guardada = await prisma.queVendesCache.findUnique({ where: { clave } });
  if (guardada) {
    // Sin resumen: no se guarda, ver la cabecera.
    return { ok: true, propuesta: { aQuien: guardada.aQuien, resumen: null } };
  }

  // A partir de aquí se paga. Los topes miran solo las consultas NUEVAS: negar
  // una que sale de caché no ahorra nada y solo empeora la página.
  const desde = haceUnDia(ahora);
  const [nuevasHoy, nuevasDeEstaIp] = await Promise.all([
    prisma.queVendesCache.count({ where: { creadoEl: { gte: desde } } }),
    prisma.queVendesCache.count({ where: { creadoEl: { gte: desde }, ipHash: entrada.ipHash } }),
  ]);
  if (nuevasHoy >= MAX_CONSULTAS_NUEVAS_POR_DIA) return { ok: false, error: 'tope_global' };
  if (nuevasDeEstaIp >= MAX_CONSULTAS_NUEVAS_POR_IP) return { ok: false, error: 'tope_ip' };

  const r = await suggestProspectingTargets({
    // Un visitante anónimo no tiene nombre de negocio, y el prompt lo pide.
    // Se le dice al modelo la verdad en vez de inventarle uno.
    businessName: '(no lo ha dicho: escribe desde la web pública)',
    businessDescription: texto,
    knownLocation: provincia,
    // websiteText NUNCA: ver el freno 4 de la cabecera.
  });

  if (!r.ok) {
    logError('que_vendes_publico', new Error(r.error), { provincia }, 'warn');
    return { ok: false, error: 'no_disponible' };
  }
  if ('skipped' in r) {
    // Sin clave de Anthropic, o sin contexto. Lo segundo no debería pasar con
    // el mínimo de caracteres de arriba; lo primero es un fallo de
    // configuración, y se dice como tal en vez de como «no hay propuesta».
    return { ok: false, error: r.reason === 'no_api_key' ? 'no_disponible' : 'sin_propuesta' };
  }

  const aQuien = r.suggestion.categories;
  if (aQuien.length === 0) {
    // No se guarda: una respuesta vacía no es una propuesta, y guardarla haría
    // que el siguiente con el mismo texto recibiera el vacío gratis y para
    // siempre.
    return { ok: false, error: 'sin_propuesta' };
  }

  const resumen = r.suggestion.businessSummary;
  // upsert y no create: dos pulsaciones con el mismo texto a la vez fallan las
  // dos la caché, pagan las dos, y la segunda chocaría con la clave única. El
  // gasto doble ya está hecho; lo que no puede pasar es que encima una de las
  // dos devuelva un error.
  await prisma.queVendesCache.upsert({
    where: { clave },
    create: { clave, aQuien, ipHash: entrada.ipHash, creadoEl: ahora },
    update: {},
  });

  return { ok: true, propuesta: { aQuien, resumen } };
}
