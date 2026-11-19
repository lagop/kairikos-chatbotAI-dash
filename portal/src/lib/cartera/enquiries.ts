import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { hasLeadsInboxAccess } from '@/lib/leads';
import { classifyContact } from '@/lib/website-form';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { auditCartera, loadFeedRows, type Db } from './site';
import { buildFeed } from './feed';
import {
  describeEnquiry,
  enquiryPayload,
  enquiryRefs,
  isPurgeDue,
  leadSummary,
  renderAgencyEnquiryEmail,
  renderSavedListEmail,
  retentionCutoff,
  SAVED_EMAILS_PER_DAY,
  type EnquiryHome,
  type EnquiryInput,
  type EnquiryStatus,
  type Lang,
} from './enquiry-rules';
import { fromWithName, sendCarteraEmail } from './emails';

// =============================================================================
// Cartera — los contactos de la web (PR 5): guardarlos, avisar, copiarlos como
// Lead y borrarlos a los 24 meses. Las reglas y los textos, en enquiry-rules.ts.
//
// El contrato es docs/contactos.md de la plantilla: un solo endpoint para los
// siete formularios (POST /api/public/cartera/[token]/contacto).
//
// Orden al recibir uno: se guarda primero (con su auditoría), y después, cada
// cosa por su lado y sin tumbar a las demás, la copia como Lead y los correos.
// El contacto ya está en el panel aunque el correo falle: el envío es
// best-effort por diseño (CLAUDE.md, trampa nº 4).
// =============================================================================

export interface EnquirySite {
  id: string;
  clientId: string;
  tenantId: string | null;
  siteUrl: string | null;
}

/** Las casas publicadas ahora mismo, por referencia: las que están en el feed. */
export async function publishedHomes(db: Db, siteId: string): Promise<Map<string, EnquiryHome>> {
  const { feed } = buildFeed(await loadFeedRows(db, siteId), {
    baseUrl: 'https://portal.invalid',
  });
  const map = new Map<string, EnquiryHome>();
  for (const v of feed.ventas)
    map.set(v.ref, {
      ref: v.ref,
      operation: 'venta',
      title: v.title,
      slugs: v.slugs,
      amount: v.price,
    });
  for (const a of feed.alquileres)
    map.set(a.ref, {
      ref: a.ref,
      operation: 'alquiler',
      title: a.title,
      slugs: a.slugs,
      amount: a.rent,
    });
  return map;
}

export type ReceiveResult = { ok: true; enquiryId: string; refs: string[] } | { ok: false; error: 'no_homes' | 'recipient_limit' };

