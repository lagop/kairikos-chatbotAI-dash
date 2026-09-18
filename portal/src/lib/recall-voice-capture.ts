import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { fetchMediaBytes } from './whatsapp-api';
import { postAudioToWhisper, isWhisperConfigured } from './whisper';
import { extractJobFromTranscript, nextServiceDate, type JobCaptureFields } from './job-capture-ai';
import { logError } from './observability';

// =============================================================================
// Fase 2b — de una nota de voz a un Job, pasando por una persona.
//
// EL FLUJO, Y POR QUÉ TIENE TRES PASOS Y NO UNO:
//
//   1. captureVoiceNote()   audio → transcripción → extracción → BORRADOR
//                           y se le contesta con lo que se entendió.
//   2. (el profesional lee la tarjeta y contesta "sí" o "no")
//   3. confirmDraft()       el borrador se convierte en Job o ServiceQuote.
//
// El paso 2 no es burocracia. Lo que entra aquí es una nota de voz dictada
// de pie, con la furgoneta en marcha, por alguien que acaba de terminar un
// trabajo — y de ahí sale un importe que se va a facturar y una fecha que
// va a disparar un mensaje a un cliente final dentro de un año. Guardarlo
// sin que nadie lo mire sería fiarlo todo a que un modelo entendió bien
// "trescientos cuarenta" en vez de "trescientos catorce".
//
// LA VENTANA DE CONFIRMACIÓN CADUCA, Y ESO ES UNA FUNCIÓN. Un "sí" escrito
// tres días después no debe confirmar un borrador que el profesional ya no
// recuerda haber dictado: crearía un trabajo inventado con el importe de
// otro. Pasado el plazo se le pide que lo repita, que cuesta quince
// segundos.
//
// SOLO EL DUEÑO PUEDE CAPTURAR. La comprobación vive en la ruta (comparar
// contra RecallSubscription.ownerWhatsapp), pero conviene decirlo aquí
// también: estas son las cuentas de su negocio, y un desconocido que
// mande un audio no puede escribir en ellas.
// =============================================================================

/** Cuánto vive un borrador sin confirmar. Suficiente para que le dé tiempo
 *  a sacar el móvil del bolsillo, corto para que no se confunda con el
 *  trabajo siguiente. */
export const DRAFT_TTL_MINUTES = 60;

/** Las notas de voz de esta función son cortas por definición — quince o
 *  veinte segundos— así que no merecen el minuto que se le da a un recado
 *  de dos minutos. */
const TRANSCRIBE_TIMEOUT_MS = 25_000;

export type CaptureResult =
  | { status: 'drafted'; draftId: string; kind: string; reply: string }
  | { status: 'unclear'; reply: string }
  | { status: 'failed'; reason: 'not_configured' | 'media' | 'transcription' | 'extraction'; error: string };

/**
 * Convierte una nota de voz entrante en un borrador pendiente de confirmar.
 *
 * Nunca lanza: devuelve un resultado tipado, igual que el resto de
 * integraciones de este portal. Quien llama es una ruta que contesta a
 * n8n, y una excepción aquí se traduciría en un reintento que volvería a
 * transcribir el mismo audio.
 */
