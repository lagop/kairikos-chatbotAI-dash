import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { CALLER_LANGUAGES, parseCallerLanguages, type CallerLanguage } from './recall-caller-language';

// =============================================================================
// 15/11/2026 — el operador elige en qué idiomas se escribe a quien llama a un
// cliente (ver recall-caller-language.ts).
//
// Lo cambia el operador y no el cliente a propósito: activar un idioma manda
// tres plantillas a la revisión de Meta en la cuenta del cliente (el barrido
// ensureRecallTemplatesSubmitted lo hace en el ciclo siguiente). Es una
// decisión del alta, como las demás plantillas, no un ajuste de su panel.
//
// Desactivar un idioma NO borra nada en Meta: las plantillas aprobadas se
// quedan allí sin usarse, y volver a activarlo no las vuelve a enviar.
// =============================================================================

export type SetCallerLanguagesResult =
  | { ok: true; callerLanguages: CallerLanguage[]; changed: boolean }
  | { ok: false; error: 'not_found' | 'invalid_language' };

export async function setCallerLanguages(
  prisma: PrismaClient,
  input: {
    subscriptionId: string;
    languages: readonly string[];
    actor: { operatorId: string; email: string | null };
  },
): Promise<SetCallerLanguagesResult> {
  // Un código que no existe es un error del panel, no algo que tragarse en
  // silencio: el operador creería haber activado un idioma que no está.
  const unknown = input.languages.filter((l) => !(CALLER_LANGUAGES as readonly string[]).includes(l));
  if (unknown.length > 0) return { ok: false, error: 'invalid_language' };

  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: input.subscriptionId },
    select: { id: true, clientId: true, callerLanguages: true },
  });
  if (!subscription) return { ok: false, error: 'not_found' };

  const before = parseCallerLanguages(subscription.callerLanguages);
  const after = parseCallerLanguages(input.languages);
  const changed = before.join(',') !== after.join(',');
  if (!changed) return { ok: true, callerLanguages: after, changed: false };

  await prisma.recallSubscription.update({
    where: { id: subscription.id },
    data: { callerLanguages: after },
    select: { id: true },
  });

  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: subscription.id,
        clientId: subscription.clientId,
        action: 'caller_languages_changed',
        before: { callerLanguages: before },
        after: { callerLanguages: after },
        actorType: 'operator',
        actorOperatorId: input.actor.operatorId,
        actorEmail: input.actor.email,
      },
    })
    // El cambio ya está hecho: un fallo del registro no lo deshace.
    .catch(() => null);

  return { ok: true, callerLanguages: after, changed: true };
}
