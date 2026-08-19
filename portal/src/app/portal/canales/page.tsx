import type { Metadata } from 'next';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getAllowedChannelsForClient } from '@/lib/channel-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { TelegramChannelCard, type TelegramConnectionSummary } from '@/components/portal/TelegramChannelCard';
import { MetaChannelCard, type MetaConnectionSummary } from '@/components/portal/MetaChannelCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Canales · Portal Kairikos',
  description: 'Conecta tu chatbot a los canales por los que tus clientes te contactan.',
  alternates: { canonical: '/portal/canales' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP: conexión de canales — Fase 3 agrega la tarjeta de Meta (WhatsApp/
// Messenger/Instagram) junto a la de Telegram (Fase 2). Web (el widget)
// llega en la Fase 4. Subsección de Chatbot en el sidebar
// (portal-nav.ts), mismo criterio que /portal/status y
// /portal/conversations.
// =============================================================================

export default async function PortalCanalesPage() {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();

  let allowedChannels: string[] = [];
  let telegramConnection: TelegramConnectionSummary | null = null;
  let metaConnections: MetaConnectionSummary[] = [];

  if (isDatabaseConfigured && resolved?.source === 'database') {
    allowedChannels = await getAllowedChannelsForClient(prisma, resolved.clientId);
    const [telegramRow, metaRows] = await Promise.all([
      prisma.telegramConnection.findUnique({
        where: { clientId: resolved.clientId },
        select: { status: true, botUsername: true },
      }),
      prisma.metaChannelConnection.findMany({
        where: { clientId: resolved.clientId },
        select: { id: true, channel: true, externalId: true, label: true, status: true },
        orderBy: { connectedAt: 'asc' },
      }),
    ]);
    telegramConnection = telegramRow
      ? { status: telegramRow.status as TelegramConnectionSummary['status'], botUsername: telegramRow.botUsername }
      : null;
    metaConnections = metaRows.map((row) => ({
      id: row.id,
      channel: row.channel as MetaConnectionSummary['channel'],
      externalId: row.externalId,
      label: row.label,
      status: row.status as MetaConnectionSummary['status'],
    }));
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Canales"
        description="Conecta tu chatbot a los canales por los que tus clientes te contactan."
      />
      <TelegramChannelCard connection={telegramConnection} allowed={allowedChannels.includes('telegram')} />
      <MetaChannelCard
        metaAppId={process.env.META_APP_ID ?? null}
        metaConfigId={process.env.META_CONFIG_ID ?? null}
        connections={metaConnections}
        allowedChannels={allowedChannels}
      />
    </div>
  );
}