export async function captureVoiceNote(
  prisma: PrismaClient,
  input: {
    clientId: string;
    tenantId?: string | null;
    subscriptionId: string;
    /** El id del medio que manda Meta en el webhook. */
    mediaId: string;
    accessToken: string;
    now?: Date;
  },
): Promise<CaptureResult> {
  const now = input.now ?? new Date();

  if (!isWhisperConfigured()) {
    return { status: 'failed', reason: 'not_configured', error: 'whisper_not_configured' };
  }

  const media = await fetchMediaBytes(input.accessToken, input.mediaId);
  if (!media.ok) {
    return { status: 'failed', reason: 'media', error: media.error };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  let transcription;
  try {
    transcription = await postAudioToWhisper(media.data.bytes, {
      // WhatsApp manda las notas de voz en ogg/opus, no en mp3. El nombre
      // del fichero importa: algunos servidores compatibles con la API de
      // OpenAI deciden el decodificador por la extensión.
      filename: 'nota.ogg',
      contentType: media.data.contentType,
      signal: controller.signal,
    });
  } catch (err) {
    logError('recall_voice_capture.transcribe_failed', err, { clientId: input.clientId }, 'warn');
    return {
      status: 'failed',
      reason: 'transcription',
      error: err instanceof Error ? err.message : 'unknown error',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!transcription.ok) {
    return { status: 'failed', reason: 'transcription', error: transcription.error };
  }

  const extracted = await extractJobFromTranscript(transcription.text);
  if (!extracted.ok) {
    return { status: 'failed', reason: 'extraction', error: extracted.error };
  }
  if (extracted.skipped) {
    // Sin clave de Anthropic no hay extracción. Se degrada con gracia,
    // como el resto de integraciones: mejor decirlo que fingir.
    return { status: 'failed', reason: 'not_configured', error: 'no_api_key' };
  }

  const { ok: _ok, skipped: _skipped, ...fields } = extracted;

  if (fields.kind === 'unclear') {
    // No se crea borrador. Un borrador 'unclear' pendiente de confirmar
    // solo sirve para que el siguiente "sí" confirme una cosa que no era
    // ni un trabajo ni un presupuesto.
    return { status: 'unclear', reply: unclearReply() };
  }

  const draft = await prisma.jobCaptureDraft.create({
    data: {
      clientId: input.clientId,
      tenantId: input.tenantId ?? null,
      subscriptionId: input.subscriptionId,
      transcript: transcription.text,
      extracted: fields as unknown as Prisma.InputJsonValue,
      kind: fields.kind,
      status: 'pending',
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MINUTES * 60 * 1000),
    },
    select: { id: true },
  });

  return {
    status: 'drafted',
    draftId: draft.id,
    kind: fields.kind,
    reply: confirmationCard(fields),
  };
}

// ---------------------------------------------------------------------------
// La tarjeta
// ---------------------------------------------------------------------------

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return 'sin importe';
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  return `${amount.toLocaleString('es-ES', { maximumFractionDigits: 2 })} ${symbol}`;
}

/**
 * Lo que se le contesta al profesional para que lo confirme.
 *
 * Función pura y exportada para poder probar la redacción sin red. Va por
 * mensaje libre y no por plantilla: él acaba de escribirnos, así que su
 * ventana de 24 horas está abierta — el mismo razonamiento que el acuse de
 * la devolución de llamada.
 *
 * SE ENSEÑA LO QUE FALTA, no solo lo que se entendió. Un resumen que
 * esconde los huecos hace que se confirmen trabajos sin importe sin que
 * nadie se dé cuenta, y un trabajo sin importe no sirve para cobrar ni
 * para medir nada.
 */
export function confirmationCard(fields: JobCaptureFields): string {
  const lines: string[] = [];
  lines.push(fields.kind === 'quote' ? 'Presupuesto:' : 'Trabajo terminado:');

  lines.push(`· Cliente: ${fields.contactName ?? '—'}${fields.contactHint ? ` (${fields.contactHint})` : ''}`);
  lines.push(`· Servicio: ${fields.serviceType ?? fields.description ?? '—'}`);
  lines.push(`· Importe: ${formatAmount(fields.amount, fields.currency)}`);

  if (fields.equipment) {
    const parts = [fields.equipment.brand, fields.equipment.model, fields.equipment.installedYear]
      .filter(Boolean)
      .join(' ');
    if (parts) lines.push(`· Equipo: ${parts}`);
  }
  if (fields.nextServiceMonths !== null) {
    lines.push(`· Próxima revisión: en ${fields.nextServiceMonths} meses`);
  }

  lines.push('');
  lines.push('¿Lo guardo? Responde SÍ para confirmar o NO para descartarlo.');
  return lines.join('\n');
}

function unclearReply(): string {
  return 'No he entendido si eso era un trabajo terminado o un presupuesto. Si quieres, repítemelo diciendo el cliente, qué hiciste y el importe.';
}

// ---------------------------------------------------------------------------
// La confirmación
// ---------------------------------------------------------------------------

/** Quita acentos y signos, igual que el detector de bajas: "SÍ", "si" y
 *  "¡Sí!" son la misma respuesta. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const YES = new Set(['si', 'sí', 'ok', 'vale', 'correcto', 'confirmo', 'confirmar', 'guardalo', 'guarda', 'dale', 'eso es']);
const NO = new Set(['no', 'descartar', 'descartalo', 'borra', 'borralo', 'cancela', 'cancelar', 'mal', 'esta mal']);

export type ConfirmationIntent = 'yes' | 'no' | 'other';

/**
 * ¿Qué contestó el profesional a la tarjeta?
 *
 * Ojo con el "no": aquí SÍ cuenta como respuesta válida, al revés que en
 * el detector de bajas (recall-optout.ts), donde se excluyó a propósito.
 * No es una incoherencia, es que el contexto es otro: allí "no" era la
 * respuesta ambigua a una oferta de huecos y la consecuencia era
 * irreversible; aquí hay una pregunta de sí o no delante y la
 * consecuencia es tirar un borrador que se puede volver a dictar.
 */
