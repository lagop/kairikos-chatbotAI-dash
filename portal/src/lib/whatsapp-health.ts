import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { decryptMetaToken } from './meta-business';
import { listMessageTemplates } from './whatsapp-api';
import {
  renderStuck,
  sendOperatorNotification,
  resolveOperatorRecipients,
} from './operator-notify';
import { logError } from './observability';

// =============================================================================
// WP-XX — keeping the WhatsApp side of the product alive.
//
// Two jobs that both exist because Meta changes state WITHOUT TELLING US,
// and both failures are silent by nature — the product keeps looking fine
// right up until a client's messages stop arriving:
//
//   syncTemplateStatuses() — Meta approves, rejects, or PAUSES templates
//       on its own schedule. A paused template fails every send with
//       132015, so discovering it by polling beats discovering it by a
//       client asking why nobody got a message.
//   warnExpiringTokens()   — long-lived tokens die at ~60 days. Nothing
//       announces it; sends simply start failing. The warning has to come
//       before the expiry, not after.
// =============================================================================

/** How far ahead of expiry the operator gets told. Long enough to chase a
 *  client who has to click through Meta's signup again, short enough that
 *  the warning still feels current when it arrives. */
export const TOKEN_EXPIRY_WARNING_DAYS = 10;

function tokenFor(connection: {
  accessTokenCiphertext: Buffer;
  accessTokenIv: Buffer;
  accessTokenTag: Buffer;
}): string | null {
  try {
    return decryptMetaToken({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      tag: connection.accessTokenTag,
    });
  } catch (err) {
    // A key rotation makes every stored token undecryptable. That must
    // degrade to "this connection needs attention", never to a thrown
    // error that aborts a sweep over everyone else's connections.
    logError('whatsapp_health.decrypt_failed', err, {}, 'warn');
    return null;
  }
}

export interface TemplateSyncResult {
  connections: number;
  templates: number;
  failed: number;
}

/**
 * Refresh every active WABA's template statuses from Meta.
 *
 * The local rows are a MIRROR, never the source of truth: Meta can pause
 * a template for quality at any moment, so this upserts whatever Meta
 * currently says rather than only writing rows we created.
 */
