import 'server-only';

import type { PrismaClient } from '@prisma/client';
import { searchPlaces } from '@/lib/google-places';
import { PUBLIC_SECTORS } from '@/lib/public-draft-request';
import { logError } from '@/lib/observability';

// =============================================================================
// «¿Cuántos negocios de tu rubro hay en tu provincia sin web?»
//
// El gancho de la página de prospección, equivalente a lo que la calculadora
// de llamadas perdidas es para recall: una cifra sobre SU zona, sin registro
// y sin hablar con nadie.
//
// Es la segunda superficie pública que gasta dinero nuestro por pulsación —la
// otra es el borrador de web— y el problema es el mismo: no hay nadie
// identificado al otro lado. Pero aquí hay un freno que allí no cabe, y es el
// que de verdad acota el gasto:
//
//   LAS DOS LISTAS SON CERRADAS.
//
// El visitante elige rubro de una lista de once y provincia de una de
// cincuenta y dos. Eso son 572 combinaciones posibles, ni una más, y cada una
// se guarda 30 días. El gasto máximo no depende de cuánta gente entre: son 572
// búsquedas al mes aunque alguien las pida todas en bucle, y en la práctica
// muchas menos. Un campo de texto libre habría hecho el espacio infinito y la
// caché inútil.
//
// Los otros dos frenos existen para el rato en que la caché aún está fría:
// tope global diario de búsquedas NUEVAS, y tope por IP. Un tope sobre
// peticiones no serviría — las que salen de caché no cuestan nada y no hay
// motivo para negarlas.
//
// Lo que sale de aquí son PROPORCIONES, nunca la lista de negocios. Esa lista
// con nombre, teléfono y correo es literalmente el producto: enseñarla gratis
// sería regalar lo que se vende.
// =============================================================================

/** Búsquedas nuevas (fallos de caché) al día, en todo el sitio. */
export const MAX_BUSQUEDAS_NUEVAS_POR_DIA = 60;

/** Búsquedas nuevas por IP y día. Las servidas de caché no cuentan. */
export const MAX_BUSQUEDAS_NUEVAS_POR_IP = 6;

/** Cuánto vale una foto de zona antes de repetirla. Un negocio no monta su
 *  web en una semana; treinta días es de sobra y multiplica por treinta lo
 *  que rinde cada llamada. */
export const DIAS_DE_VIGENCIA = 30;

/** Los resultados de UNA página de Text Search. No se pagina a propósito:
 *  veinte negocios bastan para una proporción, y así cada fallo de caché
 *  cuesta exactamente una llamada y no un número que dependa de la zona. */
const TAMANO_DE_MUESTRA = 20;

/**
 * Por debajo de esto no se enseña proporción: se dice que la zona da poco.
 *
 * El 27/09/2026, el día que se publicó /prospeccion/, cerrajería en Sevilla
 * devolvió SIETE resultados. La página dijo «0 de 7» —y antes de eso prometía
 * en su subtítulo que miraba veinte—. Las dos cosas eran ciertas por separado
 * y juntas quedaban mal: una proporción sobre siete no es una proporción, es
 * una anécdota, y presentarla con la misma tipografía de doce centímetros que
 * «8 de 20» le da un peso que no tiene.
 *
 * Diez es la mitad de la muestra que se pide. Es el denominador más pequeño
 * con el que «N de 10» todavía se lee como una parte de un todo. No hay nada
 * estadístico en el número: hay que elegir uno, y por debajo de éste preferimos
 * no decir nada a decir algo que suene más firme de lo que es.
 */
export const MUESTRA_MINIMA = 10;

export const PROVINCIAS: readonly string[] = Object.freeze([
  'A Coruña', 'Álava', 'Albacete', 'Alicante', 'Almería', 'Asturias', 'Ávila',
  'Badajoz', 'Baleares', 'Barcelona', 'Burgos', 'Cáceres', 'Cádiz', 'Cantabria',
  'Castellón', 'Ceuta', 'Ciudad Real', 'Córdoba', 'Cuenca', 'Girona', 'Granada',
  'Guadalajara', 'Guipúzcoa', 'Huelva', 'Huesca', 'Jaén', 'La Rioja', 'Las Palmas',
  'León', 'Lleida', 'Lugo', 'Madrid', 'Málaga', 'Melilla', 'Murcia', 'Navarra',
  'Ourense', 'Palencia', 'Pontevedra', 'Salamanca', 'Santa Cruz de Tenerife',
  'Segovia', 'Sevilla', 'Soria', 'Tarragona', 'Teruel', 'Toledo', 'Valencia',
  'Valladolid', 'Vizcaya', 'Zamora', 'Zaragoza',
]);

export interface FotoDeZona {
  /** Cuántos de la muestra no tienen web. Es la cifra que se enseña. */
  sinWeb: number;
  /** El tamaño de la muestra. Siempre se enseña al lado: «7 de 20» dice la
   *  verdad; «el 35 %» invita a multiplicarlo por el censo de la provincia. */
  total: number;
  /** ISO. Para poder decir «mirado el …» y no aparentar tiempo real. */
  miradoEl: string;
  /** true cuando salió de la caché. Solo para las métricas, no se publica. */
  deCache: boolean;
}

export type ResultadoDeZona =
  | { ok: true; foto: FotoDeZona }
  | { ok: false; error: 'rubro_desconocido' | 'provincia_desconocida' | 'sin_configurar' | 'tope_global' | 'tope_ip' | 'sin_resultados' | 'muestra_insuficiente' | 'error_externo' };

export function esRubroConocido(valor: string): boolean {
  return Object.prototype.hasOwnProperty.call(PUBLIC_SECTORS, valor);
}

export function esProvinciaConocida(valor: string): boolean {
  return PROVINCIAS.includes(valor);
}

