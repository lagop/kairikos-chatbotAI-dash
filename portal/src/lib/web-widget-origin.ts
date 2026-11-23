import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Widget web — dominios permitidos (16/11/2026).
//
// El `publicToken` del widget (wgt_…) es público a propósito: va pegado en el
// HTML de la web del cliente. Hasta hoy eso significaba que cualquiera podía
// copiarlo a otra web y el portal le contestaba igual (CORS `*`), gastando el
// tope mensual de mensajes del cliente (chatbot-usage.ts). Se vio al montar la
// demo de Alisio Dental Studio, que pedía limitarlo a su dominio.
//
// Ahora cada widget puede tener una lista de orígenes (`allowedOrigins`):
//
//   - vacía → sin restricción. Es lo que tenían todos los widgets antes de
//     existir la columna, y lo que siguen teniendo mientras nadie la rellene;
//   - con algo → las rutas públicas del widget (config, message, contact)
//     solo contestan si el origen de la petición está en la lista. Si no, la
//     misma respuesta que un widget apagado: quien prueba desde otra web no
//     tiene por qué saber que el widget existe.
//
// LIMITACIÓN CONOCIDA Y ACEPTADA: la cabecera `Origin` la pone el navegador,
// pero cualquiera la falsea desde curl. Esto impide usar el widget desde otra
// web en un navegador, que es el abuso fácil; no impide un script. Contra un
// script siguen estando los frenos por minuto de cada ruta y el tope mensual.
// =============================================================================

export const MAX_ALLOWED_ORIGINS = 10;

/**
 * Lo que escribe una persona («www.ejemplo.com», «https://ejemplo.com/contacto»)
 * convertido en un origen («https://www.ejemplo.com»), o null si no vale.
 *
 * Solo http(s). Sin esquema se supone https. Con otro esquema se rechaza en
 * vez de anteponer https: «ftp://archivos.example» con el prefijo daría una
 * URL válida cuyo host es «ftp» (la misma trampa que safePublicUrl). La ruta
 * se descarta: el navegador manda el origen, nunca la página. Un host sin
 * punto solo vale si es localhost, para probar en local.
 */
export function normalizeOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 300) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  return url.origin;
}

export type ParseAllowedOriginsResult =
  | { ok: true; origins: string[] }
  | { ok: false; error: 'too_many_origins' | 'invalid_origin'; value?: string };

/** La lista que guarda el cliente: normalizada, sin repetidos y con tope.
 *  Una entrada que no vale rechaza la lista entera (y dice cuál): guardar
 *  solo las buenas dejaría fuera, sin avisar, una web que el cliente quería. */
export function parseAllowedOrigins(input: string[]): ParseAllowedOriginsResult {
  const out: string[] = [];
  for (const raw of input) {
    if (!raw.trim()) continue;
    const origin = normalizeOrigin(raw);
    if (!origin) return { ok: false, error: 'invalid_origin', value: raw.trim().slice(0, 300) };
    if (!out.includes(origin)) out.push(origin);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) return { ok: false, error: 'too_many_origins' };
  return { ok: true, origins: out };
}

/** El origen de la petición: la cabecera `Origin` (la que manda el navegador
 *  en toda petición de otro origen) o, si falta, el de `Referer` (una
 *  petición GET del mismo origen no siempre lleva `Origin`). `Origin: null`
 *  —iframes con sandbox, file://— no cuenta como origen. */
export function requestOrigin(headers: Headers): string | null {
  const origin = headers.get('origin');
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }
  const referer = headers.get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** ¿Puede usarse el widget desde esta petición? Lista vacía, siempre. Con
 *  lista, solo si el origen está en ella; sin origen que leer, no. */
export function isWidgetOriginAllowed(allowedOrigins: readonly string[] | null | undefined, headers: Headers): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  const origin = requestOrigin(headers);
  return origin !== null && allowedOrigins.includes(origin);
}

// -----------------------------------------------------------------------------
// Guardar la lista, con su auditoría en la misma transacción: quién decide
// desde qué webs funciona el chat de un negocio tiene que quedar escrito.
// -----------------------------------------------------------------------------

export interface WidgetOriginsActor {
  type: 'client' | 'operator';
  /** Para un cliente, `client:<clientId>`; para un operador, su email. */
  email: string;
  operatorId?: string | null;
}

export async function updateWidgetAllowedOrigins(
  prisma: PrismaClient,
  embed: { id: string; clientId: string; tenantId: string | null; allowedOrigins: string[] },
  origins: string[],
  actor: WidgetOriginsActor,
): Promise<{ changed: boolean; allowedOrigins: string[] }> {
  const before = embed.allowedOrigins ?? [];
  const same = before.length === origins.length && before.every((o, i) => o === origins[i]);
  if (same) return { changed: false, allowedOrigins: before };

  await prisma.$transaction([
    prisma.chatWebEmbed.update({ where: { id: embed.id }, data: { allowedOrigins: origins } }),
    prisma.chatWebEmbedAudit.create({
      data: {
        embedId: embed.id,
        clientId: embed.clientId,
        tenantId: embed.tenantId,
        action: 'allowed_origins_updated',
        before: { allowedOrigins: before },
        after: { allowedOrigins: origins },
        actorType: actor.type,
        actorOperatorId: actor.operatorId ?? null,
        actorEmail: actor.email,
      },
    }),
  ]);
  return { changed: true, allowedOrigins: origins };
}

// -----------------------------------------------------------------------------
// Aviso de la portada del portal (21/11/2026). La lista existe desde #408, pero
// un cliente que no entra en Canales no sabe que puede limitar su chat. Se le
// avisa solo si le sirve: con el widget web activo y la lista vacía. En cuanto
// guarda alguna web, el aviso deja de salir solo.
// -----------------------------------------------------------------------------

/** El primer widget activo sin lista del cliente, o null si no hay ninguno.
 *  `clientProductId` es el chatbot al que lleva el enlace del aviso (con
 *  varios, Canales necesita saber cuál). */
export async function findWidgetWithoutAllowedOrigins(
  prisma: PrismaClient,
  clientId: string,
): Promise<{ clientProductId: string | null } | null> {
  return prisma.chatWebEmbed.findFirst({
    where: { clientId, status: 'active', allowedOrigins: { isEmpty: true } },
    orderBy: { createdAt: 'asc' },
    select: { clientProductId: true },
  });
}
