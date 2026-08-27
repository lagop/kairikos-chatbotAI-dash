import type { Metadata } from 'next';
import type { Prisma } from '@prisma/client';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { EmptyState } from '@/components/portal/EmptyState';
import { OperatorEditor } from '@/components/portal/OperatorEditor';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_TIMELINE } from '@/lib/portal-data';
import type { OnboardingTimelineRow } from '@/types/portal';
import { MOCK_FLOW_ACTIVITY, MOCK_N8N_EXECUTIONS, type FlowActivityEntry, type N8nExecutionSummary } from '@/lib/flow-health';
import { buildAdminClientChatbotStatus } from '@/lib/chatbot-status';
import { advanceOnboardingMilestone } from './onboarding-actions';
import { ALLOWED_MILESTONES } from './onboarding-constants';
import { PRODUCT_CODES, PRODUCT_CATALOGS, getProductCatalog, type ProductCode } from '@/lib/catalogs';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { ProductAssignment, type AssignableProduct, type ClientProductRow } from '@/components/admin/ProductAssignment';
import { WebQuoteEditor, type WebQuoteData, type WebQuoteInvoiceData } from '@/components/admin/WebQuoteEditor';
import {
  ChannelsOperatorPanel,
  type TelegramConnectionRow,
  type MetaConnectionRow,
  type FailedDeliveryRow,
} from '@/components/admin/ChannelsOperatorPanel';
import { getAllowedChannelsForClient } from '@/lib/channel-access';
import { LeadsSummaryPanel, type LeadSummaryRow } from '@/components/admin/LeadsSummaryPanel';
import { RecallOperatorPanel, type RecallPanelData } from '@/components/admin/RecallOperatorPanel';
import { SeoTechnicalSetupPanel, type SeoProfilePanelData } from '@/components/admin/SeoTechnicalSetupPanel';
import { SeoContentDraftsPanel, type SeoContentDraftData } from '@/components/admin/SeoContentDraftsPanel';
import { isStuck, stuckThresholdDays } from '@/lib/recall';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { clientId: string };
  searchParams: { tab?: string; product?: string };
}

// WP-XX — one entry per 'web' ClientProduct row (see WebProjects fetch
// below). `label` helps the operator tell projects apart at a glance —
// the submitted brief's business name when there is one, else a stable
// fallback by creation order.
interface WebProjectEntry {
  clientProductId: string;
  label: string;
  webQuote: WebQuoteData | null;
  invoice: WebQuoteInvoiceData | null;
}

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

const MILESTONE_LABEL: Record<string, string> = {
  'T+0': 'Bienvenida y acceso al portal',
  'T+3': 'Configuración inicial',
  'T+7': 'Puesta en producción',
  'T+14': 'Revisión y optimización',
};

const MILESTONE_STEP: Record<string, 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return {
    title: `Cliente ${params.clientId.slice(0, 8)} · Operador`,
    description: 'Vista de sólo lectura del portal de un cliente concreto.',
    alternates: { canonical: `/admin/portal/${params.clientId}` },
    robots: { index: false, follow: false },
  };
}