export function confirmationIntent(text: string): ConfirmationIntent {
  const clean = normalise(text);
  if (!clean) return 'other';
  if (YES.has(clean)) return 'yes';
  if (NO.has(clean)) return 'no';
  // Frases cortas que empiezan por sí/no: "sí, guárdalo".
  const first = clean.split(' ')[0];
  if (clean.split(' ').length <= 4) {
    if (YES.has(first)) return 'yes';
    if (NO.has(first)) return 'no';
  }
  return 'other';
}

export type ConfirmResult =
  | { status: 'created'; kind: 'job' | 'quote'; id: string; reply: string }
  | { status: 'discarded'; reply: string }
  | { status: 'expired'; reply: string }
  | { status: 'no_draft' };

/**
 * Resuelve el borrador vivo de una suscripción con la respuesta del dueño.
 *
 * Devuelve `no_draft` cuando no hay ninguno pendiente, y eso NO es un
 * error: significa que ese "sí" era otra cosa, y quien llama debe seguir
 * probando (una respuesta al resumen diario, conversación normal). Por eso
 * esta función se consulta antes que el resumen pero solo actúa si hay
 * borrador — no puede tragarse respuestas que no son suyas.
 */
export async function resolveDraftWithReply(
  prisma: PrismaClient,
  input: { subscriptionId: string; text: string; now?: Date },
): Promise<ConfirmResult> {
  const intent = confirmationIntent(input.text);
  if (intent === 'other') return { status: 'no_draft' };

  const now = input.now ?? new Date();
  const draft = await prisma.jobCaptureDraft.findFirst({
    where: { subscriptionId: input.subscriptionId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  if (!draft) return { status: 'no_draft' };

  if (draft.expiresAt <= now) {
    await prisma.jobCaptureDraft.update({
      where: { id: draft.id },
      data: { status: 'expired', resolvedAt: now },
    });
    return {
      status: 'expired',
      reply: 'Ha pasado demasiado tiempo desde esa nota y ya no puedo guardarla. Si sigue valiendo, vuelve a dictármela.',
    };
  }

  if (intent === 'no') {
    await prisma.jobCaptureDraft.update({
      where: { id: draft.id },
      data: { status: 'discarded', resolvedAt: now },
    });
    return { status: 'discarded', reply: 'Descartado. No he guardado nada.' };
  }

  const fields = draft.extracted as unknown as JobCaptureFields;

  if (draft.kind === 'quote') {
    const quote = await prisma.serviceQuote.create({
      data: {
        clientId: draft.clientId,
        tenantId: draft.tenantId,
        // Fase 3 multi-instancia — de que linea vino. El borrador ya la
        // traia; antes se tiraba aqui y despues no habia forma de saberlo.
        subscriptionId: draft.subscriptionId,
        contactId: draft.contactId,
        issuedAt: draft.createdAt,
        amount: fields.amount ?? null,
        currency: fields.currency ?? 'EUR',
        status: 'open',
        description: fields.description ?? fields.serviceType ?? null,
        captureMethod: 'voice_note',
        rawCapture: draft.transcript,
      },
      select: { id: true },
    });
    await prisma.jobCaptureDraft.update({
      where: { id: draft.id },
      data: { status: 'confirmed', serviceQuoteId: quote.id, resolvedAt: now },
    });
    return { status: 'created', kind: 'quote', id: quote.id, reply: 'Guardado como presupuesto abierto.' };
  }

  // La fecha la calcula el portal, NUNCA el modelo. Ver job-capture-ai.ts.
  const nextDue = nextServiceDate(draft.createdAt, fields.nextServiceMonths);

  const job = await prisma.job.create({
    data: {
      clientId: draft.clientId,
      tenantId: draft.tenantId,
      // Fase 3 multi-instancia — ver el comentario del presupuesto de arriba.
      subscriptionId: draft.subscriptionId,
      contactId: draft.contactId,
      completedAt: draft.createdAt,
      serviceType: fields.serviceType ?? null,
      equipment: (fields.equipment ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      amount: fields.amount ?? null,
      currency: fields.currency ?? 'EUR',
      nextServiceDueAt: nextDue,
      captureMethod: 'voice_note',
      rawCapture: draft.transcript,
    },
    select: { id: true },
  });
  await prisma.jobCaptureDraft.update({
    where: { id: draft.id },
    data: { status: 'confirmed', jobId: job.id, resolvedAt: now },
  });

  const extra = nextDue
    ? ` Te avisaré cuando toque la revisión, en ${fields.nextServiceMonths} meses.`
    : '';
  return { status: 'created', kind: 'job', id: job.id, reply: `Guardado.${extra}` };
}
