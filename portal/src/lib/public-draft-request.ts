import 'server-only';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { generateWebDraftCopy } from './web-draft-ai';
import { themeFor } from './web-draft-html';
import { createShareToken } from './prospecting-share';
import { logError } from './observability';

// =============================================================================
// A11, capa 3 — "Ver cómo quedaría mi web" desde kairikos.com.
//
// Un negocio escribe su nombre y su ciudad en la web pública y recibe, en
// segundos, el borrador de su propia página. Es el gancho de captación que
// cierra el círculo: lo mismo que el comercial enseña por teléfono, pero
// pedido por el propio interesado.
//
// Y es también la superficie MÁS peligrosa de todo el producto, por una
// razón simple: cada pulsación gasta dinero nuestro (una generación con
// Sonnet, ~2 céntimos) y no hay nadie identificado al otro lado. Sin frenos,
// un script deja la cuenta de Anthropic seca en una tarde.
//
// Cuatro frenos, en orden de lo que paran:
//
//   1. Tope GLOBAL diario. Es el único que acota el gasto máximo pase lo que
//      pase, y por eso existe aunque los otros tres fallen.
//   2. Tope por IP y día. Para el goteo de un curioso.
//   3. Contacto obligatorio (teléfono o email). No es verificación, es
//      fricción: quien deja un contacto falso se lleva su borrador, pero ya
//      no es gratis del todo para el que automatiza.
//   4. Campo trampa (honeypot). Los bots simples rellenan todo lo que ven;
//      una persona no ve ese campo.
//
// Lo que NO se hace: captcha. Añade un tercero, datos del visitante y
// fricción real en la única pantalla donde la fricción cuesta clientes. Si
// los cuatro frenos no bastasen, ese es el siguiente paso, no el primero.
//
// La IP se guarda HASHEADA con sal: sirve para contar y no para identificar
// a nadie, que es justo lo que hace falta.
// =============================================================================

export const MAX_DRAFTS_PER_DAY_GLOBAL = 50;
export const MAX_DRAFTS_PER_IP_PER_DAY = 3;

export function hashIp(ip: string): string {
  const salt = process.env.PUBLIC_DRAFT_IP_SALT ?? 'kairikos-public-draft';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

export interface PublicDraftInput {
  businessName: string;
  city: string;
  contact: string;
  /** Categoría que elige el visitante de una lista corta; decide plantilla,
   *  paleta y qué servicios propone el modelo. */
  sector: string;
  /** El campo trampa: si viene relleno, es un bot. */
  website?: string;
  ip: string;
}

export type PublicDraftResult =
  | { ok: true; token: string }
  | { ok: false; error: 'rate_limited_global' | 'rate_limited_ip' | 'invalid' | 'unavailable' };

/** Los sectores de la lista pública, con su categoría de Google detrás. La
 *  lista es corta a propósito: cada entrada tiene plantilla y paleta
 *  pensadas, y un desplegable con cien opciones solo sirve para que la
 *  mitad de los borradores salgan genéricos. */
export const PUBLIC_SECTORS: Readonly<Record<string, { label: string; primaryType: string }>> = Object.freeze({
  fontaneria: { label: 'Fontanería', primaryType: 'plumber' },
  electricidad: { label: 'Electricidad', primaryType: 'electrician' },
  reformas: { label: 'Reformas', primaryType: 'general_contractor' },
  cerrajeria: { label: 'Cerrajería', primaryType: 'locksmith' },
  taller: { label: 'Taller mecánico', primaryType: 'car_repair' },
  peluqueria: { label: 'Peluquería o barbería', primaryType: 'hair_salon' },
  estetica: { label: 'Estética', primaryType: 'beauty_salon' },
  clinica: { label: 'Clínica dental', primaryType: 'dentist' },
  fisio: { label: 'Fisioterapia', primaryType: 'physiotherapist' },
  restaurante: { label: 'Restaurante o bar', primaryType: 'restaurant' },
  asesoria: { label: 'Asesoría o despacho', primaryType: 'accounting' },
  otro: { label: 'Otro', primaryType: 'plumber' },
});

function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function createPublicDraft(
  prisma: PrismaClient,
  input: PublicDraftInput,
  now: Date = new Date(),
): Promise<PublicDraftResult> {
  // El campo trampa se mira ANTES que nada: un bot no llega a costarnos ni
  // una consulta de más.
  if (input.website && input.website.trim().length > 0) return { ok: false, error: 'invalid' };
  if (!input.businessName.trim() || !input.city.trim() || !input.contact.trim()) {
    return { ok: false, error: 'invalid' };
  }

  const sector = PUBLIC_SECTORS[input.sector] ?? PUBLIC_SECTORS.otro;
  const since = startOfDay(now);
  const ipHash = hashIp(input.ip);

  const [globalCount, ipCount] = await Promise.all([
    prisma.publicDraftRequest.count({ where: { createdAt: { gte: since } } }),
    prisma.publicDraftRequest.count({ where: { ipHash, createdAt: { gte: since } } }),
  ]);
  if (globalCount >= MAX_DRAFTS_PER_DAY_GLOBAL) return { ok: false, error: 'rate_limited_global' };
  if (ipCount >= MAX_DRAFTS_PER_IP_PER_DAY) return { ok: false, error: 'rate_limited_ip' };

  const generated = await generateWebDraftCopy({
    businessName: input.businessName.trim().slice(0, 200),
    primaryType: sector.primaryType,
    category: sector.label,
    city: input.city.trim().slice(0, 120),
    address: null,
    phone: null,
    rating: null,
    reviewCount: null,
  });

  if ('skipped' in generated) return { ok: false, error: 'unavailable' };
  if (!generated.ok) {
    logError('public_draft.generate_failed', new Error(generated.error), {}, 'warn');
    return { ok: false, error: 'unavailable' };
  }

  const token = createShareToken();
  await prisma.publicDraftRequest.create({
    data: {
      token,
      ipHash,
      businessName: input.businessName.trim().slice(0, 200),
      city: input.city.trim().slice(0, 120),
      contact: input.contact.trim().slice(0, 200),
      sector: input.sector.slice(0, 40),
      themeKey: `${themeFor(sector.primaryType).key}-1`,
      primaryType: sector.primaryType,
      copy: generated.copy as unknown as object,
      model: generated.model,
      createdAt: now,
    },
  });

  return { ok: true, token };
}
