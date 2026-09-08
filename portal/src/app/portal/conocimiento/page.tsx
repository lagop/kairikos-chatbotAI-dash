import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { ChatbotKnowledgeCard, type KnowledgeDocumentRow } from '@/components/portal/ChatbotKnowledgeCard';
import { MAX_DOCUMENTS_PER_CLIENT } from '@/lib/chatbot-knowledge';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Base de conocimiento',
  robots: { index: false, follow: false },
};

// =============================================================================
// Fase 3 — la base de conocimiento del chatbot.
//
// Página propia y no un paso más del wizard, por la misma razón que la
// tarjeta de cualificación de leads: el wizard carga con aprobación por
// operador, visibilidad por tarifa y versionado, y aquí nada de eso hace
// falta — el cliente añade material suyo y su bot lo usa, sin que nadie
// tenga que revisarlo. Cuelga de la sección Chatbot en la navegación.
// =============================================================================

export default async function ChatbotKnowledgePage() {
  await requirePortalSession();

  if (!isDatabaseConfigured) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Chatbot" title="Base de conocimiento" description="Lo que tu bot sabe de tu negocio." />
        <EmptyState
          title="No disponible ahora mismo"
          description="Vuelve a intentarlo en unos minutos."
        />
      </div>
    );
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Chatbot" title="Base de conocimiento" description="Lo que tu bot sabe de tu negocio." />
        <EmptyState title="No disponible ahora mismo" description="Vuelve a intentarlo en unos minutos." />
      </div>
    );
  }

  const hasChatbot = await isProductContracted(prisma, resolved.clientId, 'chatbot');
  if (!hasChatbot) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Chatbot" title="Base de conocimiento" description="Lo que tu bot sabe de tu negocio." />
        <EmptyState
          title="Necesitas el chatbot"
          description="Esta pantalla configura lo que responde tu asistente. Puedes contratarlo desde la página de productos."
        />
        <Link href="/portal/productos" className="text-sm text-kairikos-accent2 hover:underline">
          Ver productos →
        </Link>
      </div>
    );
  }

  const documents = await prisma.chatbotKnowledgeDocument.findMany({
    where: { clientId: resolved.clientId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      source: true,
      title: true,
      sourceUrl: true,
      status: true,
      error: true,
      charCount: true,
      crawledAt: true,
      createdAt: true,
      _count: { select: { chunks: true } },
    },
  });

  const rows: KnowledgeDocumentRow[] = documents.map((doc) => ({
    id: doc.id,
    source: doc.source,
    title: doc.title,
    sourceUrl: doc.sourceUrl,
    status: doc.status,
    error: doc.error,
    charCount: doc.charCount,
    chunks: doc._count.chunks,
    crawledAt: doc.crawledAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Base de conocimiento"
        description="Lo que tu bot sabe de tu negocio, además de las preguntas frecuentes."
      />
      <ChatbotKnowledgeCard documents={rows} limit={MAX_DOCUMENTS_PER_CLIENT} />
    </div>
  );
}
