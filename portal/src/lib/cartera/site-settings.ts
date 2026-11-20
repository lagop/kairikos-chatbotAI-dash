import 'server-only';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { auditCartera, generateCarteraToken, hashBuildSecret } from './site';

// =============================================================================
// Cartera — lo que configura el operador en un sitio
// (PATCH /api/admin/portal/cartera/[siteId]).
//
// Repositorio de GitHub, workflow, URL de la web, agentes y prefijos de
// referencia; y regenerar el token del feed o el secreto de publicación. Los
// dos se devuelven en claro UNA sola vez, en la respuesta del PATCH: el
// secreto solo queda como hash, y el token del feed no se vuelve a enseñar
// (va en los secretos de GitHub de la web, nunca en su HTML).
//
// La auditoría apunta QUÉ campos cambiaron y que se regeneró algo, nunca los
// valores de los tokens ni sus hashes.
// =============================================================================

// owner/repo de GitHub: letras, números, guion, punto y guion bajo.
const githubRepo = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Formato owner/repositorio');
const workflowFile = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/, 'Un archivo .yml de .github/workflows');
const prefix = z.string().trim().regex(/^[A-Z]{1,3}$/, 'De una a tres mayúsculas');

function isPublicHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

export const agentSchema = z.object({
  // La clave de src/config/agents.ts de SU web: la que va en `agent` de cada casa.
  key: z.string().trim().regex(/^[a-z][a-z0-9-]{0,39}$/, 'Minúsculas, números y guiones'),
  name: z.string().trim().min(1).max(80),
});
export type CarteraAgent = z.infer<typeof agentSchema>;

export const siteSettingsSchema = z
  .object({
    githubRepo: githubRepo.nullable().optional(),
    workflowFile: workflowFile.optional(),
    siteUrl: z.string().trim().max(300).refine(isPublicHttpUrl, 'URL http(s) completa').nullable().optional(),
    salePrefix: prefix.optional(),
    rentPrefix: prefix.optional(),
    agents: z
      .array(agentSchema)
      .max(30)
      .refine((list) => new Set(list.map((a) => a.key)).size === list.length, 'Clave de agente repetida')
      .optional(),
    regenerateFeedToken: z.literal(true).optional(),
    regenerateBuildSecret: z.literal(true).optional(),
  })
  .strict();
export type SiteSettingsInput = z.infer<typeof siteSettingsSchema>;

export interface SiteForSettings {
  id: string;
  clientId: string;
  salePrefix: string;
  rentPrefix: string;
}

export type ApplySettingsResult =
  | { ok: true; changed: string[]; feedToken?: string; buildSecret?: string }
  | { ok: false; error: 'same_prefix' };

export async function applySiteSettings(
  db: Prisma.TransactionClient,
  site: SiteForSettings,
  input: SiteSettingsInput,
  actor: string,
): Promise<ApplySettingsResult> {
  // Una venta y un alquiler no pueden compartir prefijo: la referencia es
  // única por sitio y C-101 tiene que decir de qué operación es.
  const sale = input.salePrefix ?? site.salePrefix;
  const rent = input.rentPrefix ?? site.rentPrefix;
  if (sale === rent) return { ok: false, error: 'same_prefix' };

  const data: Prisma.CarteraSiteUpdateInput = {};
  const changed: string[] = [];
  if (input.githubRepo !== undefined) {
    data.githubRepo = input.githubRepo;
    changed.push('githubRepo');
  }
  if (input.workflowFile !== undefined) {
    data.workflowFile = input.workflowFile;
    changed.push('workflowFile');
  }
  if (input.siteUrl !== undefined) {
    data.siteUrl = input.siteUrl ? input.siteUrl.replace(/\/+$/, '') : null;
    changed.push('siteUrl');
  }
  if (input.salePrefix !== undefined) {
    data.salePrefix = input.salePrefix;
    changed.push('salePrefix');
  }
  if (input.rentPrefix !== undefined) {
    data.rentPrefix = input.rentPrefix;
    changed.push('rentPrefix');
  }
  if (input.agents !== undefined) {
    data.agents = input.agents;
    changed.push('agents');
  }

  let feedToken: string | undefined;
  let buildSecret: string | undefined;
  if (input.regenerateFeedToken) {
    feedToken = generateCarteraToken('car');
    data.feedToken = feedToken;
  }
  if (input.regenerateBuildSecret) {
    buildSecret = generateCarteraToken('cbs');
    data.buildSecretHash = hashBuildSecret(buildSecret);
  }

  if (changed.length > 0 || feedToken || buildSecret) {
    await db.carteraSite.update({ where: { id: site.id }, data });
  }
  if (changed.length > 0) {
    await auditCartera(db, { siteId: site.id, clientId: site.clientId, entity: 'site', entityId: site.id, action: 'settings_updated', actor, metadata: { fields: changed } });
  }
  if (feedToken) {
    await auditCartera(db, { siteId: site.id, clientId: site.clientId, entity: 'site', entityId: site.id, action: 'feed_token_regenerated', actor });
  }
  if (buildSecret) {
    await auditCartera(db, { siteId: site.id, clientId: site.clientId, entity: 'site', entityId: site.id, action: 'build_secret_regenerated', actor });
  }
  return { ok: true, changed, ...(feedToken ? { feedToken } : {}), ...(buildSecret ? { buildSecret } : {}) };
}
