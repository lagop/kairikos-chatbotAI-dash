import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { listConversations } from '@/lib/portal-data';
import { assertSameClient, requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isProductContracted } from '@/lib/client-product-access';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { ConversationDigestsPanel, type ConversationDigestSummary, type ConversationDigestScheduleConfig } from '@/components/portal/ConversationDigestsPanel';

export const metadata: Metadata = {
  title: 'Conversaciones',
  description: 'Listado de las últimas conversaciones atendidas por tu chatbot Kairikos.',
  alternates: { canonical: '/portal/conversations' },
  robots: { index: false, follow: false },
};

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  web: 'Web',
  instagram: 'Instagram',
  other: 'Otro',
};

const OUTCOME_LABEL: Record<string, string> = {
  resolved: 'Resuelta',
  escalated: 'Derivada',
  abandoned: 'Abandonada',
};

const OUTCOME_PILL: Record<string, string> = {
  resolved: 'pill-success',
  escalated: 'pill-warning',
  abandoned: 'pill-muted',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const DURATION_FMT = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

function formatDuration(seconds: number) {
  if (seconds < 60) return `${DURATION_FMT.format(seconds)} s`;
  return `${DURATION_FMT.format(seconds / 60)} min`;
}

const PAGE_SIZE = 50;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: { page?: string; client?: string };
}) {
  const session = await requirePortalSession();
  assertSameClient(session, searchParams.client ?? null);
  const conversations = await listConversations(session.accessToken ?? '');
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = conversations.slice(start, start + PAGE_SIZE);
  const hasNext = start + PAGE_SIZE < conversations.length;

  // Canales Fase 7 — Resúmenes periódicos. A diferencia del listado de
  // arriba (que pasa por portalFetch/listConversations), esto lee
  // Prisma directo, mismo patrón que /portal/resenas — ConversationDigest
  // es un modelo nuevo sin ningún path de proxy existente que reutilizar.
  const resolved = isDatabaseConfigured ? await resolveClientFromSession() : null;
  const hasChatbot = resolved && resolved.source === 'database'
    ? await isProductContracted(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE)
    : false;

  let digestSummaries: ConversationDigestSummary[] = [];
  let scheduleConfig: ConversationDigestScheduleConfig = {
    enabled: false,
    preset: 'morning_noon_evening',
    intervalHours: null,
    timezone: 'Europe/Madrid',
    lastGeneratedAt: null,
  };

  if (hasChatbot && resolved) {
    const [digests, schedule] = await Promise.all([
      prisma.conversationDigest.findMany({
        where: { clientId: resolved.clientId },
        orderBy: { windowEnd: 'desc' },
        take: 20,
      }),
      prisma.conversationDigestSchedule.findUnique({ where: { clientId: resolved.clientId } }),
    ]);
    digestSummaries = digests.map((d) => ({
      id: d.id,
      windowStart: d.windowStart.toISOString(),
      windowEnd: d.windowEnd.toISOString(),
      generatedAt: d.generatedAt.toISOString(),
      totalConversations: d.totalConversations,
      escalatedCount: d.escalatedCount,
      fallbackCount: d.fallbackCount,
      summaryText: d.summaryText,
      highlights: Array.isArray(d.highlights) ? (d.highlights as unknown[]).filter((h): h is string => typeof h === 'string') : [],
    }));
    if (schedule) {
      scheduleConfig = {
        enabled: schedule.enabled,
        preset: schedule.preset as ConversationDigestScheduleConfig['preset'],
        intervalHours: schedule.intervalHours,
        timezone: schedule.timezone,
        lastGeneratedAt: schedule.lastGeneratedAt?.toISOString() ?? null,
      };
    }
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Conversaciones"
        title="Últimas conversaciones"
        description="Las 50 conversaciones más recientes gestionadas por tu chatbot. Sólo lectura."
      />

      {conversations.length === 0 ? (
        <EmptyState
          title="Aún no hay conversaciones"
          description="Cuando tu chatbot atienda la primera conversación, la verás aquí."
        />
      ) : (
        <section
          className="card overflow-hidden p-0"
          aria-label="Listado de conversaciones"
          data-testid="conversation-list"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-kairikos-surface2 text-left text-xs uppercase tracking-wider text-kairikos-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">Fecha</th>
                  <th scope="col" className="px-4 py-3">Canal</th>
                  <th scope="col" className="px-4 py-3">Duración</th>
                  <th scope="col" className="px-4 py-3">Resultado</th>
                  <th scope="col" className="px-4 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-kairikos-border/60"
                    data-testid="conversation-item"
                    data-outcome={c.outcome}
                  >
                    <td className="px-4 py-3 align-middle">{DATE_FMT.format(new Date(c.startedAt))}</td>
                    <td
                      className="px-4 py-3 align-middle"
                      data-testid="conversation-channel"
                    >
                      {CHANNEL_LABEL[c.channel] ?? c.channel}
                    </td>
                    <td
                      className="px-4 py-3 align-middle"
                      data-testid="conversation-duration"
                    >
                      {formatDuration(c.durationSeconds)}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <span
                        className={OUTCOME_PILL[c.outcome] ?? 'pill-muted'}
                        data-testid="conversation-outcome"
                      >
                        {c.outcome === 'escalated' ? (
                          <span data-testid="escalated-badge">{OUTCOME_LABEL[c.outcome] ?? c.outcome}</span>
                        ) : (
                          (OUTCOME_LABEL[c.outcome] ?? c.outcome)
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right align-middle">
                      <Link
                        href={`/portal/conversations/${c.id}`}
                        className="text-kairikos-accent2 hover:underline"
                      >
                        Ver detalle
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav
            className="flex items-center justify-between border-t border-kairikos-border/60 px-4 py-3 text-sm"
            data-testid="pagination"
            aria-label="Paginación de conversaciones"
          >
            <p className="text-xs text-kairikos-muted">
              Mostrando {start + 1}–{start + pageItems.length} de {conversations.length}
            </p>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={`/portal/conversations?page=${page - 1}`}
                  className="btn-ghost"
                  data-testid="pagination-prev"
                >
                  ← Anterior
                </Link>
              ) : null}
              {hasNext ? (
                <Link
                  href={`/portal/conversations?page=${page + 1}`}
                  className="btn-ghost"
                  data-testid="pagination-next"
                >
                  Siguiente →
                </Link>
              ) : null}
            </div>
          </nav>
        </section>
      )}

      {hasChatbot ? (
        <div className="space-y-4">
          <PageHeading
            eyebrow="Resúmenes"
            title="Resúmenes periódicos"
            description="Un resumen de la actividad de tu chatbot, generado con IA, en el horario que elijas."
          />
          <ConversationDigestsPanel digests={digestSummaries} schedule={scheduleConfig} />
        </div>
      ) : null}
    </div>
  );
}