function TabLink({ clientId, current, value, label }: { clientId: string; current: string; value: string; label: string }) {
  const href = value === 'overview' ? `/admin/portal/${clientId}` : `/admin/portal/${clientId}?tab=${value}`;
  const active = current === value;
  return (
    <Link
      href={href}
      className={active ? 'btn-primary' : 'btn-ghost'}
      data-testid={`client-tab-${value}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

function ProductTabLink({
  clientId,
  currentTab,
  currentProduct,
  value,
  label,
}: {
  clientId: string;
  currentTab: string;
  currentProduct: string;
  value: string;
  label: string;
}) {
  const sp = new URLSearchParams();
  if (currentTab !== 'overview') sp.set('tab', currentTab);
  sp.set('product', value);
  const active = currentProduct === value;
  return (
    <Link
      href={`/admin/portal/${clientId}?${sp.toString()}`}
      className={active ? 'btn-primary' : 'btn-ghost'}
      data-testid={`client-product-tab-${value}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

function FlowHistoryTimeline({ entries }: { entries: FlowActivityEntry[] }) {
  if (!entries.length) {
    return (
      <EmptyState
        title="Sin actividad registrada"
        description="Cuando el flujo n8n emita hitos o ejecuciones, aparecerán aquí ordenados en el tiempo."
      />
    );
  }
  return (
    <ol
      data-testid="flow-history-timeline"
      className="relative space-y-5 border-l border-kairikos-border pl-5"
    >
      {entries.map((entry) => {
        const dotClass =
          entry.status === 'success'
            ? 'bg-kairikos-success'
            : entry.status === 'failed'
              ? 'bg-kairikos-danger'
              : 'bg-kairikos-accent';
        const kindLabel =
          entry.kind === 'milestone'
            ? 'Hito'
            : entry.kind === 'n8n_execution'
              ? 'n8n'
              : 'Nota';
        return (
          <li
            key={entry.id}
            data-testid="flow-history-item"
            data-status={entry.status}
            data-kind={entry.kind}
            className="relative"
          >
            <span aria-hidden className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ${dotClass}`} />
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill-muted">{kindLabel}</span>
                <h3 className="text-sm font-semibold">{entry.label}</h3>
                {entry.status === 'failed' ? (
                  <span className="pill-danger" aria-label="Evento fallido">
                    Falló
                  </span>
                ) : entry.status === 'success' ? (
                  <span className="pill-success" aria-label="Evento correcto">
                    OK
                  </span>
                ) : null}
              </div>
              {entry.detail ? <p className="text-sm text-kairikos-muted">{entry.detail}</p> : null}
              <p className="text-xs text-kairikos-muted">{DATE_FORMAT.format(new Date(entry.occurredAt))}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function OnboardingOperatorControls({
  clientId,
  productCode,
  timeline,
  advance,
}: {
  clientId: string;
  productCode: string;
  timeline: OnboardingTimelineRow[];
  advance: (formData: FormData) => Promise<void>;
}) {
  const doneSteps = new Set(
    timeline.filter((row) => row.status === 'done').map((row) => row.step),
  );
  const pendingMilestones = ALLOWED_MILESTONES.filter((m) => {
    const dbMilestone = MILESTONE_TO_DB[m];
    return !doneSteps.has(dbMilestone);
  });
  const firstPending = pendingMilestones[0];

  return (
    <div
      className="mt-5 border-t border-kairikos-border pt-4"
      data-testid="onboarding-operator-controls"
    >
      <p className="mb-3 text-sm text-kairikos-muted">
        Como operador, puedes registrar los hitos del onboarding para que el
        cliente los vea activados en su portal. Esta acción escribe
        directamente en la línea de tiempo del cliente.
      </p>
      {timeline.length === 0 ? (
        firstPending ? (
          <form action={advance}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="productCode" value={productCode} />
            <input type="hidden" name="milestone" value={firstPending} />
            <button
              type="submit"
              className="btn-primary"
              data-testid="onboarding-operator-start"
              data-milestone={firstPending}
            >
              Iniciar onboarding ({firstPending} · {MILESTONE_LABEL[firstPending]})
            </button>
          </form>
        ) : null
      ) : (
        <ul className="flex flex-col gap-2">
          {ALLOWED_MILESTONES.map((m) => {
            const dbMilestone = MILESTONE_TO_DB[m];
            const isDone = doneSteps.has(dbMilestone);
            return (
              <li
                key={m}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2"
                data-testid="onboarding-operator-row"
                data-milestone={m}
                data-done={isDone ? 'true' : 'false'}
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold">
                    {m} · {MILESTONE_LABEL[m]}
                  </span>
                  <span className="text-xs text-kairikos-muted">
                    {isDone
                      ? 'Marcado como completado.'
                      : 'Pendiente de registrar.'}
                  </span>
                </div>
                {isDone ? (
                  <span className="pill-success" data-testid="onboarding-operator-done-pill">
                    Completado
                  </span>
                ) : (
                  <form action={advance}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <input type="hidden" name="productCode" value={productCode} />
                    <input type="hidden" name="milestone" value={m} />
                    <button
                      type="submit"
                      className="btn-ghost"
                      data-testid="onboarding-operator-mark"
                      data-milestone={m}
                    >
                      Marcar como completado
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const MILESTONE_TO_DB: Record<string, OnboardingTimelineRow['step']> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};

export default async function AdminClientDetailPage({ params, searchParams }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/${encodeURIComponent(params.clientId)}`);
  }
  const tab = (searchParams.tab ?? 'overview').toLowerCase() === 'flow' ? 'flow' : 'overview';

  let companyName = 'Cliente';
  let email = '';
  let tier = 'starter';
  let state = 'in-progress';
  let notes: string | null = null;
  let goLiveAt: string | null = null;
  let conversationCount = 0;
  let timeline: OnboardingTimelineRow[] = [];
  let flowHistory: FlowActivityEntry[] = [];
  // KAIA-13744 — when isDatabaseConfigured is true and the real client row
  // resolves, we surface a ChatbotStatusSummary built from the DB (not
  // MOCK_CHATBOT). The 7-day window drives the fallback / escalation rates
  // shown on the card; the page-level total `conversationCount` is also
  // carried so the helper can fall back to it when the 7-day window is
  // not supplied.
  let resolvedClientId: string | null = null;
  let resolvedGoLiveAt: string | null = null;
  let last7DaysCounts = { conversations: 0, fallback: 0, escalation: 0 };
  // WP-24 — most recent intake submission for this client, so the operator
  // can see exactly what the client answered before any wizard editing.
  let latestIntake: { id: string; createdAt: string; payload: Prisma.JsonValue } | null = null;
  // WP-18 — the client's contracted products. `activeProductCodes` drives
  // the product tab bar; `productCode` is the tab currently selected
  // (validated against it below); `clientProducts`/`assignableProducts`
  // feed the assign/retire UI, which needs every ClientProduct row
  // (any status) plus every sellable Product not already active.
  let activeProductCodes: ProductCode[] = [];
  let productCode: ProductCode = CHATBOT_PRODUCT_CODE;
  let clientProducts: ClientProductRow[] = [];
  let assignableProducts: AssignableProduct[] = [];
  // WebQuote Fase 3 — populated only when productCode === 'web', so the
  // custom-quote billing editor(s) can render inside that product's tab.
  // WP-XX — a client can have multiple independent 'web' projects (see
  // ClientProduct's schema comment), so this is now a list: one entry per
  // 'web' ClientProduct row, each rendering its own WebQuoteEditor. The
  // tab bar itself is unchanged — there's still one "web" tab, the
  // multiplicity lives inside it.
  let webProjects: WebProjectEntry[] = [];
  // WP: conexión de canales — Fase 5. Populated only when
  // productCode === CHATBOT_PRODUCT_CODE, so the read-only channels
  // panel (+ manual webhook-delivery retry) renders inside that
  // product's tab, same pattern as WebQuote's editor under 'web'.
  let channelsTelegram: TelegramConnectionRow | null = null;
  let channelsMeta: MetaConnectionRow[] = [];
  let channelsAllowed: string[] = [];
  let channelsFailedDeliveries: FailedDeliveryRow[] = [];
  // Leads Fase 5 — populated only when productCode === 'leads', same
  // pattern as the Canales/WebQuote blocks above.
  let leads: LeadSummaryRow[] = [];
  // Recall Fase 5 — populated only when productCode === 'recall', same
  // three-part pattern as every block above.
  let recall: RecallPanelData | null = null;
  // SEO con IA, Fase A — populated only when productCode === 'seo', same
  // pattern as every block above.
  let seoProfile: SeoProfilePanelData | null = null;
  let seoContentDrafts: SeoContentDraftData[] = [];
  if (isDatabaseConfigured) {
    try {
      const client = await prisma.chatbotClient.findUnique({
        where: { id: params.clientId },
        select: {
          id: true,
          companyName: true,
          name: true,
          email: true,
          tier: true,
          state: true,
          notes: true,
          goLiveAt: true,
        },
      });
      if (client) {
        companyName = client.companyName ?? client.name;
        email = client.email;
        tier = client.tier;
        state = client.state;
        notes = client.notes;
        goLiveAt = client.goLiveAt?.toISOString() ?? null;
        resolvedClientId = client.id;
        resolvedGoLiveAt = goLiveAt;
        // KAIA-13744 — the ChatbotStatusCard needs a real 7-day conversation
        // window. The total `count` is used by the activity loop, and a
        // separate `groupBy` over the last 7 days drives the fallback and
        // escalation rates on the card.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [count, recentGroups, cpRows, allProducts] = await Promise.all([
          prisma.chatbotConversation.count({ where: { clientId: client.id } }),
          prisma.chatbotConversation.groupBy({
            by: ['outcome'],
            where: {
              clientId: client.id,
              startedAt: { gte: sevenDaysAgo },
            },
            _count: { _all: true },
          }),
          prisma.clientProduct.findMany({
            where: { clientId: client.id },
            include: { product: true },
            orderBy: { subscribedAt: 'asc' },
          }),
          prisma.product.findMany({
            where: { isActive: true },
            orderBy: [{ code: 'asc' }, { tier: 'asc' }],
          }),
        ]);
        conversationCount = count;

        // WP-XX — 'web' is excluded from this generic panel entirely (both
        // the assigned list and the assignable dropdown): it's managed
        // exclusively via the quote flow (see the 'web' WebQuoteEditor
        // block below). This panel's "Reactivar" button POSTs {clientId,
        // productId} with no row id — after 'web' became exempt from the
        // one-row-per-client rule, that POST always creates a FRESH row
        // instead of reviving the one the operator clicked, silently
        // orphaning it. Every other product code is unaffected.
        clientProducts = cpRows
          .filter((cp) => cp.product.code !== 'web')
          .map((cp) => ({
            id: cp.id,
            productId: cp.productId,
            code: cp.product.code,
            tier: cp.product.tier,
            name: (isProductCode(cp.product.code) ? PRODUCT_CATALOGS[cp.product.code].label : null) ?? cp.product.name,
            status: cp.status,
            subscribedAt: cp.subscribedAt.toISOString(),
            cancelledAt: cp.cancelledAt?.toISOString() ?? null,
          }));
        assignableProducts = allProducts
          .filter((p) => p.code !== 'web')
          .filter((p) => !cpRows.some((cp) => cp.productId === p.id && cp.status === 'active'))
          .map((p) => ({
            id: p.id,
            code: p.code,
            tier: p.tier,
            name: `${(isProductCode(p.code) ? PRODUCT_CATALOGS[p.code].label : null) ?? p.name} (${p.tier})`,
            priceCents: p.priceCents,
            currency: p.currency,
          }));

        activeProductCodes = Array.from(
          new Set(
            cpRows
              .filter((cp) => cp.status === 'active' || cp.status === 'paused' || cp.status === 'quote_pending')
              .map((cp) => cp.product.code),
          ),
        ).filter(isProductCode);
        const requestedProduct = searchParams.product;
        productCode =
          requestedProduct && isProductCode(requestedProduct) && activeProductCodes.includes(requestedProduct)
            ? requestedProduct
            : activeProductCodes.includes(CHATBOT_PRODUCT_CODE)
              ? CHATBOT_PRODUCT_CODE
              : (activeProductCodes[0] ?? CHATBOT_PRODUCT_CODE);

        if (productCode === 'web') {
          // WP-XX — every 'web' row for this client, not just one (see
          // WebProjectEntry) — cpRows is already ordered subscribedAt
          // asc, so `index` gives a stable fallback label when the
          // project's own brief has no businessName yet.
          const webCps = cpRows.filter((cp) => cp.product.code === 'web');
          webProjects = await Promise.all(
            webCps.map(async (webCp, index) => {
              const [webQuoteRow, brief] = await Promise.all([
                prisma.webQuote.findUnique({ where: { clientProductId: webCp.id } }),
                prisma.webBrief.findUnique({ where: { clientProductId: webCp.id }, select: { businessName: true } }),
              ]);
              let invoice: WebQuoteInvoiceData | null = null;
              if (
                webQuoteRow &&
                ['invoiced', 'invoiced_deposit', 'invoiced_final', 'paid'].includes(webQuoteRow.status)
              ) {
                const invoiceRow = await prisma.invoice.findFirst({
                  where: { clientProductId: webCp.id },
                  orderBy: { createdAt: 'desc' },
                });
                invoice = invoiceRow
                  ? {
                      id: invoiceRow.id,
                      status: invoiceRow.status,
                      hostInvoiceUrl: invoiceRow.hostInvoiceUrl,
                      paymentChannel: invoiceRow.paymentChannel,
                      paymentReference: invoiceRow.paymentReference,
                    }
                  : null;
              }
              return {
                clientProductId: webCp.id,
                label: brief?.businessName || `Proyecto ${index + 1} · desde ${webCp.subscribedAt.toISOString().slice(0, 10)}`,
                webQuote: webQuoteRow
                  ? {
                      id: webQuoteRow.id,
                      status: webQuoteRow.status,
                      amountCents: webQuoteRow.amountCents,
                      depositCents: webQuoteRow.depositCents,
                      currency: webQuoteRow.currency,
                      description: webQuoteRow.description,
                      sentAt: webQuoteRow.sentAt?.toISOString() ?? null,
                      acceptedAt: webQuoteRow.acceptedAt?.toISOString() ?? null,
                      cancelledAt: webQuoteRow.cancelledAt?.toISOString() ?? null,
                    }
                  : null,
                invoice,
              };
            }),
          );
        }

        if (productCode === CHATBOT_PRODUCT_CODE) {
          const [telegramRow, metaRows, allowed, failedRows] = await Promise.all([
            prisma.telegramConnection.findUnique({
              where: { clientId: client.id },
              select: { status: true, botUsername: true },
            }),
            prisma.metaChannelConnection.findMany({
              where: { clientId: client.id },
              select: { id: true, channel: true, externalId: true, label: true, status: true },
              orderBy: { connectedAt: 'asc' },
            }),
            getAllowedChannelsForClient(prisma, client.id),
            prisma.channelWebhookDelivery.findMany({
              where: { clientId: client.id, status: 'failed' },
              select: { id: true, connectionType: true, attempts: true, lastError: true, lastAttemptAt: true },
              orderBy: { lastAttemptAt: 'desc' },
            }),
          ]);
          channelsTelegram = telegramRow
            ? { status: telegramRow.status as TelegramConnectionRow['status'], botUsername: telegramRow.botUsername }
            : null;
          channelsMeta = metaRows.map((row) => ({
            id: row.id,
            channel: row.channel as MetaConnectionRow['channel'],
            externalId: row.externalId,
            label: row.label,
            status: row.status as MetaConnectionRow['status'],
          }));
          channelsAllowed = allowed;
          channelsFailedDeliveries = failedRows.map((row) => ({
            id: row.id,
            connectionType: row.connectionType as FailedDeliveryRow['connectionType'],
            attempts: row.attempts,
            lastError: row.lastError,
            lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
          }));
        }

        if (productCode === 'leads') {
          leads = await prisma.lead.findMany({
            where: { clientId: client.id },
            orderBy: [{ createdAt: 'desc' }],
          });
        }

        if (productCode === 'recall') {
          const subscription = await prisma.recallSubscription.findFirst({
            where: { clientId: client.id },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              createdAt: true,
              contractSignedAt: true,
              metaConnectedAt: true,
              numberAssignedAt: true,
              templatesApprovedAt: true,
              forwardingVerifiedAt: true,
              greetingRecordedAt: true,
              ownerWhatsapp: true,
              virtualNumber: { select: { e164: true } },
              // Bounded: the panel answers "what did the last few callers
              // say", not "give me the whole call history".
              callEvents: {
                orderBy: { startedAt: 'desc' },
                take: 10,
                select: {
                  id: true,
                  startedAt: true,
                  fromNumber: true,
                  withheld: true,
                  outcome: true,
                  transcript: true,
                  recordingDurationSeconds: true,
                  leadId: true,
                  // Fase 9 — whether each of the two messages actually
                  // went out. Without this the panel shows a transcript
                  // and says nothing about whether anyone was told, which
                  // is the first thing an operator is asked.
                  callerNotifyChannel: true,
                  callerNotifyError: true,
                  notifiedCallerAt: true,
                  notifiedOwnerAt: true,
                },
              },
              // Fase 11 — this month's consumption. The pack is flat
              // rate, so this is not a bill: it is how an operator sees
              // that one client stopped consuming like the others.
              usageMonths: {
                orderBy: { localMonth: 'desc' },
                take: 1,
                select: {
                  localMonth: true,
                  calls: true,
                  callSeconds: true,
                  whatsappMessages: true,
                  smsMessages: true,
                  reviewRequests: true,
                  alertedAt: true,
                },
              },
              blockedNumbers: {
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: { id: true, e164: true, reason: true, createdAt: true },
              },
            },
          });
          if (subscription) {
            // Same clock the queue uses: the stamp of the transition that
            // put the row in its current state, never `updatedAt`, which
            // an unrelated edit would reset and thereby hide a stall.
            const since =
              (subscription.status === 'contract_signed' && subscription.contractSignedAt) ||
              (subscription.status === 'meta_connected' && subscription.metaConnectedAt) ||
              (subscription.status === 'number_assigned' && subscription.numberAssignedAt) ||
              ((subscription.status === 'templates_approved' || subscription.status === 'forwarding_pending') &&
                subscription.templatesApprovedAt) ||
              (subscription.status === 'forwarding_verified' && subscription.forwardingVerifiedAt) ||
              subscription.createdAt;
            recall = {
              subscriptionId: subscription.id,
              status: subscription.status,
              since: since.toISOString(),
              stuck: isStuck(subscription.status, since),
              stuckThresholdDays: stuckThresholdDays(subscription.status),
              e164: subscription.virtualNumber?.e164 ?? null,
              hasGreeting: subscription.greetingRecordedAt !== null,
              ownerWhatsapp: subscription.ownerWhatsapp,
              calls: subscription.callEvents.map((call) => ({
                id: call.id,
                startedAt: call.startedAt.toISOString(),
                fromNumber: call.fromNumber,
                withheld: call.withheld,
                outcome: call.outcome,
                transcript: call.transcript,
                recordingDurationSeconds: call.recordingDurationSeconds,
                leadId: call.leadId,
                callerNotifyChannel: call.callerNotifyChannel,
                callerNotifyError: call.callerNotifyError,
                notifiedCallerAt: call.notifiedCallerAt?.toISOString() ?? null,
                notifiedOwnerAt: call.notifiedOwnerAt?.toISOString() ?? null,
              })),
              usage: subscription.usageMonths[0]
                ? {
                    localMonth: subscription.usageMonths[0].localMonth,
                    calls: subscription.usageMonths[0].calls,
                    minutes: Math.round(subscription.usageMonths[0].callSeconds / 60),
                    whatsappMessages: subscription.usageMonths[0].whatsappMessages,
                    smsMessages: subscription.usageMonths[0].smsMessages,
                    reviewRequests: subscription.usageMonths[0].reviewRequests,
                    alerted: subscription.usageMonths[0].alertedAt !== null,
                  }
                : null,
              blockedNumbers: subscription.blockedNumbers.map((row) => ({
                id: row.id,
                e164: row.e164,
                reason: row.reason,
                createdAt: row.createdAt.toISOString(),
              })),
            };
          }
        }

        if (productCode === 'seo') {
          const profile = await prisma.seoProfile.findFirst({
            where: { clientId: client.id },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              businessDescription: true,
              targetAudience: true,
              toneOfVoice: true,
              siteUrl: true,
              cmsType: true,
              wordpressUrl: true,
              wordpressUsername: true,
              wordpressAppPasswordCiphertext: true,
              technicalSetupNotes: true,
              technicalSetupCompletedAt: true,
              status: true,
              lastAuditAt: true,
              lastAuditResult: true,
              lastAuditError: true,
            },
          });
          if (profile) {
            seoProfile = {
              businessDescription: profile.businessDescription,
              targetAudience: profile.targetAudience,
              toneOfVoice: profile.toneOfVoice,
              siteUrl: profile.siteUrl,
              cmsType: profile.cmsType,
              wordpressUrl: profile.wordpressUrl,
              wordpressUsername: profile.wordpressUsername,
              hasAppPassword: profile.wordpressAppPasswordCiphertext !== null,
              technicalSetupNotes: profile.technicalSetupNotes,
              technicalSetupCompletedAt: profile.technicalSetupCompletedAt?.toISOString() ?? null,
              status: profile.status,
              lastAuditAt: profile.lastAuditAt?.toISOString() ?? null,
              lastAuditResult: profile.lastAuditResult as SeoProfilePanelData['lastAuditResult'],
              lastAuditError: profile.lastAuditError,
            };

            const draftRows = await prisma.seoContentDraft.findMany({
              where: { profileId: profile.id },
              orderBy: { requestedAt: 'desc' },
              select: {
                id: true,
                title: true,
                bodyHtml: true,
                targetKeyword: true,
                status: true,
                requestedAt: true,
                generatedAt: true,
                reviewedBy: true,
                reviewedAt: true,
                rejectionReason: true,
              },
            });
            seoContentDrafts = draftRows.map((d) => ({
              id: d.id,
              title: d.title,
              bodyHtml: d.bodyHtml,
              targetKeyword: d.targetKeyword,
              status: d.status,
              requestedAt: d.requestedAt.toISOString(),
              generatedAt: d.generatedAt?.toISOString() ?? null,
              reviewedBy: d.reviewedBy,
              reviewedAt: d.reviewedAt?.toISOString() ?? null,
              rejectionReason: d.rejectionReason,
            }));
          }
        }

        const activities = await prisma.chatbotActivity.findMany({
          where: { clientId: client.id, productCode },
          orderBy: { completedAt: 'asc' },
        });

        const intakeRow = await prisma.intakeSubmission.findFirst({
          where: { clientId: client.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true, payload: true },
        });
        latestIntake = intakeRow
          ? { id: intakeRow.id, createdAt: intakeRow.createdAt.toISOString(), payload: intakeRow.payload }
          : null;
        let sevenDayConversations = 0;
        let sevenDayFallback = 0;
        let sevenDayEscalation = 0;
        for (const group of recentGroups) {
          const n = group._count._all;
          sevenDayConversations += n;
          if (group.outcome === 'fallback') sevenDayFallback += n;
          else if (group.outcome === 'escalated') sevenDayEscalation += n;
        }
        last7DaysCounts = {
          conversations: sevenDayConversations,
          fallback: sevenDayFallback,
          escalation: sevenDayEscalation,
        };
        if (activities.length > 0) {
          timeline = activities.map((a, i, arr) => {
            const isFirstPending = !a.completedAt && arr.findIndex((x) => !x.completedAt) === i;
            return {
              id: a.id,
              step: MILESTONE_STEP[a.milestone] ?? 't_plus_0',
              label: MILESTONE_LABEL[a.milestone] ?? a.milestone,
              description: a.notes ?? '',
              occurredAt: a.completedAt?.toISOString() ?? null,
              status: a.completedAt ? 'done' as const : isFirstPending ? 'current' as const : 'pending' as const,
            };
          });
          flowHistory = activities
            .filter((a) => a.completedAt)
            .map((a) => ({
              id: `fa_db_${a.id}`,
              kind: 'milestone' as const,
              label: `${a.milestone} · ${MILESTONE_LABEL[a.milestone] ?? ''}`.trim(),
              occurredAt: a.completedAt!.toISOString(),
              status: 'success' as const,
              detail: a.notes ?? null,
            }));
        }
      } else {
        notFound();
      }
    } catch (err) {
      // KAIA-14409 — this used to be a bare `catch {}` with a
      // "fall back to mock lookup" comment. With isDatabaseConfigured true
      // there is no mock fallback below (KAIA-13753 gated them all on
      // !isDatabaseConfigured), so a throw here silently rendered the
      // empty-state timeline — indistinguishable from "no rows yet".
      // `notFound()` throws a Next.js control-flow signal, so it must be
      // re-thrown rather than swallowed. All other errors are logged so
      // any future regression is observable in Vercel logs instead of
      // only as a stale UI.
      if (
        err &&
        typeof err === 'object' &&
        'digest' in err &&
        typeof (err as { digest?: unknown }).digest === 'string' &&
        (err as { digest: string }).digest.startsWith('NEXT_')
      ) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error(
        '[admin/portal/[clientId]] client/activity load failed; the ' +
          'onboarding timeline may render empty. This is a DB error, NOT ' +
          'an empty dataset.',
        err,
      );
    }
  }
  // KAIA-13753 hardening (mirrors [clientId]/wizard) — gate every dev-mock
  // fallback on !isDatabaseConfigured. A `companyName === 'Cliente'` /
  // `flowHistory.length === 0` post-DB gate would mask legitimate real
  // states (a tenant with NULL companyName; a fresh tenant with no
  // Activity rows; a tenant with no n8n executions) behind the
  // Acme Corp / Globex Inc fixture. Only `!isDatabaseConfigured`
  // (local `next dev` without DATABASE_URL) surfaces mocks.
  if (!isDatabaseConfigured) {
    const mockMatch = [MOCK_CLIENT, MOCK_SECONDARY_CLIENT].find(
      (m) => m.id === params.clientId,
    );
    if (mockMatch) {
      companyName = mockMatch.companyName;
      email = mockMatch.primaryContactEmail;
      tier = mockMatch.tier;
      state = mockMatch.onboardingStatus;
      goLiveAt = mockMatch.goLiveDate;
    } else {
      notFound();
    }
    flowHistory = MOCK_FLOW_ACTIVITY[params.clientId] ?? [];
    timeline = MOCK_TIMELINE;
    // Dev-mock fixtures predate ClientProduct — they only ever represent
    // the chatbot product, so the tab bar has exactly one (unselectable)
    // tab and the assign/retire UI (which needs a real DB) stays hidden.
    activeProductCodes = [CHATBOT_PRODUCT_CODE];
    productCode = CHATBOT_PRODUCT_CODE;
  }

  // KAIA-13753 hardening — n8n executions: try Prisma first, fall back to
  // dev-mock fixtures only when !isDatabaseConfigured. Mirrors the
  // /admin/portal/flows panel pattern from KAIA-13756.
  let n8nExecutions: N8nExecutionSummary[] = [];
  if (!isDatabaseConfigured) {
    n8nExecutions = MOCK_N8N_EXECUTIONS.filter(
      (e) => e.clientId === params.clientId,
    );
  } else {
    try {
      const dbRows = await prisma.n8nExecution.findMany({
        where: { clientId: params.clientId },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          clientId: true,
          clientName: true,
          workflow: true,
          milestone: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          errorCode: true,
          errorMessage: true,
        },
      });
      n8nExecutions = dbRows.map((e) => ({
        id: e.id,
        clientId: e.clientId ?? '',
        clientName: e.clientName ?? '—',
        workflow: e.workflow,
        milestone: e.milestone,
        status:
          e.status === 'failed' || e.status === 'success' || e.status === 'running'
            ? e.status
            : 'running',
        startedAt: e.startedAt.toISOString(),
        finishedAt: e.finishedAt?.toISOString() ?? null,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[admin/portal/[clientId]] failed to load n8n executions:',
        err,
      );
      n8nExecutions = [];
    }
  }

  const status: 'live' | 'in-progress' = goLiveAt ? 'live' : 'in-progress';

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/clients" className="hover:text-kairikos-text">← Volver al listado</Link>
      </div>
      <PageHeading
        eyebrow="Operador · vista de cliente"
        title={companyName}
        description={`${email} · Plan ${tier} · Vista de sólo lectura`}
        actions={
          <span
            data-testid="operator-readonly-badge"
            className="pill-warning"
          >
            Modo lectura — para editar, baja a la sección Editar
          </span>
        }
      />

      <nav
        aria-label="Pestañas del cliente"
        className="card flex flex-wrap items-center gap-2 p-3"
        data-testid="client-tab-bar"
      >
        <TabLink clientId={params.clientId} current={tab} value="overview" label="Resumen" />
        <TabLink clientId={params.clientId} current={tab} value="flow" label="Flujo" />
      </nav>

      <OperatorEditor
        clientId={params.clientId}
        initial={{
          companyName,
          email,
          tier,
          state,
          goLiveAt,
          notes,
        }}
      />

      {isDatabaseConfigured ? (
        <ProductAssignment clientId={params.clientId} assigned={clientProducts} assignable={assignableProducts} />
      ) : null}

      {activeProductCodes.length > 0 ? (
        <nav
          aria-label="Productos del cliente"
          className="card flex flex-wrap items-center gap-2 p-3"
          data-testid="client-product-tab-bar"
        >
          {activeProductCodes.map((code) => (
            <ProductTabLink
              key={code}
              clientId={params.clientId}
              currentTab={tab}
              currentProduct={productCode}
              value={code}
              label={PRODUCT_CATALOGS[code]?.label ?? code}
            />
          ))}
        </nav>
      ) : null}

      {tab === 'overview' ? (
        <>
          {productCode === CHATBOT_PRODUCT_CODE ? (
            <section className="card" aria-label="Estado del chatbot del cliente">
              <header className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Estado del chatbot</h2>
                <span className={status === 'live' ? 'pill-success' : 'pill-warning'}>
                  {status === 'live' ? 'En producción' : 'En curso'}
                </span>
              </header>
              <ChatbotStatusCard
                summary={buildAdminClientChatbotStatus({
                  isDatabaseConfigured,
                  client:
                    resolvedClientId !== null
                      ? { id: resolvedClientId, goLiveAt: resolvedGoLiveAt }
                      : null,
                  last7DaysCounts,
                  conversationCount,
                })}
              />
            </section>
          ) : null}

          {productCode === CHATBOT_PRODUCT_CODE ? (
            <section className="card" aria-label="Canales del chatbot" data-testid="client-channels-section">
              <header className="mb-4">
                <h2 className="text-lg font-semibold">Canales</h2>
                <p className="mt-1 text-xs text-kairikos-muted">Solo lectura — el cliente conecta y desconecta desde su portal.</p>
              </header>
              <ChannelsOperatorPanel
                telegram={channelsTelegram}
                meta={channelsMeta}
                allowedChannels={channelsAllowed}
                failedDeliveries={channelsFailedDeliveries}
              />
            </section>
          ) : null}

          {productCode === 'leads' ? (
            <section className="card" aria-label="Leads del cliente" data-testid="client-leads-section">
              <header className="mb-4">
                <h2 className="text-lg font-semibold">Leads</h2>
                <p className="mt-1 text-xs text-kairikos-muted">Solo lectura — el ciclo de vida de cada lead lo maneja el equipo del cliente.</p>
              </header>
              <LeadsSummaryPanel leads={leads} />
            </section>
          ) : null}

          {productCode === 'recall' ? (
            <section className="card" aria-label="Recuperación de llamadas" data-testid="client-recall-section">
              <header className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Recuperación de llamadas</h2>
                  <p className="mt-1 text-xs text-kairikos-muted">
                    Estado del alta y últimas llamadas recuperadas.
                  </p>
                </div>
                <Link href="/admin/portal/recall" className="text-sm text-kairikos-accent2 hover:underline">
                  Ver la cola →
                </Link>
              </header>
              <RecallOperatorPanel data={recall} />
            </section>
          ) : null}

          {productCode === 'seo' ? (
            <section className="card" aria-label="SEO con IA" data-testid="client-seo-section">
              <header className="mb-4">
                <h2 className="text-lg font-semibold">SEO con IA</h2>
                <p className="mt-1 text-xs text-kairikos-muted">
                  El contexto de negocio lo rellena el cliente. Completa aquí el acceso técnico de publicación
                  cuando esté listo.
                </p>
              </header>
              <SeoTechnicalSetupPanel clientId={params.clientId} profile={seoProfile} />
              <div className="mt-4">
                <SeoContentDraftsPanel clientId={params.clientId} drafts={seoContentDrafts} />
              </div>
            </section>
          ) : null}

          {productCode === 'web' && webProjects.length > 0 ? (
            <div className="space-y-4">
              {webProjects.map((project) => (
                <section key={project.clientProductId} data-testid="web-project-editor" data-client-product-id={project.clientProductId}>
                  <h3 className="mb-2 text-sm font-semibold text-kairikos-muted">{project.label}</h3>
                  <WebQuoteEditor
                    clientProductId={project.clientProductId}
                    webQuote={project.webQuote}
                    invoice={project.invoice}
                  />
                </section>
              ))}
            </div>
          ) : null}

          <section className="card" aria-label="Onboarding del cliente">
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Onboarding · {PRODUCT_CATALOGS[productCode]?.label ?? productCode}</h2>
              <div className="flex items-center gap-2">
                {getProductCatalog(productCode).stepKeys.length > 0 ? (
                  <Link
                    href={`/admin/portal/${params.clientId}/wizard?product=${productCode}`}
                    className="btn-ghost"
                    data-testid="onboarding-wizard-review-link"
                  >
                    Revisar pasos del wizard →
                  </Link>
                ) : null}
                {session.isOperator && isDatabaseConfigured ? (
                  <span
                    data-testid="onboarding-operator-badge"
                    className="pill-muted"
                  >
                    Controles de operador activos
                  </span>
                ) : null}
              </div>
            </header>
            <OnboardingTimeline rows={timeline} />
            {session.isOperator && isDatabaseConfigured ? (
              <OnboardingOperatorControls
                clientId={params.clientId}
                productCode={productCode}
                timeline={timeline}
                advance={advanceOnboardingMilestone}
              />
            ) : null}
          </section>

          {latestIntake ? (
            <section className="card" aria-label="Formulario inicial del cliente" data-testid="client-intake-section">
              <header className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Formulario inicial (intake)</h2>
                <span className="text-xs text-kairikos-muted">
                  Enviado el {DATE_FORMAT.format(new Date(latestIntake.createdAt))}
                </span>
              </header>
              <p className="mb-3 text-sm text-kairikos-muted">
                Esto es lo que el cliente respondió antes de tener acceso al asistente de configuración.
                Algunos de estos campos ya han precargado pasos del asistente — la ficha del cliente muestra
                cuáles vienen de aquí sin editar todavía.
              </p>
              <details data-testid="client-intake-raw">
                <summary className="cursor-pointer text-sm font-medium text-kairikos-accent2">
                  Ver respuestas completas
                </summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4 text-xs">
                  {JSON.stringify(latestIntake.payload, null, 2)}
                </pre>
              </details>
            </section>
          ) : null}

          <p className="text-xs text-kairikos-muted">
            Esta vista replica el portal del cliente sin posibilidad de modificar datos.
            Para soporte, accede a la{' '}
            <Link href="/admin/portal/clients" className="underline">lista de clientes</Link>.
          </p>
        </>
      ) : (
        <>
          <section
            className="card"
            aria-label="Historial de actividad del flujo"
            data-testid="flow-history-section"
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Historial del flujo</h2>
              <Link
                href={`/admin/portal/flows${n8nExecutions.some((e) => e.status === 'failed') ? '?filter=failed' : ''}`}
                className="text-sm text-kairikos-accent2 underline"
              >
                Ver dashboard de flujos
              </Link>
            </header>
            <FlowHistoryTimeline entries={flowHistory} />
          </section>

          <section
            className="card"
            aria-label="Ejecuciones de n8n para este cliente"
            data-testid="flow-n8n-section"
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Ejecuciones de n8n</h2>
              <span className="text-sm text-kairikos-muted">
                {n8nExecutions.length} ejecución{n8nExecutions.length === 1 ? '' : 'es'} registrada{n8nExecutions.length === 1 ? '' : 's'}
              </span>
            </header>
            {n8nExecutions.length === 0 ? (
              <EmptyState
                title="Sin ejecuciones de n8n"
                description="Cuando el flujo n8n se ejecute para este cliente, los resultados aparecerán aquí."
              />
            ) : (
              <ul className="space-y-3 text-sm">
                {n8nExecutions.map((exec) => (
                  <li
                    key={exec.id}
                    data-testid="flow-n8n-execution"
                    data-status={exec.status}
                    className="flex flex-col gap-1 border-b border-kairikos-border pb-3 last:border-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{exec.workflow}</span>
                      <span
                        className={
                          exec.status === 'success'
                            ? 'pill-success'
                            : exec.status === 'failed'
                              ? 'pill-danger'
                              : 'pill-warning'
                        }
                      >
                        {exec.status === 'success' ? 'OK' : exec.status === 'failed' ? 'Falló' : 'En curso'}
                      </span>
                    </div>
                    <div className="text-xs text-kairikos-muted">
                      {exec.milestone ? `${exec.milestone} · ` : ''}
                      Inicio: {DATE_FORMAT.format(new Date(exec.startedAt))}
                      {exec.finishedAt
                        ? ` · Fin: ${DATE_FORMAT.format(new Date(exec.finishedAt))}`
                        : ''}
                    </div>
                    {exec.errorMessage ? (
                      <p className="text-xs text-kairikos-danger" data-testid="flow-n8n-error">
                        {exec.errorCode ? `${exec.errorCode}: ` : ''}
                        {exec.errorMessage}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-kairikos-muted">
            Esta vista es de sólo lectura. La pestaña{' '}
            <Link href={`/admin/portal/${params.clientId}`} className="underline">Resumen</Link>{' '}
            muestra el estado del chatbot.
          </p>
        </>
      )}
    </div>
  );
}
