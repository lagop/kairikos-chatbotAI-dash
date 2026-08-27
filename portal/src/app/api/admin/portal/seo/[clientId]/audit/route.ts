import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { auditWebsite } from '@/lib/seo-audit';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A full run (initial page fetch + up to LINK_CHECK_CAP sequential
// link checks) can take tens of seconds — see seo-audit.ts's own
// timeout constants. Matches the cron routes' own maxDuration posture.
export const maxDuration = 60;

// =============================================================================
// SEO con IA, Fase A — POST /api/admin/portal/seo/[clientId]/audit
//
// The operator's diagnostic tool, on demand: runs seo-audit.ts's
// auditWebsite() against SeoProfile.siteUrl and persists the LATEST
// result (see the model's own schema comment — no history table yet).
// A failed attempt records lastAuditError without touching the last
// successful lastAuditResult, so a transient site outage doesn't erase
// the operator's last real signal.
// =============================================================================

export async function POST(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: params.clientId },
    select: { id: true, tenantId: true, siteUrl: true },
  });
  if (!profile) {
    return NextResponse.json({ error: 'not_found', detail: 'el cliente aun no ha empezado el onboarding' }, { status: 404 });
  }
  if (!profile.siteUrl) {
    return NextResponse.json({ error: 'no_site_url', detail: 'el cliente aun no indico la URL de su sitio' }, { status: 400 });
  }

  const isLegacyAuth = auth.operatorId === 'legacy';
  const operator = isLegacyAuth
    ? null
    : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  const actorOperatorId = isLegacyAuth ? null : auth.operatorId;
  const actorEmail = operator?.email ?? null;

  const now = new Date();
  const result = await auditWebsite(profile.siteUrl);

  if (!result.ok) {
    try {
      await prisma.seoProfile.update({ where: { id: profile.id }, data: { lastAuditError: result.error } });
    } catch (err) {
      logError('seo_audit.save_failure_failed', err, { clientId: params.clientId }, 'warn');
    }
    return NextResponse.json({ error: 'audit_failed', detail: result.error }, { status: 502 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.seoProfile.update({
        where: { id: profile.id },
        data: { lastAuditAt: now, lastAuditResult: result.data as unknown as Prisma.InputJsonValue, lastAuditError: null },
      });
      await tx.seoProfileAudit.create({
        data: {
          profileId: profile.id,
          clientId: params.clientId,
          tenantId: profile.tenantId,
          action: 'audit_run',
          before: Prisma.JsonNull,
          after: {
            h1Count: result.data.h1Count,
            imagesMissingAlt: result.data.imagesMissingAlt,
            brokenLinksFound: result.data.brokenLinks.length,
          },
          actorType: 'operator',
          actorOperatorId,
          actorEmail,
        },
      });
    });
  } catch (err) {
    logError('seo_audit.save_failed', err, { clientId: params.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, result: result.data });
}