/**
 * La consulta que se le manda a Google.
 *
 * Se construye aquí y no en la ruta para que el texto que viaja a Places sea
 * SIEMPRE una combinación de las dos listas cerradas. Aunque alguien colara
 * otra cosa en el cuerpo de la petición, no llegaría a la llamada de pago.
 */
export function consultaPara(rubro: string, provincia: string): string {
  const etiqueta = PUBLIC_SECTORS[rubro as keyof typeof PUBLIC_SECTORS].label;
  return `${etiqueta} en ${provincia}`;
}

type PrismaZona = Pick<PrismaClient, 'prospeccionZonaCache'>;

type FilaGuardada = { sinWeb: number; total: number; miradoEl: Date };

/**
 * Lo que se devuelve a partir de una fila ya guardada.
 *
 * Existe como función porque hay CUATRO caminos que sirven una fila guardada
 * —la fresca, y las tres degradaciones: tope global, tope por IP y Google
 * caído— y el mínimo de muestra tiene que valer en los cuatro. Repetirlo
 * cuatro veces es garantizar que dentro de un mes valga en tres.
 */
function desdeLaCache(fila: FilaGuardada): ResultadoDeZona {
  if (fila.total < MUESTRA_MINIMA) {
    return { ok: false, error: 'muestra_insuficiente' };
  }
  return {
    ok: true,
    foto: { sinWeb: fila.sinWeb, total: fila.total, miradoEl: fila.miradoEl.toISOString(), deCache: true },
  };
}

function haceDias(dias: number): Date {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

/**
 * La foto de una zona: de la caché si la hay fresca, de Google si no.
 *
 * `ahora` se inyecta para poder testear la caducidad sin tocar el reloj.
 */
export async function fotoDeZona(
  prisma: PrismaZona,
  entrada: { rubro: string; provincia: string; ipHash: string },
  ahora: Date = new Date(),
): Promise<ResultadoDeZona> {
  const { rubro, provincia, ipHash } = entrada;

  if (!esRubroConocido(rubro)) return { ok: false, error: 'rubro_desconocido' };
  if (!esProvinciaConocida(provincia)) return { ok: false, error: 'provincia_desconocida' };

  const vigenteDesde = new Date(ahora.getTime() - DIAS_DE_VIGENCIA * 24 * 60 * 60 * 1000);

  const guardada = await prisma.prospeccionZonaCache.findUnique({
    where: { rubro_provincia: { rubro, provincia } },
  });

  if (guardada && guardada.miradoEl >= vigenteDesde) {
    return desdeLaCache(guardada);
  }

  // A partir de aquí se gasta dinero. Los topes solo miran las búsquedas
  // NUEVAS: negar una que sale de caché no ahorra nada y solo empeora la
  // página para quien llega el segundo.
  const desdeAyer = haceDias(1);

  const [nuevasHoy, nuevasDeEstaIp] = await Promise.all([
    prisma.prospeccionZonaCache.count({ where: { miradoEl: { gte: desdeAyer } } }),
    prisma.prospeccionZonaCache.count({ where: { miradoEl: { gte: desdeAyer }, ipHash } }),
  ]);

  if (nuevasHoy >= MAX_BUSQUEDAS_NUEVAS_POR_DIA) {
    // Si hay una foto caducada, vale más que un error: una cifra de hace
    // cinco semanas sigue siendo verdad aproximada, y el visitante no se va.
    if (guardada) {
      return desdeLaCache(guardada);
    }
    return { ok: false, error: 'tope_global' };
  }

  if (nuevasDeEstaIp >= MAX_BUSQUEDAS_NUEVAS_POR_IP) {
    if (guardada) {
      return desdeLaCache(guardada);
    }
    return { ok: false, error: 'tope_ip' };
  }

  const busqueda = await searchPlaces({ textQuery: consultaPara(rubro, provincia) });
  if (!busqueda.ok) {
    logError('prospeccion_zona_places', new Error(busqueda.error), { rubro, provincia });
    // Con una foto vieja se sirve igual: el visitante no tiene por qué pagar
    // que Google esté caído.
    if (guardada) {
      return desdeLaCache(guardada);
    }
    return { ok: false, error: 'error_externo' };
  }

  const muestra = busqueda.data.results.slice(0, TAMANO_DE_MUESTRA);
  if (muestra.length === 0) return { ok: false, error: 'sin_resultados' };

  // «Sin web» es literalmente no tener websiteUri en su ficha de Google. No
  // se comprueba si la web responde ni si está abandonada: eso es trabajo del
  // producto de verdad, cuesta una petición por negocio, y aquí se trata de
  // dar una cifra honesta, no la buena.
  const sinWeb = muestra.filter((p) => !p.websiteUri).length;

  // Se guarda SIEMPRE, también cuando la muestra se queda corta. Es lo que
  // mantiene en pie el tope de coste: si una zona pobre no se guardara, cada
  // visitante que la eligiera volvería a pagar una llamada a Google para
  // enterarse otra vez de que da poco. Lo que se decide abajo es qué se
  // enseña, no si se ha mirado.
  const fila = await prisma.prospeccionZonaCache.upsert({
    where: { rubro_provincia: { rubro, provincia } },
    create: { rubro, provincia, sinWeb, total: muestra.length, ipHash, miradoEl: ahora },
    update: { sinWeb, total: muestra.length, ipHash, miradoEl: ahora },
  });

  if (fila.total < MUESTRA_MINIMA) {
    return { ok: false, error: 'muestra_insuficiente' };
  }

  return {
    ok: true,
    foto: { sinWeb: fila.sinWeb, total: fila.total, miradoEl: fila.miradoEl.toISOString(), deCache: false },
  };
}
