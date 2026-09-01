import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/settings/recall-templates
 *
 * Lists all 7 RecallTemplateDefinition rows for the settings UI at
 * /admin/portal/settings/recall-templates. bodyText is real product
 * copy shown to real customers, not a secret — returned in full, unlike
 * every credential status route in this admin area.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const rows = await prisma.recallTemplateDefinition.findMany({ orderBy: { sortOrder: 'asc' } });
  return NextResponse.json({
    templates: rows.map((row) => ({
      name: row.name,
      languageCode: row.languageCode,
      category: row.category,
      bodyText: row.bodyText,
      bodyExamples: row.bodyExamples,
      updatedAt: row.updatedAt.toISOString(),
      updatedByEmail: row.updatedByEmail,
    })),
  });
}
