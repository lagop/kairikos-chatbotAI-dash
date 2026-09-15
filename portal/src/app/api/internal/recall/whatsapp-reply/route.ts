import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { applyDigestReply } from '@/lib/recall-reviews';
import { applyCallbackReply, callbackReplyText, sendCallbackReply } from '@/lib/recall-callbacks';
import { applyOptOut, OPT_OUT_CONFIRMATION } from '@/lib/recall-optout';
import { decryptMetaToken } from '@/lib/meta-business';
import { captureVoiceNote, resolveDraftWithReply } from '@/lib/recall-voice-capture';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP-XX (Fase 10) — POST /api/internal/recall/whatsapp-reply
//
// The owner answers his 19:00 digest with "1 y 3". Meta delivers that to
// n8n, which already forwards inbound WhatsApp to
// /api/internal/channels/whatsapp/message (the chatbot conversation
// route). This is its sibling: n8n tries this one FIRST, and only falls
// through to the conversation route when this answers `handled: false`.
//
// That ordering, rather than a flag in n8n, is deliberate. Whether a
// message is a digest reply depends on facts only the portal has — is the
// sender this client's owner, and is there a digest from the last twenty
// hours he could be answering — and duplicating that test in a workflow
// is how the two definitions drift apart.
//
// A message that is NOT a digest reply is not an error. `handled: false`
// with 200 is the normal answer for "this is ordinary conversation", and
// n8n routes it onward.
// =============================================================================

const BodySchema = z.object({
  /** The Meta phone_number_id the message arrived on — identifies which
   *  client's WhatsApp this is. */
  phoneNumberId: z.string().trim().min(1),
  /** The sender's wa_id (their phone number). */
  from: z.string().trim().min(1),
  // Fase 2b — el texto deja de ser obligatorio porque ahora también entra
  // audio, y una nota de voz no trae ninguno.
  text: z.string().trim().min(1).max(1000).optional(),
  /** Fase 2b — el id del medio, cuando el mensaje es una nota de voz. */
  audioMediaId: z.string().trim().min(1).optional(),
})
  // Uno de los dos, pero no ninguno: un mensaje sin contenido no es un
  // mensaje, y aceptarlo dejaría que n8n reenviara ruido en silencio.
  .refine((b) => Boolean(b.text || b.audioMediaId), {
    message: 'text_or_audio_required',
  });

/** Compare two phone numbers the way a human means it. Meta's `wa_id`
 *  omits the leading '+' that we store, and a client may have typed his
 *  own number with spaces — so a naive === would silently never match the
 *  owner and every digest reply would fall through as conversation. */
function businessNameOf(subscription: { client: { name: string; companyName: string | null } }): string {
  return subscription.client.companyName ?? subscription.client.name;
}

