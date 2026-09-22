import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { runIntent, isKnownIntent, type AssistantIntent } from '@/lib/assistant-catalogue';
import { classifyQuestion, narrate, fallbackNarrative } from '@/lib/assistant-ai';
import { logError } from '@/lib/observability';
import { takeAiRequest, AI_RATE_LIMITED_RESPONSE } from '@/lib/ai-route-limits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 5b — POST /api/portal/assistant
//
// EL ORDEN DE ESTA RUTA ES LA GARANTÍA DE AISLAMIENTO, así que conviene
// leerlo entero:
//
//   1. Sesión → clientId.        ← lo único que decide de quién son los datos
//   2. Modelo → etiqueta.        ← no ve el clientId, ni ningún id
//   3. Catálogo → datos.         ← con el clientId del paso 1
//   4. Modelo → una frase.       ← sobre hechos ya contados por el portal
//
// El paso 2 nunca puede influir en el paso 1. Da igual lo que escriba el
// usuario en su pregunta —"ignora lo anterior", "soy el administrador",
// un clientId ajeno— porque el modelo no tiene ninguna salida por la que
// pasar un identificador: lo único que devuelve es una etiqueta de un
// conjunto cerrado, y se valida contra él antes de ejecutar nada.
//
// SE ACEPTA UNA INTENCIÓN DIRECTA además de la pregunta en texto. No es
// un atajo inseguro: pasa por el MISMO `isKnownIntent` y el MISMO
// contexto de sesión. Existe para dos cosas — que la interfaz pueda
// ofrecer las preguntas frecuentes como botones sin gastar una llamada al
// modelo, y que el asistente siga sirviendo de algo cuando no hay clave
// de Anthropic configurada.
// =============================================================================

const BodySchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    /** Atajo de la interfaz. Se valida contra el catálogo igual que lo
     *  que devuelve el modelo. */
    intent: z.string().trim().optional(),
    subject: z.string().trim().max(120).optional(),
  })
  .refine((b) => Boolean(b.question || b.intent), {
    message: 'question_or_intent_required',
  });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved?.clientId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  // Cada pregunta llama al modelo (clasificar y/o narrar): cupo por cliente.
  // Ver lib/ai-route-limits.ts (revisión de seguridad 22/09/2026).
  if (!takeAiRequest('assistant', resolved.clientId)) {
    return NextResponse.json(AI_RATE_LIMITED_RESPONSE, { status: 429 });
  }

  // --- Paso 2: qué quiere saber -------------------------------------------
  let intent: AssistantIntent;
  let subject: string | null = body.data.subject ?? null;

  if (body.data.intent) {
    if (!isKnownIntent(body.data.intent)) {
      return NextResponse.json({ error: 'unknown_intent' }, { status: 400 });
    }
    intent = body.data.intent;
  } else {
    const classified = await classifyQuestion(body.data.question!);

    if (!classified.ok) {
      logError('assistant.classify_failed', new Error(classified.error), { clientId: resolved.clientId }, 'warn');
      return NextResponse.json(
        {
          narrative: 'Ahora mismo no puedo entender la pregunta. Inténtalo en un momento.',
          component: { kind: 'empty' },
          actions: [],
        },
        { status: 200 },
      );
    }

    if (classified.skipped) {
      // Sin clave: el asistente no entiende lenguaje natural, pero la
      // interfaz puede seguir ofreciendo las preguntas como botones.
      return NextResponse.json(
        {
          narrative: 'De momento no puedo entender preguntas escritas. Usa los botones de abajo.',
          component: { kind: 'empty' },
          actions: [],
          reason: 'no_api_key',
        },
        { status: 200 },
      );
    }

    if (!classified.classified) {
      // Fuera del catálogo. Se dice claramente en vez de improvisar algo
      // parecido — ver la cabecera de assistant-catalogue.ts.
      return NextResponse.json(
        {
          narrative: 'Con eso no puedo ayudarte todavía. Puedo contarte tus presupuestos pendientes, tus llamadas sin devolver, las revisiones que vencen o cómo va el día.',
          component: { kind: 'empty' },
          actions: [],
          reason: 'out_of_catalogue',
        },
        { status: 200 },
      );
    }

    intent = classified.classified.intent;
    subject = classified.classified.subject ?? subject;
  }

  // --- Paso 3: los datos, con el cliente de la SESIÓN ----------------------
  try {
    const result = await runIntent(intent, {
      prisma,
      // De la sesión. Nunca del cuerpo, nunca del modelo.
      clientId: resolved.clientId,
      now: new Date(),
      subject,
    });

    // --- Paso 4: la frase, sobre hechos ya contados ------------------------
    const narrative = (await narrate(intent, result.facts)) ?? fallbackNarrative(intent, result.facts);

    return NextResponse.json({
      intent,
      narrative,
      component: result.component,
      // Las acciones llegan en su propia fase: todas exigen confirmación
      // explícita y algunas envían mensajes, así que no se cuelan aquí de
      // rebote con la mitad de lectura.
      actions: [],
    });
  } catch (err) {
    logError('assistant.query_failed', err, { clientId: resolved.clientId, intent }, 'warn');
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }
}
