import 'server-only';

import type { PrismaClient } from '@prisma/client';
import { auditWebsite } from '@/lib/seo-audit';
import { logError } from '@/lib/observability';

// =============================================================================
// «Dinos tu web y te decimos qué le falta»: el gancho público de /seo/.
//
// Es la tercera superficie pública que trabaja para quien no está
// identificado. Las otras dos —el borrador de web y la foto de zona— gastan
// DINERO por pulsación, y el diseño de las dos gira alrededor de eso. Ésta no
// gasta un céntimo: no llama a ninguna API de pago y no usa IA. Sería fácil
// concluir que no hace falta frenarla.
//
// Es al revés, y por un motivo que el dinero tapaba:
//
//   AQUÍ LA URL LA ESCRIBE CUALQUIERA, SOBRE CUALQUIER SITIO.
//
// La foto de zona se acota sola porque las dos listas son cerradas: 572
// combinaciones y la caché las cubre todas. Un campo de texto no tiene
// combinaciones; tiene internet entero. La caché sigue sirviendo para que
// recargar no repita trabajo, pero YA NO ACOTA NADA. Los topes dejan de ser el
// segundo freno y pasan a ser el único.
//
// Y lo que hay que acotar tampoco es nuestro gasto: es lo que esto le hace a
// un tercero. Cada pulsación descarga la web de alguien desde nuestra IP. Por
// eso la auditoría pública va con `checkLinks: false` —una petición en vez de
// once, ver el porqué en seo-audit.ts— y por eso los topes son más estrechos
// de lo que el coste propio justificaría.
//
// Lo que se guarda son SEIS NÚMEROS, nunca el texto de la página ajena: no
// hace falta para decir «tu título son 78 caracteres», y guardar el contenido
// de webs de terceros es una responsabilidad que no queremos a cambio de nada.
// =============================================================================

/** Auditorías nuevas al día, en todo el sitio. */
export const MAX_AUDITORIAS_NUEVAS_POR_DIA = 300;

/** Auditorías nuevas por IP y día. Las servidas de caché no cuentan. */
export const MAX_AUDITORIAS_NUEVAS_POR_IP = 5;

/**
 * Cuánto vale una auditoría antes de repetirla.
 *
 * Corta a propósito, y por lo contrario de lo habitual. En la foto de zona son
 * treinta días porque un negocio no monta su web en una semana. Aquí el
 * visitante típico mira su web, arregla el título y vuelve a mirar el mismo
 * día: servirle una foto de hace horas le diría que su arreglo no funcionó.
 * Una hora absorbe la recarga y el enlace compartido, que es para lo que sirve
 * la caché cuando no es ella la que acota el gasto.
 */
export const MINUTOS_DE_VIGENCIA = 60;

/** Lo que se enseña. Seis números, ni una palabra de la web ajena. */
export interface FotoDeWeb {
  tieneTitulo: boolean;
  /** Caracteres. 0 cuando no hay título. Google corta alrededor de 60. */
  largoTitulo: number;
  tieneDescripcion: boolean;
  largoDescripcion: number;
  h1: number;
  imagenes: number;
  imagenesSinAlt: number;
  /** ISO, para poder decir «mirado el …» y no aparentar tiempo real. */
  miradoEl: string;
}

export type ResultadoDeAuditoria =
  | { ok: true; foto: FotoDeWeb }
  | { ok: false; error: 'url_invalida' | 'tope_global' | 'tope_ip' | 'no_alcanzable' };

type PrismaAuditoria = Pick<PrismaClient, 'auditoriaPublicaCache'>;

/**
 * Normaliza la URL que escribe el visitante, y rechaza lo que no es una web.
 *
 * Normalizar no es cosmética: sin esto, `ejemplo.com`, `https://ejemplo.com`,
 * `https://ejemplo.com/` y `https://EJEMPLO.com/?utm_source=x` son cuatro
 * entradas distintas de la caché y cuatro descargas de la misma página. Con un
 * campo de texto, ésa es la diferencia entre una caché que sirve y una que no.
 *
 * Se completa el esquema a https SOLO cuando no hay ninguno. Anteponerlo a
 * `ftp://archivos.example` daría una URL válida cuyo host es `ftp` — el mismo
 * fallo que ya está documentado en la ruta de sugerencias de Prospección.
 */
