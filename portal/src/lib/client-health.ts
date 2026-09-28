import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendOperatorNotification } from './operator-notify';
import { getOperatorAlertRecipients } from './operator-alert-settings';
import { logError } from './observability';

// =============================================================================
// A8 — riesgo de baja, y A6 — qué ofrecerle a quién.
//
// Las dos miran lo mismo (cómo le va a cada cliente con lo que ya paga) y por
// eso viven juntas: el mismo barrido que detecta al que está a punto de irse
// detecta al que está listo para comprar otra cosa.
//
// TRES SEÑALES DE RIESGO, y las tres existen porque una baja casi nunca
// avisa: el cliente deja de usar el producto, deja de pagar, o deja de
// entrar. La primera es la que más tiempo da para reaccionar, y es justo la
// que hoy no se miraba.
//
//   1. Producto activo con CERO uso en 14 días. El aviso de consumo anómalo
//      que ya existía (usage-spike) mira lo contrario: quien gasta de más.
//      Quien gasta cero no dispara nada y es el que se va.
//   2. Pago fallido. El evento de Stripe ya se recibía y se guardaba, pero
//      no avisaba a nadie: una suscripción en past_due se quedaba ahí.
//   3. Sin entrar al portal en 30 días, teniendo producto activo.
//
// REGLAS DE VENTA CRUZADA. Se disparan por USO, no por tiempo: ofrecerle
// reseñas a quien todavía no ha recuperado ninguna llamada es ruido; a quien
// ha recuperado quince, es la conversación natural.
//
// Ninguna de las dos cosas manda nada al cliente. Las dos avisan al OPERADOR,
// porque las dos terminan en una llamada. Un correo automático diciéndole a
// un cliente que parece que se va es la mejor forma de recordarle que puede
// irse.
// =============================================================================

export const ZERO_USE_DAYS = 14;
export const NO_LOGIN_DAYS = 30;

export interface ChurnRiskRow {
  clientId: string;
  clientName: string;
  /** 'sin_uso' | 'pago_fallido' | 'sin_entrar' */
  reason: 'sin_uso' | 'pago_fallido' | 'sin_entrar';
  detail: string;
}

export interface UpsellRow {
  clientId: string;
  clientName: string;
  /** El producto que se le ofrece. */
  productCode: string;
  reason: string;
}

export interface ClientHealthResult {
  risks: ChurnRiskRow[];
  upsells: UpsellRow[];
  notified: number;
}

interface ClientSnapshot {
  id: string;
  name: string | null;
  lastLoginAt: Date | null;
  products: { code: string; status: string; subscriptionStatus: string | null }[];
  callsLast14: number;
  callsTotal: number;
  reviewsTotal: number;
  leadsLast14: number;
}

/**
 * Puro: de la foto de un cliente a sus riesgos. Aislado para poder probar los
 * bordes —cliente nuevo que aún no ha usado nada, cliente sin productos— sin
 * base de datos.
 *
 * Un cliente RECIÉN activado no dispara "sin uso": los primeros catorce días
 * son el alta, no el abandono. Se distingue por si ha usado algo alguna vez.
 */
export function detectChurnRisks(client: ClientSnapshot, now: Date = new Date()): ChurnRiskRow[] {
  const risks: ChurnRiskRow[] = [];
  const activos = client.products.filter((p) => p.status === 'active');
  if (activos.length === 0) return risks;
  const nombre = client.name ?? client.id;

  const impagado = activos.find(
    (p) => p.subscriptionStatus === 'past_due' || p.subscriptionStatus === 'unpaid',
  );
  if (impagado) {
    risks.push({
      clientId: client.id,
      clientName: nombre,
      reason: 'pago_fallido',
      detail: `Su suscripción de ${impagado.code} está en ${impagado.subscriptionStatus}. Stripe no ha podido cobrar.`,
    });
  }

  const tieneRecall = activos.some((p) => p.code === 'recall');
  if (tieneRecall && client.callsTotal > 0 && client.callsLast14 === 0) {
    risks.push({
      clientId: client.id,
      clientName: nombre,
      reason: 'sin_uso',
      detail: `Paga recall y no ha entrado ni una llamada en ${ZERO_USE_DAYS} días. Antes sí las tenía.`,
    });
  }

  if (client.lastLoginAt !== null) {
    const dias = Math.floor((now.getTime() - client.lastLoginAt.getTime()) / (24 * 60 * 60 * 1000));
    if (dias >= NO_LOGIN_DAYS) {
      risks.push({
        clientId: client.id,
        clientName: nombre,
        reason: 'sin_entrar',
        detail: `Lleva ${dias} días sin entrar al portal teniendo ${activos.length} producto(s) activo(s).`,
      });
    }
  }

  return risks;
}

/**
 * Puro: qué ofrecerle a este cliente, según lo que ya usa.
 *
 * Las reglas son las del plan y se disparan por uso, no por calendario. Cada
 * una se ofrece una vez: si ya tiene el producto, no aparece.
 */
