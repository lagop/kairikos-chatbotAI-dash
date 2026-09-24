import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// A7 — códigos de referido y de socio.
//
// Dos cosas con la misma mecánica: un CLIENTE que recomienda a otro (los dos
// ganan un mes) y un SOCIO —un almacén de fontanería, un gremio, una
// gestoría— que cobra comisión recurrente sobre lo que trae.
//
// Lo que esto hace y lo que NO. No da descuentos: eso lo siguen haciendo los
// cupones de Stripe, que ya existen (stripe-promotions.ts). Lo que resuelve
// es la única pregunta que hoy no se puede responder — QUIÉN trajo a este
// cliente. Sin esa respuesta, una comisión del 20 % es una discusión mensual
// con alguien que te está trayendo negocio, que es la peor discusión posible.
//
// La atribución es de UNA vez por cliente y gana el primero. Si alguien llega
// con el código de un distribuidor y tres meses después pone el de un amigo,
// el que lo trajo fue el distribuidor.
// =============================================================================

/** Alfabeto sin caracteres que se confunden al teclear un cartel: nada de
 *  O/0, I/1, B/8. Un socio imprime el código y lo lee gente con prisa. */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY2345679';

export function generateReferralCode(prefix: string): string {
  const cuerpo = Array.from(randomBytes(5))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
  return `${normalizeCode(prefix).slice(0, 8)}-${cuerpo}`;
}

/** Los códigos se comparan siempre normalizados: quien lo teclea lo escribirá
 *  en minúsculas, con espacios o con guiones de más. */
export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export interface CommissionRow {
  code: string;
  kind: string;
  beneficiario: string;
  clientesTraidos: number;
  mrrTraidoCents: number;
  comisionMensualCents: number;
}

/**
 * Puro: de las atribuciones y sus importes a lo que se le debe a cada uno.
 *
 * La comisión se calcula sobre el MRR ACTIVO de los clientes que trajo, no
 * sobre lo que facturaron alguna vez: si el cliente se da de baja, la
 * comisión se acaba. Es lo que hace que el socio tenga interés en traer
 * clientes que se queden y no solo en traer clientes.
 */
export function computeCommissions(
  codes: {
    code: string;
    kind: string;
    partnerName: string | null;
    referrerName: string | null;
    commissionPercent: number | null;
    clientMrrCents: number[];
  }[],
): CommissionRow[] {
  return codes
    .map((row) => {
      const mrr = row.clientMrrCents.reduce((acc, v) => acc + v, 0);
      return {
        code: row.code,
        kind: row.kind,
        beneficiario: row.partnerName ?? row.referrerName ?? '—',
        clientesTraidos: row.clientMrrCents.length,
        mrrTraidoCents: mrr,
        // Los referidos no cobran dinero: su premio es un mes gratis, que se
        // aplica con un cupón y no aquí.
        comisionMensualCents:
          row.kind === 'partner' && row.commissionPercent
            ? Math.round((mrr * row.commissionPercent) / 100)
            : 0,
      };
    })
    .sort((a, b) => b.comisionMensualCents - a.comisionMensualCents);
}

export type AttributionResult =
  | { ok: true; codeId: string }
  | { ok: false; reason: 'unknown_code' | 'inactive_code' | 'already_attributed' | 'self_referral' };

/** Apunta que este cliente vino por este código. Idempotente por el índice
 *  único: un segundo intento no pisa al primero. */
export async function attributeClient(
  prisma: PrismaClient,
  clientId: string,
  rawCode: string,
): Promise<AttributionResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'unknown_code' };

  const row = await prisma.referralCode.findUnique({ where: { code } });
  if (!row) return { ok: false, reason: 'unknown_code' };
  if (!row.active) return { ok: false, reason: 'inactive_code' };
  // Nadie se recomienda a sí mismo para ganarse un mes gratis.
  if (row.referrerClientId === clientId) return { ok: false, reason: 'self_referral' };

  const existing = await prisma.referralAttribution.findUnique({ where: { clientId } });
  if (existing) return { ok: false, reason: 'already_attributed' };

  await prisma.referralAttribution.create({ data: { codeId: row.id, clientId } });
  return { ok: true, codeId: row.id };
}

/** El informe que se le manda a cada socio y que se mira antes de pagar. */
export async function loadCommissionReport(prisma: PrismaClient): Promise<CommissionRow[]> {
  const codes = await prisma.referralCode.findMany({
    include: {
      referrer: { select: { name: true } },
      attributions: {
        select: {
          client: {
            select: {
              clientProducts: {
                where: { status: 'active' },
                select: { product: { select: { priceCents: true } }, subscription: { select: { amountCents: true, status: true } } },
              },
            },
          },
        },
      },
    },
  });

  return computeCommissions(
    codes.map((row) => ({
      code: row.code,
      kind: row.kind,
      partnerName: row.partnerName,
      referrerName: row.referrer?.name ?? null,
      commissionPercent: row.commissionPercent,
      clientMrrCents: row.attributions.map((a) =>
        a.client.clientProducts.reduce(
          (acc, cp) =>
            acc +
            ((cp.subscription && ['active', 'trialing', 'past_due'].includes(cp.subscription.status)
              ? cp.subscription.amountCents
              : cp.product.priceCents) ?? 0),
          0,
        ),
      ),
    })),
  );
}
