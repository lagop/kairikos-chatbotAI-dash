import 'server-only';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { announcedGraceEnd, serviceState } from '@/lib/villas/exit-rules';
import { renderOwnerExitEmail, sendCarteraEmail } from './emails';
import { carteraFotosDir, isPhotoId } from './photos';
import { auditCartera } from './site';

// =============================================================================
// Cartera — la baja del cliente, desde el cron (PR 6; docs/fase1-cartera.md,
// «Baja del cliente»). El mismo molde que lib/villas/exit.ts, y las mismas
// reglas de plazo (lib/villas/exit-rules.ts: 30 días desde la baja, nunca
// menos de 7 desde el aviso).
//
// No se engancha a donde se cancela la contratación (operador, impago…): el
// cron ve los CarteraSite cuya contratación está 'cancelled' y:
//   1. Si no se avisó todavía, avisa a la agencia una vez (plazo, qué deja de
//      funcionar, dónde descargar) y lo apunta en exitNotifiedAt.
//   2. Si ya se avisó y el plazo pasó, borra las fotos del volumen y después
//      el CarteraSite: casas, fotos, publicaciones, contactos y su auditoría
//      caen en cascada. Queda una fila en clientProductAudit, que no se borra,
//      para poder decir cuándo y por qué ya no están.
//
// Durante la gracia, el feed, las fotos públicas y el formulario de contacto
// ya no responden: los tres comprueban que la contratación esté 'active'
// (findSiteByFeedToken, findPublicPhoto). El panel queda en solo lectura con
// la exportación disponible (requireCarteraPortal('read')).
//
// Las copias en Leads (PR 5) NO se borran aquí: son filas del producto Leads,
// que la agencia puede seguir teniendo contratado, y siguen sus propias reglas.
//
// Reactivar dentro del plazo (ensureCarteraSiteForContract) deja
// exitNotifiedAt a null.
// =============================================================================

const MAX_EXITS_PER_TICK = 20;

export interface CarteraExitResult {
  notified: number;
  purged: number;
}

/**
 * Borra `<CARTERA_FOTOS_DIR>/<siteId>` entero. El nombre de la carpeta es el
 * id del sitio (photos.ts: `<siteId>/<homeId>/<photoId>.<ext>`), así que se
 * comprueba que sea un uuid y que la ruta siga dentro del volumen antes de
 * tocar nada. Sin la carpeta, no hace nada: `force`.
 */
export async function removeSitePhotos(dir: string, siteId: string): Promise<void> {
  if (!isPhotoId(siteId)) throw new Error('cartera.exit: id de sitio con forma rara');
  const root = path.resolve(dir);
  const full = path.resolve(root, siteId.toLowerCase());
  if (path.dirname(full) !== root) throw new Error('cartera.exit: la carpeta del sitio sale del volumen');
  await rm(full, { recursive: true, force: true });
}

export async function processCarteraExits(db: PrismaClient, now: Date = new Date(), opts: { send?: typeof sendCarteraEmail } = {}): Promise<CarteraExitResult> {
  const send = opts.send ?? sendCarteraEmail;
  const result: CarteraExitResult = { notified: 0, purged: 0 };
  const sites = await db.carteraSite.findMany({
    where: { clientProduct: { status: 'cancelled' } },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      siteUrl: true,
      exitNotifiedAt: true,
      clientProductId: true,
      clientProduct: { select: { status: true, cancelledAt: true, changedAt: true, productId: true } },
    },
    orderBy: { exitNotifiedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_EXITS_PER_TICK,
  });

  for (const s of sites) {
    try {
      if (!s.exitNotifiedAt) {
        // Primero se apunta y luego se manda: dos pases a la vez no mandan dos
        // correos. Si el envío falla, queda en el log de errores; el panel
        // enseña lo mismo que el correo (ReadOnlyBanner).
        const claimed = await db.carteraSite.updateMany({ where: { id: s.id, exitNotifiedAt: null }, data: { exitNotifiedAt: now } });
        if (claimed.count === 0) continue;
        const ends = announcedGraceEnd(s.clientProduct, now);
        const [client, homeCount, enquiryCount] = await Promise.all([
          db.chatbotClient.findUnique({ where: { id: s.clientId }, select: { email: true, name: true, companyName: true } }),
          db.carteraHome.count({ where: { siteId: s.id } }),
          db.carteraEnquiry.count({ where: { siteId: s.id } }),
        ]);
        await auditCartera(db, {
          siteId: s.id,
          clientId: s.clientId,
          entity: 'site',
          entityId: s.id,
          action: 'exit_notified',
          actor: 'system',
          metadata: { graceEndsAt: ends.toISOString(), homes: homeCount, enquiries: enquiryCount },
        });
        const email = renderOwnerExitEmail({
          agencyName: client?.companyName?.trim() || client?.name?.trim() || 'agencia',
          siteUrl: s.siteUrl,
          graceEndsAt: ends,
          homeCount,
          enquiryCount,
        });
        const sent = await send(client?.email, email);
        if (!sent.ok) logError('cartera.exit.notify_email', new Error(sent.error), { siteId: s.id }, 'error');
        result.notified++;
        continue;
      }

      const exit = serviceState(s.clientProduct, s.exitNotifiedAt, now);
      if (exit.state !== 'closed') continue;

      // Las fotos del volumen antes que las filas: si el borrado de disco
      // falla, el sitio sigue ahí y el siguiente pase lo reintenta. Al revés,
      // un fallo dejaría archivos huérfanos que nada vuelve a mirar.
      const dir = carteraFotosDir();
      if (dir) {
        await removeSitePhotos(dir, s.id);
      } else if ((await db.carteraPhoto.count({ where: { home: { siteId: s.id } } })) > 0) {
        logError('cartera.exit', new Error('storage_not_configured: hay fotos y no hay CARTERA_FOTOS_DIR; no se purga'), { siteId: s.id }, 'error');
        continue;
      }

      await db.$transaction(async (tx) => {
        await tx.clientProductAudit.create({
          data: {
            clientProductId: s.clientProductId,
            clientId: s.clientId,
            productId: s.clientProduct.productId,
            tenantId: s.tenantId,
            action: 'cartera_data_purged',
            statusBefore: s.clientProduct.status,
            statusAfter: s.clientProduct.status,
            actorId: 'system:cartera-exit',
          },
        });
        await tx.carteraSite.delete({ where: { id: s.id } });
      });
      result.purged++;
    } catch (err) {
      logError('cartera.exit', err, { siteId: s.id }, 'error');
    }
  }
  return result;
}