export function normalizarUrl(bruta: string): string | null {
  const texto = bruta.trim();
  if (texto.length === 0 || texto.length > 300) return null;

  // Un esquema es «letra seguida de letras, dígitos, +, -, . y dos puntos».
  const tieneEsquema = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(texto);
  const candidata = tieneEsquema ? texto : `https://${texto}`;

  let url: URL;
  try {
    url = new URL(candidata);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Un host sin punto no es un dominio de internet: es `localhost`, el nombre
  // de un contenedor, o una errata. safeFetch lo rechazaría igual al conectar,
  // pero rechazarlo aquí ahorra la petición y da un mensaje que se entiende.
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.')) return null;

  // Se queda la ruta y se va TODO lo demás: query, fragmento y credenciales.
  // Los `utm_*` de una campaña no cambian el título de la página y
  // multiplicarían las entradas de caché por cada anuncio.
  //
  // Se compone a mano en vez de con toString(): poner pathname a '' no quita
  // la barra final —URL la repone para http(s)— así que «ejemplo.com» salía
  // como «https://ejemplo.com/» y no casaba con lo que se guardaba. Quitar la
  // barra SIEMPRE, además, junta «/servicios» y «/servicios/», que son la misma
  // página en cualquier sitio donde valga la pena mirar esto.
  const ruta = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${host}${url.port ? ':' + url.port : ''}${ruta}`;
}

function haceDias(dias: number): Date {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

type FilaGuardada = {
  tieneTitulo: boolean;
  largoTitulo: number;
  tieneDescripcion: boolean;
  largoDescripcion: number;
  h1: number;
  imagenes: number;
  imagenesSinAlt: number;
  miradoEl: Date;
};

function desdeLaCache(fila: FilaGuardada): ResultadoDeAuditoria {
  return {
    ok: true,
    foto: {
      tieneTitulo: fila.tieneTitulo,
      largoTitulo: fila.largoTitulo,
      tieneDescripcion: fila.tieneDescripcion,
      largoDescripcion: fila.largoDescripcion,
      h1: fila.h1,
      imagenes: fila.imagenes,
      imagenesSinAlt: fila.imagenesSinAlt,
      miradoEl: fila.miradoEl.toISOString(),
    },
  };
}

/**
 * La foto de una web: de la caché si la hay fresca, descargándola si no.
 *
 * `ahora` se inyecta para poder testear la caducidad sin tocar el reloj.
 */
export async function fotoDeWeb(
  prisma: PrismaAuditoria,
  entrada: { url: string; ipHash: string },
  ahora: Date = new Date(),
): Promise<ResultadoDeAuditoria> {
  const url = normalizarUrl(entrada.url);
  if (!url) return { ok: false, error: 'url_invalida' };

  const vigenteDesde = new Date(ahora.getTime() - MINUTOS_DE_VIGENCIA * 60 * 1000);

  const guardada = await prisma.auditoriaPublicaCache.findUnique({ where: { url } });
  if (guardada && guardada.miradoEl >= vigenteDesde) {
    return desdeLaCache(guardada);
  }

  // A partir de aquí se descarga la web de alguien. Los topes solo miran las
  // auditorías NUEVAS: negar una que sale de caché no le ahorra una petición a
  // nadie y solo empeora la página.
  const desdeAyer = haceDias(1);

  const [nuevasHoy, nuevasDeEstaIp] = await Promise.all([
    prisma.auditoriaPublicaCache.count({ where: { miradoEl: { gte: desdeAyer } } }),
    prisma.auditoriaPublicaCache.count({ where: { miradoEl: { gte: desdeAyer }, ipHash: entrada.ipHash } }),
  ]);

  // Con el tope alcanzado y una foto caducada, se sirve la vieja: el visitante
  // no tiene por qué pagar un tope que no es suyo, y servirla no descarga nada.
  if (nuevasHoy >= MAX_AUDITORIAS_NUEVAS_POR_DIA) {
    return guardada ? desdeLaCache(guardada) : { ok: false, error: 'tope_global' };
  }
  if (nuevasDeEstaIp >= MAX_AUDITORIAS_NUEVAS_POR_IP) {
    return guardada ? desdeLaCache(guardada) : { ok: false, error: 'tope_ip' };
  }

  // checkLinks: false — una petición y no once. El porqué, en seo-audit.ts.
  const auditoria = await auditWebsite(url, { checkLinks: false });
  if (!auditoria.ok) {
    logError('auditoria_publica_fetch', new Error(auditoria.error), { url }, 'warn');
    return guardada ? desdeLaCache(guardada) : { ok: false, error: 'no_alcanzable' };
  }

  const d = auditoria.data;
  const fila = await prisma.auditoriaPublicaCache.upsert({
    where: { url },
    create: {
      url,
      tieneTitulo: d.title !== null,
      largoTitulo: d.title?.length ?? 0,
      tieneDescripcion: d.metaDescription !== null,
      largoDescripcion: d.metaDescription?.length ?? 0,
      h1: d.h1Count,
      imagenes: d.imagesTotal,
      imagenesSinAlt: d.imagesMissingAlt,
      ipHash: entrada.ipHash,
      miradoEl: ahora,
    },
    update: {
      tieneTitulo: d.title !== null,
      largoTitulo: d.title?.length ?? 0,
      tieneDescripcion: d.metaDescription !== null,
      largoDescripcion: d.metaDescription?.length ?? 0,
      h1: d.h1Count,
      imagenes: d.imagesTotal,
      imagenesSinAlt: d.imagesMissingAlt,
      ipHash: entrada.ipHash,
      miradoEl: ahora,
    },
  });

  return desdeLaCache(fila);
}
