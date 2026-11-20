import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logError } from '@/lib/observability';
import { requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { auditExport, exportResponse, planCarteraExport } from '@/lib/cartera/export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/portal/cartera/exportar — el ZIP de la cartera (docs/exportacion.md
 * de la plantilla): las casas listas para src/content/ de la web, sus fotos,
 * los borradores y los contactos en CSV.
 *
 * Con modo 'read': también en la gracia de una baja, que es justo cuando más
 * hace falta. Si algún JSON no valida o falta una foto, no hay ZIP y el error
 * es del portal (500 'export_failed', con el detalle en el log). Cada descarga
 * queda en la auditoría. La lógica, en lib/cartera/export.ts.
 *
 * `?comprobar=1` prepara el ZIP sin mandarlo ni auditarlo y devuelve los
 * recuentos: el botón de la pestaña Exportar lo llama antes de navegar a la
 * descarga, para enseñar un error legible en vez de un JSON en una pestaña
 * nueva. La descarga en sí es un enlace normal: el navegador la guarda en
 * disco según llega, sin pasar el ZIP entero por la memoria de la página.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;

  const planned = await planCarteraExport(prisma, ctx.site);
  if (!planned.ok) {
    logError('cartera.export', new Error(`${planned.error}: ${planned.detail}`), { siteId: ctx.site.id }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
  if (req.nextUrl.searchParams.get('comprobar') === '1') {
    return NextResponse.json({ ok: true, counts: planned.plan.counts }, { headers: { 'Cache-Control': 'no-store' } });
  }
  await auditExport(prisma, ctx.site, planned.plan, ctx.actor);
  return exportResponse(planned.plan, (err) => logError('cartera.export_stream', err, { siteId: ctx.site.id }, 'error'));
}
