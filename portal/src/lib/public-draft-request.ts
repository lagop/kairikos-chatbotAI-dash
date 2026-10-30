import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateWebDraftCopy } from './web-draft-ai';
import { themeFor } from './web-draft-html';
import { createShareToken } from './prospecting-share';
import { designForDraft } from './web-draft-design';
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
  /** 30/10/2026 — obligatorio: es por donde le llega el borrador. */
  email: string | null;
  /** Opcional: es a quien se llama. Una petición del formulario antiguo
   *  puede traer solo esto (la ruta lo acepta mientras dure el cambio). */
  phone: string | null;
  /** Categoría que elige el visitante de una lista corta; decide plantilla,
   *  paleta y qué servicios propone el modelo. */
  sector: string;
  /** El campo trampa: si viene relleno, es un bot. */
  website?: string;
  /** Marcó la casilla de comunicaciones comerciales (20/10/2026). */
  marketingConsent?: boolean;
  ip: string;
}

export type PublicDraftResult =
  | { ok: true; id: string; token: string }
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

/**
 * Guarda la petición, sin borrador todavía. 30/10/2026: antes se escribía
 * aquí mismo, con el visitante esperando hasta un minuto, y se le enseñaba en
 * segundos. Ahora se le promete en menos de 24 horas (public-draft-delivery.ts):
 * da tiempo a revisarlo, y algo que llega en segundos no parece que valga
 * cientos de euros. La ruta lo genera justo después de contestar
 * (generatePublicDraft) y el barrido reintenta si falla.
 */
export async function createPublicDraft(
  prisma: PrismaClient,
  input: PublicDraftInput,
  now: Date = new Date(),
): Promise<PublicDraftResult> {
  // El campo trampa se mira ANTES que nada: un bot no llega a costarnos ni
  // una consulta de más.
  if (input.website && input.website.trim().length > 0) return { ok: false, error: 'invalid' };
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (!input.businessName.trim() || !input.city.trim() || !(email || phone)) {
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

  const token = createShareToken();
  const row = await prisma.publicDraftRequest.create({
    data: {
      token,
      ipHash,
      businessName: input.businessName.trim().slice(0, 200),
      city: input.city.trim().slice(0, 120),
      // El correo, que es por donde se entrega; sin él (formulario antiguo),
      // el teléfono, como antes.
      contact: (email ?? phone ?? '').slice(0, 200),
      phone: email && phone ? phone.slice(0, 50) : null,
      sector: input.sector.slice(0, 40),
      themeKey: `${themeFor(sector.primaryType).key}-1`,
      primaryType: sector.primaryType,
      marketingConsentAt: input.marketingConsent === true ? now : null,
      createdAt: now,
    },
    select: { id: true },
  });

  return { ok: true, id: row.id, token };
}

/** Los intentos de escribir un borrador antes de dejarlo para el operador.
 *  Cada uno es una llamada al modelo: sin tope, un fallo que se repite
 *  gastaría cada cinco minutos. El barrido además espera una hora más por
 *  cada intento (public-draft-delivery.ts), así que cinco cubren una caída
 *  de varias horas sin salirse del plazo de 24. */
export const MAX_GENERATION_ATTEMPTS = 5;

export type GeneratePublicDraftResult = 'generated' | 'already' | 'gave_up' | 'failed';

/**
 * Escribe el borrador de una petición guardada. Idempotente: si ya tiene
 * borrador no hace nada, y el intento se reserva ANTES de llamar al modelo
 * (dos llamadas a la vez, la de la ruta y la del barrido, no pagan dos).
 * Nunca lanza.
 */
export async function generatePublicDraft(prisma: PrismaClient, id: string): Promise<GeneratePublicDraftResult> {
  try {
    const claimed = await prisma.publicDraftRequest.updateMany({
      where: { id, copy: { equals: Prisma.DbNull }, generationAttempts: { lt: MAX_GENERATION_ATTEMPTS } },
      data: { generationAttempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      const row = await prisma.publicDraftRequest.findUnique({ where: { id }, select: { model: true } });
      return row?.model ? 'already' : 'gave_up';
    }
    const row = await prisma.publicDraftRequest.findUniqueOrThrow({ where: { id } });
    const sector = Object.values(PUBLIC_SECTORS).find((s) => s.primaryType === row.primaryType) ?? PUBLIC_SECTORS.otro;

    const generated = await generateWebDraftCopy({
      businessName: row.businessName,
      primaryType: row.primaryType,
      category: sector.label,
      city: row.city,
      address: null,
      phone: null,
      rating: null,
      reviewCount: null,
    });
    if ('skipped' in generated || !generated.ok) {
      logError('public_draft.generate_failed', new Error('skipped' in generated ? generated.reason : generated.error), { id }, 'warn');
      return 'failed';
    }

    // Webs con IA (27/10/2026): con plantilla aprobada para su sector, diseño
    // de la biblioteca (web-draft-design.ts); si no, null y como siempre.
    const design = await designForDraft(prisma, {
      copy: generated.copy,
      themeKey: row.themeKey,
      businessName: row.businessName,
      primaryType: row.primaryType,
      city: row.city,
    });
    await prisma.publicDraftRequest.update({
      where: { id },
      data: {
        copy: generated.copy as unknown as Prisma.InputJsonValue,
        model: generated.model,
        ...(design ? { content: design.content as unknown as Prisma.InputJsonValue, templateId: design.templateId } : {}),
      },
    });
    return 'generated';
  } catch (err) {
    logError('public_draft.generate_failed', err, { id }, 'warn');
    return 'failed';
  }
}