export async function receiveEnquiry(prisma: PrismaClient, site: EnquirySite, input: EnquiryInput, now: Date = new Date()): Promise<ReceiveResult> {
  const homes = await publishedHomes(prisma, site.id);

  // Guardadas: solo las que siguen en la cartera publicada; si no queda ninguna, 400.
  let refs = enquiryRefs(input);
  if (input.kind === 'saved_email' || input.kind === 'saved_agency') {
    refs = refs.filter((r) => homes.has(r));
    if (!refs.length) return { ok: false, error: 'no_homes' };
  }

  // «Mándamela por email»: 3 al día al mismo destino, contando todas las webs.
  // Así un token filtrado no sirve para inundar el buzón de un tercero.
  if (input.kind === 'saved_email') {
    const sent = await prisma.carteraEnquiry.count({
      where: {
        kind: 'saved_email',
        contact: input.contact,
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    });
    if (sent >= SAVED_EMAILS_PER_DAY) return { ok: false, error: 'recipient_limit' };
  }

  const payload = enquiryPayload(input);
  const name = input.name?.trim() || null;
  const enquiry = await prisma.$transaction(async (tx) => {
    const row = await tx.carteraEnquiry.create({
      data: {
        siteId: site.id,
        clientId: site.clientId,
        tenantId: site.tenantId,
        kind: input.kind,
        refs,
        name,
        contact: input.contact,
        lang: input.lang,
        consentAt: now,
        payload: payload as object,
        status: 'nuevo',
        createdAt: now,
      },
      select: { id: true },
    });
    // Sin datos personales: el tipo, las casas y el idioma.
    await auditCartera(tx, {
      siteId: site.id,
      clientId: site.clientId,
      entity: 'enquiry',
      entityId: row.id,
      action: 'enquiry_received',
      actor: 'buyer',
      metadata: { kind: input.kind, refs, lang: input.lang },
    });
    return row;
  });

  const summary = describeEnquiry(input.kind, payload, refs);
  await copyAsLead(prisma, site, enquiry.id, {
    kind: input.kind,
    name,
    contact: input.contact,
    summary,
    refs,
    homes,
  });
  await sendEnquiryEmails(prisma, site, {
    input,
    name,
    refs,
    summary,
    homes,
    consentAt: now,
    enquiryId: enquiry.id,
  });
  return { ok: true, enquiryId: enquiry.id, refs };
}

/** Con el producto de captación, una copia en la bandeja de leads. Nunca lanza. */
async function copyAsLead(
  prisma: PrismaClient,
  site: EnquirySite,
  enquiryId: string,
  e: {
    kind: string;
    name: string | null;
    contact: string;
    summary: string;
    refs: string[];
    homes: Map<string, EnquiryHome>;
  },
): Promise<void> {
  try {
    if (!(await hasLeadsInboxAccess(prisma, site.clientId))) return;
    const contact = classifyContact(e.contact);
    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          clientId: site.clientId,
          tenantId: site.tenantId,
          source: 'inbound',
          channel: 'web',
          status: 'nuevo',
          contactName: e.name,
          contactPhone: contact.phone,
          contactEmail: contact.email,
          summary: leadSummary(e.kind, e.summary, e.refs, e.homes),
        },
        select: { id: true },
      });
      await tx.leadAudit.create({
        data: {
          leadId: lead.id,
          clientId: site.clientId,
          tenantId: site.tenantId,
          action: 'created',
          statusBefore: null,
          statusAfter: 'nuevo',
          actorId: 'system:cartera',
        },
      });
      await tx.carteraEnquiry.update({
        where: { id: enquiryId },
        data: { leadId: lead.id },
      });
    });
  } catch (err) {
    logError('cartera.enquiry_lead_copy', err, { enquiryId }, 'warn');
  }
}

/** El aviso a la agencia y, en «Mándamela por email», la lista al comprador. Nunca lanza. */
async function sendEnquiryEmails(
  prisma: PrismaClient,
  site: EnquirySite,
  e: {
    input: EnquiryInput;
    name: string | null;
    refs: string[];
    summary: string;
    homes: Map<string, EnquiryHome>;
    consentAt: Date;
    enquiryId: string;
  },
): Promise<void> {
  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: site.clientId },
      select: { email: true, name: true, companyName: true },
    });
    const agencyName = client?.companyName?.trim() || client?.name?.trim() || 'la agencia';
    // Uno detrás de otro: son dos como mucho y así el orden es fijo.
    const jobs: Array<() => Promise<{ ok: boolean; error?: string }>> = [
      () =>
        sendCarteraEmail(
          client?.email,
          renderAgencyEnquiryEmail({
            kind: e.input.kind,
            name: e.name,
            contact: e.input.contact,
            lang: e.input.lang,
            consentAt: e.consentAt,
            summary: e.summary,
            refs: e.refs,
            homes: e.homes,
            siteUrl: site.siteUrl,
            panelUrl: `${portalBaseUrl()}/portal/cartera`,
          }),
          // Responder desde el correo le contesta al comprador si dejó un email.
          { replyTo: e.input.contact.includes('@') ? e.input.contact : null },
        ),
    ];
    if (e.input.kind === 'saved_email') {
      const siteUrl = site.siteUrl;
      if (siteUrl) {
        const homes = e.refs.map((r) => e.homes.get(r)!).filter(Boolean);
        jobs.push(() =>
          sendCarteraEmail(
            e.input.contact,
            renderSavedListEmail({
              agencyName,
              siteUrl,
              lang: e.input.lang as Lang,
              homes,
            }),
            {
              from: fromWithName(agencyName),
              replyTo: client?.email ?? null,
            },
          ),
        );
      } else {
        logError('cartera.saved_email_no_site_url', new Error('El sitio no tiene siteUrl: no se puede enlazar la lista.'), { siteId: site.id }, 'warn');
      }
    }
    for (const job of jobs) {
      const r = await job();
      if (!r.ok) logError('cartera.enquiry_email', 'error' in r ? r.error : 'send_failed', { enquiryId: e.enquiryId }, 'warn');
    }
  } catch (err) {
    logError('cartera.enquiry_email', err, { enquiryId: e.enquiryId }, 'warn');
  }
}

