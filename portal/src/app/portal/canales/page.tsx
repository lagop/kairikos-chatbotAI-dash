import type { Metadata } from 'next';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getAllowedChannelsForClient } from '@/lib/channel-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { TelegramChannelCard, type TelegramConnectionSummary } from '@/components/portal/TelegramChannelCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Canales · Portal Kairikos',
  description: 'Conecta tu chatbot a los canales por los que tus clientes te contactan.',
  alternates: { canonical: '/portal/canales' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP: conexión de canales — Fase 2, primera versión de esta página: solo
// la tarjeta de Telegram. Web (el widget) y Meta (WhatsApp/Messenger/
// Instagram) llegan en las Fases 3 y 4, cada uno con su propia tarjeta.
// Subsección de Chatbot en el sidebar (portal-nav.ts), mismo criterio
// que /portal/status y /portal/conversations.
// =============================================================================

export default async function PortalCanalesPage() {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();

  let allowedChannels: string[] = [];
  let telegramConnection: TelegramConnectionSummary | null = null;

  if (isDatabaseConfigured && resolved?.source === 'database') {
    allowedChannels = await getAllowedChannelsForClient(prisma, resolved.clientId);
    const row = await prisma.telegramConnection.findUnique({
      where: { clientId: resolved.clientId },
      select: { status: true, botUsername: true },
    });
    telegramConnection = row ? { status: row.status as TelegramConnectionSummary['status'], botUsername: row.botUsername } : null;
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Canales"
        description="Conecta tu chatbot a los canales por los que tus clientes te contactan."
      />
      <TelegramChannelCard connection={telegramConnection} allowed={allowedChannels.includes('telegram')} />
    </div>
  );
}
