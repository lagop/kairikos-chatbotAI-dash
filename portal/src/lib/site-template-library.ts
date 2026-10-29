import 'server-only';
import type { PrismaClient } from '@prisma/client';
import type { SiteTemplateRow } from '@/components/admin/SiteTemplateLab';
import { diffSiteTemplates } from './site-template-diff';
import { recoverStaleJobs } from './site-template-jobs';

// =============================================================================
// La biblioteca de plantillas tal como la ve el laboratorio del operador
// (/admin/portal/plantillas). La misma lista sirve a la página y a la ruta que
// la refresca: antes estaba copiada en las dos.
//
// 29/10/2026 — y con lo de las correcciones: de qué plantilla es cada una, qué
// cambia respecto a la vigente (solo las que aún pueden aplicarse) y, de cada
// aprobada, sus versiones anteriores para poder volver a ellas.
// =============================================================================

/** Las correcciones que todavía pueden acabar aplicadas. */
const OPEN = new Set(['pendiente_navegador', 'corrigiendo', 'lista', 'fallida']);

export async function listSiteTemplates(prisma: PrismaClient): Promise<SiteTemplateRow[]> {
  await recoverStaleJobs(prisma);
  const rows = await prisma.siteTemplate.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      nombre: true,
      sector: true,
      variante: true,
      origen: true,
      modelo: true,
      estado: true,
      validacion: true,
      estilo: true,
      createdAt: true,
      correccionDe: true,
      original: { select: { nombre: true } },
      versiones: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, createdAt: true, motivo: true, actorEmail: true } },
      _count: { select: { websites: true } },
    },
  });

  const open = rows.filter((r) => r.correccionDe && OPEN.has(r.estado));
  const ids = Array.from(new Set(open.flatMap((r) => [r.id, r.correccionDe as string])));
  const bodies = ids.length
    ? new Map(
        (await prisma.siteTemplate.findMany({ where: { id: { in: ids } }, select: { id: true, marco: true, secciones: true, estilo: true } })).map((b) => [b.id, b]),
      )
    : new Map();

  return rows.map((r) => {
    const fix = r.correccionDe && OPEN.has(r.estado) ? bodies.get(r.id) : undefined;
    const base = r.correccionDe ? bodies.get(r.correccionDe) : undefined;
    return {
      id: r.id,
      nombre: r.nombre,
      sector: r.sector,
      variante: r.variante,
      origen: r.origen,
      modelo: r.modelo,
      estado: r.estado,
      validacion: r.validacion as SiteTemplateRow['validacion'],
      estilo: r.estilo as SiteTemplateRow['estilo'],
      createdAt: r.createdAt.toISOString(),
      _count: r._count,
      correccionDe: r.correccionDe,
      corrige: r.original?.nombre ?? null,
      cambios: fix && base ? diffSiteTemplates(base, fix) : null,
      versiones: r.versiones.map((v) => ({ id: v.id, createdAt: v.createdAt.toISOString(), motivo: v.motivo, actorEmail: v.actorEmail })),
    };
  });
}
