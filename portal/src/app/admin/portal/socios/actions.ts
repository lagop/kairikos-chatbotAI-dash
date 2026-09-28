'use server';

// =============================================================================
// A7 — alta de códigos de socio y de referido.
//
// Esto existía como "se crean a mano en la base de datos", y era una decisión
// razonable mientras nada los usara. Dejó de serlo al enchufar la captura en
// /empezar: un código que solo se puede crear con un INSERT no se reparte
// nunca, y sin códigos repartidos la pantalla de comisiones enseña siempre lo
// mismo — nada.
//
// Mismo patrón que support/actions.ts: la acción de formulario ES la
// comprobación de permisos (session.isOperator), sin endpoint aparte.
//
// El código se genera aquí y no lo escribe el operador: el alfabeto sin
// O/0/I/1/B/8 de generateReferralCode es lo que hace que se pueda leer de un
// cartel, y un código tecleado a mano se lo salta sin enterarse.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { generateReferralCode, normalizeCode } from '@/lib/referrals';

export async function createReferralCodeAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.isOperator) return;
  if (!isDatabaseConfigured) return;

  const kind = formData.get('kind');
  if (kind !== 'partner' && kind !== 'referral') return;

  const nombre = String(formData.get('nombre') ?? '').trim().slice(0, 200);
  const email = String(formData.get('email') ?? '').trim().slice(0, 200);
  const clienteId = String(formData.get('clienteId') ?? '').trim();
  const porcentajeRaw = Number(formData.get('porcentaje'));

  // Un socio sin nombre no se puede pagar; un referido sin cliente detrás no
  // es un referido. Cada tipo exige lo suyo y nada más.
  if (kind === 'partner' && !nombre) return;
  if (kind === 'referral' && !clienteId) return;

  // El prefijo es lo que hace reconocible el código de un vistazo cuando
  // llegan treinta altas y hay que saber de quién vino cada una.
  const prefijo = normalizeCode(kind === 'partner' ? nombre : 'REF') || 'REF';

  // 0-100 y solo para socios: los referidos cobran en un mes gratis, que se
  // aplica con un cupón de Stripe y no con este número.
  const commissionPercent =
    kind === 'partner' && Number.isFinite(porcentajeRaw)
      ? Math.min(100, Math.max(0, Math.round(porcentajeRaw)))
      : null;

  // El código es único en la base; en la práctica una colisión con cinco
  // caracteres del alfabeto es remota, pero reintentar es más barato que
  // enseñarle un 500 a quien solo quería dar de alta a un almacén.
  for (let intento = 0; intento < 5; intento += 1) {
    try {
      await prisma.referralCode.create({
        data: {
          code: generateReferralCode(prefijo),
          kind,
          partnerName: kind === 'partner' ? nombre : null,
          partnerEmail: kind === 'partner' && email ? email : null,
          referrerClientId: kind === 'referral' ? clienteId : null,
          commissionPercent,
        },
      });
      break;
    } catch {
      if (intento === 4) return;
    }
  }

  revalidatePath('/admin/portal/socios');
}

export async function toggleReferralCodeAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session.isOperator) return;
  if (!isDatabaseConfigured) return;

  const code = String(formData.get('code') ?? '').trim();
  if (!code) return;

  const row = await prisma.referralCode.findUnique({ where: { code }, select: { id: true, active: true } });
  if (!row) return;

  // Desactivar y no borrar: las atribuciones que ya trajo siguen contando
  // para la comisión de este mes. Borrar el código borraría también a quién
  // trajo a quién, que es justo lo único que esto guarda.
  await prisma.referralCode.update({ where: { id: row.id }, data: { active: !row.active } });

  revalidatePath('/admin/portal/socios');
}
