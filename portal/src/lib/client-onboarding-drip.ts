import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { notifyFromAddress } from './email-sender';
import { logError } from './observability';

// =============================================================================
// A3 — la secuencia de bienvenida de un cliente recién activado.
//
// El plan la describe como "secuencia de la prueba gratis" (días 0, 1, 3, 7,
// 12, 15), pero HOY NO HAY PRUEBAS GRATIS: el checkout no crea trials y
// Stripe no las genera solas. Construir una secuencia de conversión de prueba
// sin pruebas sería código muerto esperando a un producto que no existe.
//
// Así que es lo mismo aplicado a lo que sí pasa: alguien contrata y hay
// catorce días en los que o consigue su primer resultado, o se olvida. Cuatro
// correos, no seis: el día 0 (qué hacer ahora), el 1 (¿lo has hecho?), el 3
// (primer resultado o empujón) y el 14 (cómo va el primer mes).
//
// Cada paso se manda UNA vez y se sella. El estado vive en la propia fila del
// producto contratado (onboardingDripStep), no en una tabla nueva: es un
// contador por unidad contratada y no tiene vida propia.
//
// Si el cliente ya ha tenido su primer resultado, la secuencia SALTA los
// empujones: nada peor que un correo preguntando si ya lo has configurado
// cuando llevas tres días usándolo.
// =============================================================================

export interface DripStep {
  /** Días desde la activación a partir de los cuales toca este paso. */
  afterDays: number;
  key: string;
}

export const DRIP_STEPS: readonly DripStep[] = Object.freeze([
  { afterDays: 0, key: 'bienvenida' },
  { afterDays: 1, key: 'recordatorio_activacion' },
  { afterDays: 3, key: 'primer_resultado' },
  { afterDays: 14, key: 'primer_mes' },
]);

/** Pasado este plazo desde el alta, la secuencia ya no tiene sentido y no se
 *  manda: un correo de bienvenida con tres semanas de retraso no da la
 *  bienvenida a nada, delata que acabamos de encender algo.
 *
 *  Es también lo que impide el efecto que se vio al desplegar esto: los
 *  clientes activados hace semanas entraban en la secuencia desde el paso
 *  cero como si acabaran de contratar. */
export const DRIP_MAX_AGE_DAYS = 21;

/** Qué paso toca ahora, o null si ninguno. Puro para poder probar los bordes
 *  —recién contratado, secuencia terminada, alta demasiado vieja, barrido
 *  parado una semana— sin base de datos. */