// --- El panel ----------------------------------------------------------------------

export async function listEnquiriesForPanel(db: Db, siteId: string) {
  const [rows, homes] = await Promise.all([
    db.carteraEnquiry.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        kind: true,
        refs: true,
        name: true,
        contact: true,
        lang: true,
        payload: true,
        status: true,
        createdAt: true,
        consentAt: true,
        leadId: true,
      },
    }),
    db.carteraHome.findMany({
      where: { siteId },
      select: { id: true, ref: true, title: true },
    }),
  ]);
  const byRef = new Map(homes.map((h) => [h.ref, h]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    refs: r.refs.map((ref) => ({
      ref,
      homeId: byRef.get(ref)?.id ?? null,
      title: byRef.get(ref)?.title ?? null,
    })),
    name: r.name,
    contact: r.contact,
    lang: r.lang,
    summary: describeEnquiry(r.kind, (r.payload ?? {}) as Record<string, unknown>, r.refs),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    consentAt: r.consentAt.toISOString(),
    copiedToLeads: r.leadId !== null,
  }));
}

export type EnquiryForPanel = Awaited<ReturnType<typeof listEnquiriesForPanel>>[number];

export async function setEnquiryStatus(
  prisma: PrismaClient,
  site: { id: string; clientId: string },
  enquiryId: string,
  status: EnquiryStatus,
  actor: string,
): Promise<{ ok: true; status: EnquiryStatus } | { ok: false; error: 'not_found' }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.carteraEnquiry.findFirst({
      where: { id: enquiryId, siteId: site.id },
      select: { id: true, status: true, kind: true },
    });
    if (!row) return { ok: false as const, error: 'not_found' as const };
    if (row.status !== status) {
      await tx.carteraEnquiry.update({
        where: { id: row.id },
        data: { status },
      });
      await auditCartera(tx, {
        siteId: site.id,
        clientId: site.clientId,
        entity: 'enquiry',
        entityId: row.id,
        action: 'enquiry_status_changed',
        actor,
        metadata: { kind: row.kind, from: row.status, to: status },
      });
    }
    return { ok: true as const, status };
  });
}

// --- La purga (cron) ---------------------------------------------------------------

/**
 * Los contactos de más de 24 meses se borran, una vez al día por sitio
 * (`enquiriesPurgedAt`). La auditoría apunta cuántos y hasta qué fecha, sin
 * datos personales. La copia como Lead, si la hubo, sigue las reglas de su
 * producto y no se toca aquí.
 */
export async function purgeOldEnquiries(prisma: PrismaClient, now: Date = new Date()): Promise<{ sites: number; deleted: number }> {
  const sites = await prisma.carteraSite.findMany({
    where: {
      OR: [
        { enquiriesPurgedAt: null },
        {
          enquiriesPurgedAt: {
            lte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          },
        },
      ],
    },
    select: { id: true, clientId: true, enquiriesPurgedAt: true },
  });
  const cutoff = retentionCutoff(now);
  let deleted = 0;
  let done = 0;
  for (const site of sites) {
    if (!isPurgeDue(site.enquiriesPurgedAt, now)) continue;
    await prisma.$transaction(async (tx) => {
      const r = await tx.carteraEnquiry.deleteMany({
        where: { siteId: site.id, createdAt: { lt: cutoff } },
      });
      await tx.carteraSite.update({
        where: { id: site.id },
        data: { enquiriesPurgedAt: now },
      });
      if (r.count > 0) {
        await auditCartera(tx, {
          siteId: site.id,
          clientId: site.clientId,
          entity: 'site',
          entityId: site.id,
          action: 'enquiries_purged',
          actor: 'system',
          metadata: { count: r.count, olderThan: cutoff.toISOString() },
        });
      }
      deleted += r.count;
    });
    done++;
  }
  return { sites: done, deleted };
}