export function detectUpsells(client: ClientSnapshot): UpsellRow[] {
  const rows: UpsellRow[] = [];
  const activos = new Set(client.products.filter((p) => p.status === 'active').map((p) => p.code));
  const nombre = client.name ?? client.id;
  if (activos.size === 0) return rows;

  // recall funcionando → reviews. "Esos clientes que recuperaste pueden
  // dejarte reseña automáticamente."
  if (activos.has('recall') && !activos.has('reviews') && client.callsTotal >= 5) {
    rows.push({
      clientId: client.id,
      clientName: nombre,
      productCode: 'reviews',
      reason: `Ha recuperado ${client.callsTotal} llamadas. Esos clientes pueden dejarle reseña solos.`,
    });
  }

  // reputación ganada → web y leads. "Ya tienes reputación; ahora hace falta
  // que te encuentren."
  if (activos.has('reviews') && !activos.has('web') && client.reviewsTotal >= 15) {
    rows.push({
      clientId: client.id,
      clientName: nombre,
      productCode: 'web',
      reason: `Tiene ${client.reviewsTotal} reseñas. Ya tiene reputación; ahora hace falta que le encuentren.`,
    });
  }

  // muchos leads entrando → leads, para no perderlos por el camino.
  if (!activos.has('leads') && !activos.has('prospecting') && client.leadsLast14 >= 10) {
    rows.push({
      clientId: client.id,
      clientName: nombre,
      productCode: 'leads',
      reason: `Le han entrado ${client.leadsLast14} contactos en 14 días y no tiene bandeja donde seguirlos.`,
    });
  }

  return rows;
}

/** El barrido: reúne la foto de cada cliente, aplica las dos reglas y avisa
 *  al operador. Seguro de llamar cada tick — el dedupe por (cliente, kind,
 *  día) de sendOperatorNotification impide repetir el mismo aviso. */
export async function sweepClientHealth(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ClientHealthResult> {
  const desde14 = new Date(now.getTime() - ZERO_USE_DAYS * 24 * 60 * 60 * 1000);

  const clients = await prisma.chatbotClient.findMany({
    where: { clientProducts: { some: { status: 'active' } } },
    select: {
      id: true,
      name: true,
      lastLoginAt: true,
      clientProducts: {
        select: {
          status: true,
          product: { select: { code: true } },
          subscription: { select: { status: true } },
        },
      },
    },
  });

  const risks: ChurnRiskRow[] = [];
  const upsells: UpsellRow[] = [];

  for (const client of clients) {
    const [callsLast14, callsTotal, reviewsTotal, leadsLast14] = await Promise.all([
      prisma.callEvent.count({ where: { clientId: client.id, startedAt: { gte: desde14 } } }),
      prisma.callEvent.count({ where: { clientId: client.id } }),
      prisma.googleReview.count({ where: { clientId: client.id } }),
      prisma.lead.count({ where: { clientId: client.id, source: 'inbound', createdAt: { gte: desde14 } } }),
    ]);

    const snapshot: ClientSnapshot = {
      id: client.id,
      name: client.name,
      lastLoginAt: client.lastLoginAt,
      products: client.clientProducts.map((cp) => ({
        code: cp.product.code,
        status: cp.status,
        subscriptionStatus: cp.subscription?.status ?? null,
      })),
      callsLast14,
      callsTotal,
      reviewsTotal,
      leadsLast14,
    };

    risks.push(...detectChurnRisks(snapshot, now));
    upsells.push(...detectUpsells(snapshot));
  }

  if (risks.length === 0 && upsells.length === 0) return { risks, upsells, notified: 0 };

  const recipients = await getOperatorAlertRecipients();
  const lineas = [
    ...(risks.length > 0
      ? ['CLIENTES EN RIESGO:', ...risks.map((r) => `- ${r.clientName}: ${r.detail}`), '']
      : []),
    ...(upsells.length > 0
      ? ['LISTOS PARA OFRECERLES ALGO:', ...upsells.map((u) => `- ${u.clientName} → ${u.productCode}: ${u.reason}`)]
      : []),
  ];

  // Un solo correo con todo, no uno por cliente: cinco avisos sueltos el
  // mismo minuto se leen como spam, uno con cinco nombres se lee como una
  // lista de tareas. Mismo criterio que sendStaleLeadEmail.
  const sent = await sendOperatorNotification({
    kind: 'churn-risk',
    to: recipients,
    subject: `Salud de clientes: ${risks.length} en riesgo, ${upsells.length} para ofrecer`,
    text: lineas.join('\n'),
    html: `<pre style="font-family:system-ui,sans-serif">${lineas
      .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
      .join('\n')}</pre>`,
  });
  if (!sent.ok) {
    logError('client_health.notify_failed', new Error(sent.error), {}, 'warn');
    return { risks, upsells, notified: 0 };
  }

  return { risks, upsells, notified: 1 };
}