export function nextDripStep(
  subscribedAt: Date,
  stepsSent: number,
  now: Date = new Date(),
): DripStep | null {
  if (stepsSent >= DRIP_STEPS.length) return null;
  const dias = (now.getTime() - subscribedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (dias > DRIP_MAX_AGE_DAYS) return null;
  const candidato = DRIP_STEPS[stepsSent];
  return dias >= candidato.afterDays ? candidato : null;
}

/** Un alta demasiado vieja como para empezar la secuencia. Se marca
 *  terminada de una vez en lugar de dejarla mirándose en cada tick para
 *  siempre. */
export function isTooOldForDrip(subscribedAt: Date, now: Date = new Date()): boolean {
  return (now.getTime() - subscribedAt.getTime()) / (24 * 60 * 60 * 1000) > DRIP_MAX_AGE_DAYS;
}

export interface DripEmailInput {
  businessName: string;
  productCode: string;
  /** Si ya ha tenido algún resultado con el producto (llamadas, leads,
   *  reseñas). Cambia el tono de los pasos intermedios. */
  yaTieneResultados: boolean;
}

/** Puro: el correo de cada paso. Están todos juntos para poder leer de una
 *  vez qué recibe un cliente en sus primeras dos semanas — que es la mejor
 *  forma de darse cuenta de que uno sobra. */
export function buildDripEmail(
  step: DripStep,
  input: DripEmailInput,
): { subject: string; text: string } | null {
  const nombre = input.businessName;

  if (step.key === 'bienvenida') {
    return {
      subject: `Ya tienes ${input.productCode} activo`,
      text: [
        `Hola ${nombre},`,
        '',
        'Ya está todo listo por nuestra parte. Entra en tu portal y termina la configuración: son cinco minutos y es lo único que hace falta para que empiece a funcionar.',
        '',
        'Si prefieres que lo hagamos juntos, respóndeme a este correo y lo vemos por teléfono.',
        '',
        '— Kairikos',
      ].join('\n'),
    };
  }

  if (step.key === 'recordatorio_activacion') {
    // Si ya está funcionando, este correo no tiene sentido y no se manda.
    if (input.yaTieneResultados) return null;
    return {
      subject: '¿Te echo una mano con la configuración?',
      text: [
        `Hola ${nombre},`,
        '',
        'He visto que todavía no has terminado de configurarlo. No es un reproche: es el paso donde se atasca casi todo el mundo, y son cinco minutos.',
        '',
        'Dime cuándo te viene bien y lo dejamos hecho en una llamada.',
        '',
        '— Kairikos',
      ].join('\n'),
    };
  }

  if (step.key === 'primer_resultado') {
    return input.yaTieneResultados
      ? {
          subject: 'Ya está funcionando',
          text: [
            `Hola ${nombre},`,
            '',
            'Esto ya está dando resultados. A partir de ahora te mandaré un resumen cada semana para que lo veas sin tener que entrar a mirar.',
            '',
            '— Kairikos',
          ].join('\n'),
        }
      : {
          subject: 'Sigue sin estar en marcha',
          text: [
            `Hola ${nombre},`,
            '',
            'Van tres días y todavía no hay nada funcionando. Algo se nos ha quedado a medias y prefiero resolverlo ahora que dentro de un mes.',
            '',
            'Respóndeme y lo miramos.',
            '',
            '— Kairikos',
          ].join('\n'),
        };
  }

  return {
    subject: 'Dos semanas: ¿cómo va?',
    text: [
      `Hola ${nombre},`,
      '',
      'Llevas dos semanas con nosotros. Te escribo por una sola cosa: si hay algo que no está funcionando como esperabas, quiero saberlo ahora.',
      '',
      'Respóndeme aunque sea una línea.',
      '',
      '— Kairikos',
    ].join('\n'),
  };
}

export interface DripSweepResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function sweepOnboardingDrip(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DripSweepResult> {
  const rows = await prisma.clientProduct.findMany({
    where: { status: 'active', onboardingDripStep: { lt: DRIP_STEPS.length } },
    select: {
      id: true,
      clientId: true,
      subscribedAt: true,
      onboardingDripStep: true,
      product: { select: { code: true } },
      client: { select: { name: true, email: true } },
    },
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    // Un alta vieja se cierra entera de una vez: si solo se saltara el paso,
    // se volvería a mirar en cada tick de aquí a la eternidad.
    if (isTooOldForDrip(row.subscribedAt, now)) {
      await prisma.clientProduct.update({
        where: { id: row.id },
        data: { onboardingDripStep: DRIP_STEPS.length },
      });
      skipped += 1;
      continue;
    }

    const step = nextDripStep(row.subscribedAt, row.onboardingDripStep, now);
    if (!step) continue;

    const [llamadas, leads, resenas] = await Promise.all([
      prisma.callEvent.count({ where: { clientId: row.clientId } }),
      prisma.lead.count({ where: { clientId: row.clientId } }),
      prisma.googleReview.count({ where: { clientId: row.clientId } }),
    ]);

    const email = buildDripEmail(step, {
      businessName: row.client.name ?? 'tu negocio',
      productCode: row.product.code,
      yaTieneResultados: llamadas + leads + resenas > 0,
    });

    // Un paso que no aplica (el recordatorio a quien ya lo tiene funcionando)
    // se sella igual: si no, se reintentaría en cada tick para siempre.
    if (email === null) {
      skipped += 1;
    } else {
      const ok = await sendDripEmail(row.client.email, email);
      if (ok) sent += 1;
      else failed += 1;
    }

    await prisma.clientProduct.update({
      where: { id: row.id },
      data: { onboardingDripStep: row.onboardingDripStep + 1 },
    });
  }

  return { considered: rows.length, sent, skipped, failed };
}

async function sendDripEmail(to: string, email: { subject: string; text: string }): Promise<boolean> {
  if (!to || !to.includes('@')) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: notifyFromAddress(),
      to: [to],
      subject: email.subject,
      text: email.text,
    });
    if (result.error) {
      logError('onboarding_drip.send_failed', new Error(result.error.message), { to }, 'warn');
      return false;
    }
    return true;
  } catch (err) {
    logError('onboarding_drip.send_failed', err, { to }, 'warn');
    return false;
  }
}
