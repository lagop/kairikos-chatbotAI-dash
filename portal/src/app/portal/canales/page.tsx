import type { Metadata } from 'next';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getAllowedChannelsForClient } from '@/lib/channel-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { TelegramChannelCard, type TelegramConnectionSummary } from '@/components/portal/TelegramChannelCard';
import { MetaChannelCard, type MetaConnectionSummary } from '@/components/portal/MetaChannelCard';
import { WebChannelCard, type WebEmbedSummary } from '@/components/portal/WebChannelCard';
import { resolveActiveMetaCredentials } from '@/lib/meta-credentials';
import { resolvePortalChatbot, chatbotParamFor, type PortalChatbotSelection } from '@/lib/portal-chatbot';
import { ChatbotPicker } from '@/components/portal/ChatbotPicker';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Canales',
  description: 'Conecta tu chatbot a los canales por los que tus clientes te contactan.',
  alternates: { canonical: '/portal/canales' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP: conexión de canales — Fase 3 agrega la tarjeta de Meta (WhatsApp/
// Messenger/Instagram) junto a la de Telegram (Fase 2). Fase 4 agrega
// Web (el widget). Subsección de Chatbot en el sidebar
// (portal-nav.ts), mismo criterio que /portal/status y
// /portal/conversations.
// =============================================================================

export default async function PortalCanalesPage({
  searchParams,
}: {
  searchParams: { clientProductId?: string };
}) {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  let selection: PortalChatbotSelection = { chatbots: [], selected: null };

  let allowedChannels: string[] = [];
  let telegramConnection: TelegramConnectionSummary | null = null;
  let metaConnections: MetaConnectionSummary[] = [];
  let webEmbed: WebEmbedSummary | null = null;

  if (isDatabaseConfigured && resolved?.source === 'database') {
    // Fase 4 multi-instancia — cada chatbot tiene sus canales: su bot de
    // Telegram, su widget, sus números de Meta, y su tarifa decide cuáles
    // puede usar.
    selection = await resolvePortalChatbot(prisma, resolved.clientId, searchParams.clientProductId);
    const chatbotId = selection.selected?.clientProductId ?? null;
    const several = selection.chatbots.length > 1;
    allowedChannels = await getAllowedChannelsForClient(prisma, resolved.clientId, chatbotId);
    const [telegramRow, metaRows, webRow] = await Promise.all([
      chatbotId
        ? prisma.telegramConnection.findUnique({
            where: { clientProductId: chatbotId },
            select: { status: true, botUsername: true, lastSyncError: true },
          })
        : null,
      prisma.metaChannelConnection.findMany({
        // Con un chatbot, todas las del cliente, como siempre. Con varios,
        // las de éste más las que aún no tienen dueño (conectadas antes de
        // la conversión): no pueden aparecer en ningún otro sitio, y
        // esconderlas dejaría un número conectado que nadie puede
        // desconectar.
        where: several
          ? { clientId: resolved.clientId, OR: [{ clientProductId: chatbotId }, { clientProductId: null }] }
          : { clientId: resolved.clientId },
        select: { id: true, channel: true, externalId: true, label: true, status: true },
        orderBy: { connectedAt: 'asc' },
      }),
      chatbotId
        ? prisma.chatWebEmbed.findFirst({
            where: { clientId: resolved.clientId, clientProductId: chatbotId },
            select: { publicToken: true, status: true, primaryColor: true, position: true },
          })
        : null,
    ]);
    telegramConnection = telegramRow
      ? {
          status: telegramRow.status as TelegramConnectionSummary['status'],
          botUsername: telegramRow.botUsername,
          lastSyncError: telegramRow.lastSyncError,
        }
      : null;
    metaConnections = metaRows.map((row) => ({
      id: row.id,
      channel: row.channel as MetaConnectionSummary['channel'],
      externalId: row.externalId,
      label: row.label,
      status: row.status as MetaConnectionSummary['status'],
    }));
    webEmbed = webRow
      ? {
          publicToken: webRow.publicToken,
          status: webRow.status as WebEmbedSummary['status'],
          primaryColor: webRow.primaryColor,
          position: webRow.position as WebEmbedSummary['position'],
        }
      : null;
  }

  const metaCreds = await resolveActiveMetaCredentials();
  const chatbotParam = chatbotParamFor(selection);
  const chatbotKey = selection.selected?.clientProductId ?? 'none';

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Canales"
        description="Conecta tu chatbot a los canales por los que tus clientes te contactan."
      />
      <ChatbotPicker
        chatbots={selection.chatbots}
        selectedId={selection.selected?.clientProductId ?? null}
        basePath="/portal/canales"
        description="Cada chatbot tiene sus propios canales: lo que conectes aquí responde con el que tienes seleccionado."
      />
      {/* key por chatbot: cambiar de chatbot es una navegación suave, y sin
          esto las tarjetas conservarían el estado (color, token a medio
          escribir) del chatbot anterior. */}
      <WebChannelCard
        key={`web-${chatbotKey}`}
        embed={webEmbed}
        allowed={allowedChannels.includes('web')}
        clientProductId={chatbotParam}
      />
      <TelegramChannelCard
        key={`telegram-${chatbotKey}`}
        connection={telegramConnection}
        allowed={allowedChannels.includes('telegram')}
        clientProductId={chatbotParam}
      />
      <MetaChannelCard
        key={`meta-${chatbotKey}`}
        clientProductId={chatbotParam}
        metaAppId={metaCreds?.appId ?? null}
        metaConfigId={metaCreds?.configId ?? null}
        connections={metaConnections}
        allowedChannels={allowedChannels}
      />
    </div>
  );
}
