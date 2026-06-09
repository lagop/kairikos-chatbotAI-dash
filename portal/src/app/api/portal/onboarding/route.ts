import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { MOCK_TIMELINE } from '@/lib/portal-data';
// MOCK_BILLING re-exported as MOCK_BILLING_EXPORT for the billing route.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MILESTONE_STEP: Record<string, { id: 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'; label: string }> = {
  'T+0': { id: 't_plus_0', label: 'Bienvenida y acceso al portal' },
  'T+3': { id: 't_plus_3', label: 'Configuración inicial' },
  'T+7': { id: 't_plus_7', label: 'Puesta en producción' },
  'T+14': { id: 't_plus_14', label: 'Revisión y optimización' },
};

export async function GET(_req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json({ timeline: MOCK_TIMELINE });
  }
  const rows = await prisma.chatbotActivity.findMany({
    where: { clientId: resolved.clientId },
    orderBy: { completedAt: 'asc' },
    select: { id: true, milestone: true, completedAt: true, notes: true },
  });
  return NextResponse.json({
    timeline: rows.map((r) => {
      const def = MILESTONE_STEP[r.milestone] ?? { id: 't_plus_0' as const, label: r.milestone };
      return {
        id: r.id,
        step: def.id,
        label: def.label,
        description: r.notes ?? '',
        occurredAt: r.completedAt?.toISOString() ?? null,
        status: r.completedAt ? 'done' : 'current',
      };
    }),
  });
}