function sameNumber(a: string, b: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, '');
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  // One may carry a country code the other omits.
  return x === y || x.endsWith(y) || y.endsWith(x);
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'whatsapp', externalId: body.data.phoneNumberId, status: 'active' },
    select: {
      id: true,
      clientId: true,
      // Fase 2b — hacen falta para bajarse el audio de una nota de voz.
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });
  if (!connection) {
    return NextResponse.json({ handled: false, reason: 'unknown_number' });
  }

  const subscription = await prisma.recallSubscription.findFirst({
    where: { clientId: connection.clientId, status: 'active' },
    // Fase 3 — el nombre del negocio hace falta para el acuse que recibe
    // quien llamó; el mensaje lo lee un desconocido y firmarlo importa.
    select: {
      id: true,
      tenantId: true,
      ownerWhatsapp: true,
      client: { select: { name: true, companyName: true } },
    },
  });
  if (!subscription?.ownerWhatsapp) {
    return NextResponse.json({ handled: false, reason: 'no_subscription' });
  }

  const isOwner = sameNumber(subscription.ownerWhatsapp, body.data.from);

  // =========================================================================
  // Fase 2b — una nota de voz del DUEÑO es una captura de trabajo.
  //
  // Va antes que todo lo demás porque un audio no puede ser ninguna de las
  // otras cosas que se contestan por aquí: ni una baja, ni la elección de
  // un hueco, ni una respuesta al resumen. Todas esas son texto.
  //
  // Y SOLO DEL DUEÑO. Estas son las cuentas de su negocio: un audio de un
  // desconocido no puede crear un trabajo con un importe. Se ignora sin
  // contestar —`handled: false`— para que siga su camino como
  // conversación normal hacia el chatbot, que es lo que de verdad es.
  // =========================================================================
  if (body.data.audioMediaId) {
    if (!isOwner) {
      return NextResponse.json({ handled: false, reason: 'audio_not_from_owner' });
    }

    let token: string;
    try {
      token = decryptMetaToken({
        ciphertext: connection.accessTokenCiphertext,
        iv: connection.accessTokenIv,
        tag: connection.accessTokenTag,
      });
    } catch {
      return NextResponse.json({ handled: false, reason: 'sender_unavailable' });
    }

    const capture = await captureVoiceNote(prisma, {
      clientId: connection.clientId,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      mediaId: body.data.audioMediaId,
      accessToken: token,
    });

    // La tarjeta —y el aviso de que no se entendió— van por mensaje libre:
    // acaba de escribirnos, así que su ventana de 24 horas está abierta.
    if (capture.status === 'drafted' || capture.status === 'unclear') {
      await sendCallbackReply(prisma, {
        clientId: connection.clientId,
        to: body.data.from,
        text: capture.reply,
      });
    }

    return NextResponse.json({ handled: true, outcome: capture });
  }

  // A partir de aquí todo es texto. El esquema ya garantiza que hay uno de
  // los dos, pero TypeScript no lo sabe y una aserción sería peor.
  const messageText = body.data.text;
  if (!messageText) {
    return NextResponse.json({ handled: false, reason: 'empty_message' });
  }

  // Only the owner can answer his own digest. Without this check any
  // customer replying "1" to an unrelated message would be requesting
  // review invitations on the client's behalf.
  //
  // Fase 3 — quien NO es el dueño puede estar contestando a la oferta de
  // huecos para que le devuelvan la llamada, que es lo único que un
  // desconocido puede contestarnos por aquí. Se comprueba antes de dar el
  // mensaje por conversación normal.
  if (!isOwner) {
    // Fase 0 — LA BAJA SE MIRA ANTES QUE NADA MÁS, y ese orden es el
    // punto. "BAJA" no es la elección de un hueco, así que si se dejara
    // pasar por applyCallbackReply caería como conversación normal y la
    // persona acabaría hablando con el chatbot del negocio después de
    // haber pedido explícitamente que dejáramos de escribirle.
    //
    // Solo para quien NO es el dueño: la baja es de quien recibe los
    // mensajes de recuperación, y suprimir el número del propio dueño
    // apagaría su producto desde su propio teléfono.
    const optOut = await applyOptOut(prisma, {
      subscriptionId: subscription.id,
      clientId: connection.clientId,
      from: body.data.from,
      text: messageText,
    });

    if (optOut.status === 'suppressed') {
      // Una sola confirmación, y solo la primera vez: quien insiste con
      // un segundo "BAJA" ya está dado de baja, y contestarle otra vez
      // es exactamente el mensaje de más que pidió no recibir.
      //
      // Va por mensaje libre y no por plantilla porque acaba de
      // escribirnos: su ventana de 24 horas está abierta. Mismo
      // razonamiento que el acuse de la devolución de llamada, de ahí
      // que reutilice su función de envío — que es genérica pese al
      // nombre.
      if (!optOut.alreadySuppressed) {
        await sendCallbackReply(prisma, {
          clientId: connection.clientId,
          to: body.data.from,
          text: OPT_OUT_CONFIRMATION,
        });
      }
      return NextResponse.json({ handled: true, outcome: optOut });
    }

    const callback = await applyCallbackReply(prisma, {
      subscriptionId: subscription.id,
      from: body.data.from,
      text: messageText,
    });

    if (callback.status === 'ignored') {
      // No tenía ninguna oferta abierta: esto era conversación normal.
      return NextResponse.json({ handled: false, reason: 'not_owner' });
    }

    // El acuse va por mensaje libre, no por plantilla: acaba de
    // escribirnos, así que la ventana de 24 horas está abierta. Si falla,
    // la devolución ya quedó apuntada de todos modos.
    const text = callbackReplyText(callback, businessNameOf(subscription));
    if (text) {
      await sendCallbackReply(prisma, { clientId: connection.clientId, to: body.data.from, text });
    }

    return NextResponse.json({ handled: true, outcome: callback });
  }

  // Fase 2b — "SÍ" a la tarjeta de confirmación de una nota de voz.
  //
  // Va ANTES del resumen diario pero solo actúa si hay un borrador vivo:
  // resolveDraftWithReply devuelve `no_draft` en cuanto no lo hay, y
  // entonces esto sigue su camino. No puede tragarse una respuesta al
  // resumen, que además son números y no un "sí".
  //
  // Si fuera después, un "sí" caería primero en applyDigestReply, que lo
  // trataría como una selección ilegible y le contestaría "no entendí tu
  // respuesta" — a alguien que acababa de contestar exactamente lo que se
  // le había pedido.
  const draftReply = await resolveDraftWithReply(prisma, {
    subscriptionId: subscription.id,
    text: messageText,
  });
  if (draftReply.status !== 'no_draft') {
    await sendCallbackReply(prisma, {
      clientId: connection.clientId,
      to: body.data.from,
      text: draftReply.reply,
    });
    return NextResponse.json({ handled: true, outcome: draftReply });
  }

  const outcome = await applyDigestReply(prisma, {
    subscriptionId: subscription.id,
    text: messageText,
  });

  if (outcome.status === 'ignored' && outcome.reason === 'no_open_digest') {
    // No digest to answer means this really was ordinary conversation.
    return NextResponse.json({ handled: false, reason: 'no_open_digest' });
  }

  return NextResponse.json({ handled: true, outcome });
}
