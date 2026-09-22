import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { crawlWebsite } from '@/lib/prospecting-enrichment';
import { suggestProspectingTargets, MAX_WEBSITE_CHARS } from '@/lib/prospecting-brief-ai';
import { logError } from '@/lib/observability';
import { takeAiRequest, AI_RATE_LIMITED_RESPONSE } from '@/lib/ai-route-limits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase A — POST /api/portal/prospecting/campaign/suggest
//
// Propone rubros y zonas a partir de lo que el cliente cuenta de su negocio y,
// si da su web, de lo que ponga en ella. NO GUARDA NADA: devuelve la propuesta
// y el cliente la confirma con el PATCH de siempre. Así una sugerencia mala
// nunca cambia por su cuenta a quién se busca.
//
// La web la rastrea el mismo crawler que ya se usa sobre la web de los
// prospectos, con su tope de tiempo y de tamaño.
// =============================================================================

const BodySchema = z.object({
  clientWebsite: z.string().trim().max(500).optional(),
  businessDescription: z.string().trim().max(2000).optional(),
  idealCustomer: z.string().trim().max(2000).optional(),
  exclusions: z.string().trim().max(2000).optional(),
});

/** Solo http(s) y nada de direcciones internas: el crawler sale a internet
 *  con una URL que escribe el cliente. Misma postura que el filtro de URLs
 *  del rastreo de conocimiento. */
function safePublicUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  // Se le antepone https:// a lo que el cliente escriba sin protocolo, pero
  // solo si no traía otro: "ftp://archivos.example" se convertía en
  // "https://ftp://archivos.example", una URL válida cuyo host es "ftp".
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  const candidate = hasScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  // Un host sin punto no es un dominio publico, es una maquina de la red interna.
  if (!host.includes('.')) return null;
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '169.254.169.254'
  ) {
    return null;
  }
  return url.toString();
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!(await isProductContracted(prisma, resolved.clientId, 'prospecting'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  // Rastrea la web del cliente y llama al modelo: cupo por cliente —
  // lib/ai-route-limits.ts.
  if (!takeAiRequest('prospecting_suggest', resolved.clientId)) {
    return NextResponse.json(AI_RATE_LIMITED_RESPONSE, { status: 429 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { name: true, companyName: true },
  });

  // La web es opcional y su rastreo es el mejor esfuerzo: si no carga, se
  // propone con lo que el cliente haya escrito en vez de fallar.
  let websiteText: string | null = null;
  let websiteError: string | null = null;
  const url = safePublicUrl(body.data.clientWebsite);
  if (body.data.clientWebsite && !url) {
    websiteError = 'invalid_url';
  } else if (url) {
    const crawl = await crawlWebsite(url);
    if (crawl.ok) websiteText = crawl.data.rawText.slice(0, MAX_WEBSITE_CHARS);
    else websiteError = 'crawl_failed';
  }

  try {
    const result = await suggestProspectingTargets({
      businessName: client?.companyName?.trim() || client?.name?.trim() || 'el negocio',
      businessDescription: body.data.businessDescription ?? null,
      idealCustomer: body.data.idealCustomer ?? null,
      exclusions: body.data.exclusions ?? null,
      websiteText,
      knownLocation: null,
    });

    if (!result.ok) {
      logError('prospecting_brief.suggest_failed', new Error(result.error), { clientId: resolved.clientId }, 'warn');
      return NextResponse.json({ error: 'suggestion_failed', websiteError }, { status: 502 });
    }
    if ('skipped' in result) {
      return NextResponse.json({ skipped: result.reason, websiteError }, { status: 200 });
    }
    return NextResponse.json({ suggestion: result.suggestion, websiteRead: websiteText !== null, websiteError });
  } catch (err) {
    logError('prospecting_brief.suggest_route_failed', err, { clientId: resolved.clientId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
