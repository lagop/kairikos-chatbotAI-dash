import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { getConversation } from '@/lib/portal-data';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { HandoffReplyPanel } from '@/components/portal/HandoffReplyPanel';
import { handoffState, isHandoffChannel, type HandoffState } from '@/lib/chatbot-handoff';

interface PageProps {
  params: { id: string };
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

const TIME_FMT = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

const OUTCOME_LABEL: Record<string, string> = {
  resolved: 'Resuelta',
  escalated: 'Derivada',
  abandoned: 'Abandonada',
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: `Conversación ${params.id}`,
    description: 'Detalle y transcripción de la conversación con tu chatbot Kairikos.',
    alternates: { canonical: `/portal/conversations/${params.id}` },
    robots: { index: false, follow: false },
  };
}

/** Fase 3 — los turnos escritos por una persona del negocio llevan
 *  `by: 'agent'` en el transcript (ver chatbot-handoff.ts). El lector de
 *  turnos del motor lo ignora, pero aquí sí importa: quien lee la
 *  conversación tiene que poder distinguir lo que dijo el bot de lo que
 *  dijo su compañero. */
function agentTurnTimes(transcript: unknown): Set<string> {
  const times = new Set<string>();
  if (!Array.isArray(transcript)) return times;
  for (const entry of transcript) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { by, at } = entry as Record<string, unknown>;
    if (by === 'agent' && typeof at === 'string') times.add(at);
  }
  return times;
}

export default async function ConversationDetailPage({ params }: PageProps) {
  const session = await requirePortalSession();
  const conversation = await getConversation(session.accessToken ?? '', params.id);
  if (!conversation) notFound();

  // Fase 3 — el estado del traspaso no pasa por getConversation (que aún
  // sirve al camino heredado de portalFetch/mocks), así que se lee aquí
  // directo. Sin base de datos, la pantalla sigue siendo la de siempre:
  // transcripción y nada más.
  const resolved = isDatabaseConfigured ? await resolveClientFromSession() : null;
  const handoffRow =
    resolved && resolved.source === 'database'
      ? await prisma.chatbotConversation.findFirst({
          where: { id: params.id, clientId: resolved.clientId },
          select: {
            channel: true,
            transcript: true,
            handoffRequestedAt: true,
            handoffTakenAt: true,
            handoffTakenBy: true,
            handoffClosedAt: true,
          },
        })
      : null;

  const state: HandoffState | null = handoffRow ? handoffState(handoffRow) : null;
  const agentTimes = agentTurnTimes(handoffRow?.transcript);

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/portal/conversations" className="hover:text-kairikos-text">
          ← Volver a conversaciones
        </Link>
      </div>
      <PageHeading
        eyebrow="Conversación"
        title={DATE_FMT.format(new Date(conversation.startedAt))}
        description={`Canal: ${conversation.channel} · Resultado: ${OUTCOME_LABEL[conversation.outcome] ?? conversation.outcome}`}
      />

      {handoffRow && state !== null ? (
        <HandoffReplyPanel
          conversationId={params.id}
          state={state}
          takenBy={handoffRow.handoffTakenBy}
          canSend={isHandoffChannel(handoffRow.channel)}
          channel={handoffRow.channel}
        />
      ) : null}

      <section
        className="card"
        aria-label="Transcripción"
        data-testid="conversation-transcript"
      >
        <ol className="space-y-4">
          {conversation.messages.map((m) => {
            const isUser = m.role === 'user';
            const isAgent = !isUser && agentTimes.has(m.at);
            return (
              <li
                key={m.id}
                className={`flex flex-col ${isUser ? 'items-start' : 'items-start sm:pl-6'}`}
                data-testid={isAgent ? 'turn-agent' : isUser ? 'turn-user' : 'turn-bot'}
              >
                <div className="flex items-center gap-2 text-xs text-kairikos-muted">
                  <span className={isUser ? 'pill-muted' : isAgent ? 'pill-warning' : 'pill-success'}>
                    {isUser ? 'Cliente' : isAgent ? 'Tu equipo' : 'Asistente'}
                  </span>
                  <time dateTime={m.at}>{TIME_FMT.format(new Date(m.at))}</time>
                </div>
                <p
                  className={`mt-1.5 max-w-2xl rounded-2xl px-4 py-2.5 text-sm ${
                    isUser
                      ? 'bg-kairikos-surface2 text-kairikos-text'
                      : isAgent
                        ? 'bg-kairikos-warning/15 text-kairikos-text'
                        : 'bg-kairikos-accent/15 text-kairikos-text'
                  }`}
                >
                  {m.content}
                </p>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