export async function syncTemplateStatuses(
  prisma: PrismaClient,
  opts: { limit?: number; now?: Date } = {},
): Promise<TemplateSyncResult> {
  const now = opts.now ?? new Date();
  const connections = await prisma.metaChannelConnection.findMany({
    where: { channel: 'whatsapp', status: 'active', wabaId: { not: null } },
    orderBy: { connectedAt: 'asc' },
    take: opts.limit ?? 25,
    select: {
      id: true,
      clientId: true,
      wabaId: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });

  const result: TemplateSyncResult = { connections: connections.length, templates: 0, failed: 0 };

  for (const connection of connections) {
    try {
      const token = tokenFor(connection);
      if (!token || !connection.wabaId) {
        result.failed += 1;
        continue;
      }

      const listed = await listMessageTemplates(token, connection.wabaId);
      if (!listed.ok) {
        await prisma.metaChannelConnection
          .update({ where: { id: connection.id }, data: { lastSyncError: listed.error.slice(0, 500) } })
          .catch(() => null);
        result.failed += 1;
        continue;
      }

      for (const template of listed.data.data ?? []) {
        if (!template.name || !template.language) continue;
        await prisma.whatsappTemplate.upsert({
          where: {
            connectionId_name_languageCode: {
              connectionId: connection.id,
              name: template.name,
              languageCode: template.language,
            },
          },
          create: {
            clientId: connection.clientId,
            connectionId: connection.id,
            name: template.name,
            languageCode: template.language,
            metaTemplateId: template.id ?? null,
            // Meta's own vocabulary, uppercased as it returns it — a
            // value we don't recognise still round-trips honestly.
            status: template.status ?? 'PENDING',
            category: template.category ?? null,
            rejectedReason: template.rejected_reason ?? null,
            lastCheckedAt: now,
          },
          update: {
            metaTemplateId: template.id ?? null,
            status: template.status ?? 'PENDING',
            category: template.category ?? null,
            rejectedReason: template.rejected_reason ?? null,
            lastCheckedAt: now,
          },
        });
        result.templates += 1;
      }
    } catch (err) {
      result.failed += 1;
      logError('whatsapp_health.template_sync_failed', err, { connectionId: connection.id }, 'warn');
    }
  }

  return result;
}

export interface TokenExpiryResult {
  scanned: number;
  expiring: number;
  warned: number;
  expired: number;
}

/**
 * Warn about tokens about to expire, and mark the ones already dead.
 *
 * Two distinct outcomes:
 *   - Expiring soon → email an operator once (guarded by expiryWarnedAt,
 *     so this is safe to run on every scheduler tick) and leave the
 *     connection active, because it still works.
 *   - Already expired → flip to 'needs_reconnect'. Nothing in this
 *     codebase has ever written that status despite it being in the
 *     documented vocabulary since the model was created; without it a
 *     dead connection is indistinguishable from a healthy one.
 */
export async function warnExpiringTokens(
  prisma: PrismaClient,
  opts: { now?: Date; warningDays?: number } = {},
): Promise<TokenExpiryResult> {
  const now = opts.now ?? new Date();
  const warningDays = opts.warningDays ?? TOKEN_EXPIRY_WARNING_DAYS;
  const horizon = new Date(now.getTime() + warningDays * 24 * 60 * 60 * 1000);

  const connections = await prisma.metaChannelConnection.findMany({
    where: {
      status: 'active',
      tokenExpiresAt: { not: null, lt: horizon },
    },
    select: {
      id: true,
      clientId: true,
      channel: true,
      tokenExpiresAt: true,
      expiryWarnedAt: true,
      displayPhoneNumber: true,
      client: { select: { name: true, companyName: true } },
    },
  });

  const result: TokenExpiryResult = { scanned: connections.length, expiring: 0, warned: 0, expired: 0 };
  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);

  for (const connection of connections) {
    try {
      const expiresAt = connection.tokenExpiresAt;
      if (!expiresAt) continue;

      if (expiresAt <= now) {
        result.expired += 1;
        await prisma.metaChannelConnection.update({
          where: { id: connection.id },
          data: { status: 'needs_reconnect', lastSyncError: 'token_expired' },
        });
        continue;
      }

      result.expiring += 1;
      // One warning per token. A reconnect clears expiryWarnedAt, so the
      // next token gets its own warning.
      if (connection.expiryWarnedAt || recipients.length === 0) continue;

      const hoursLeft = Math.floor((expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000));
      const clientName = connection.client.companyName ?? connection.client.name;
      const rendered = renderStuck({
        clientId: connection.clientId,
        clientName,
        milestone: `token de ${connection.channel}${connection.displayPhoneNumber ? ` (${connection.displayPhoneNumber})` : ''} caduca`,
        // The 'stuck' template speaks in hours-since; here it is
        // hours-until, so it is negated to read correctly rather than
        // showing a nonsensical elapsed time.
        hoursSince: -hoursLeft,
        portalUrl: `${process.env.NEXT_PUBLIC_PORTAL_URL ?? ''}/admin/portal/${connection.clientId}`,
      });

      const sent = await sendOperatorNotification({
        kind: 'stuck',
        to: recipients,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (!sent.ok) continue;

      // Stamped only after a successful send: stamping first would
      // silence the retry and the token would die unannounced.
      await prisma.metaChannelConnection.update({
        where: { id: connection.id },
        data: { expiryWarnedAt: now },
      });
      result.warned += 1;
    } catch (err) {
      logError('whatsapp_health.expiry_check_failed', err, { connectionId: connection.id }, 'warn');
    }
  }

  return result;
}
