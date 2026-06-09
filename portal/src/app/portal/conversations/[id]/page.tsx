import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { getConversation } from '@/lib/portal-data';
import { requirePortalSession } from '@/lib/session';

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

export default async function ConversationDetailPage({ params }: PageProps) {
  const session = await requirePortalSession();
  const conversation = await getConversation(session.accessToken ?? '', params.id);
  if (!conversation) notFound();

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
      <section
        className="card"
        aria-label="Transcripción"
        data-testid="conversation-transcript"
      >
        <ol className="space-y-4">
          {conversation.messages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <li
                key={m.id}
                className={`flex flex-col ${isUser ? 'items-start' : 'items-start sm:pl-6'}`}
              >
                <div className="flex items-center gap-2 text-xs text-kairikos-muted">
                  <span className={isUser ? 'pill-muted' : 'pill-success'}>
                    {isUser ? 'Cliente' : 'Asistente'}
                  </span>
                  <time dateTime={m.at}>{TIME_FMT.format(new Date(m.at))}</time>
                </div>
                <p
                  className={`mt-1.5 max-w-2xl rounded-2xl px-4 py-2.5 text-sm ${
                    isUser
                      ? 'bg-kairikos-surface2 text-kairikos-text'
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
