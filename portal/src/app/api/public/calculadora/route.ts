import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { estimateMissedCallValue, defaultAssumptionsFor } from '@/lib/prospecting-report';
import { PUBLIC_SECTORS, hashIp } from '@/lib/public-draft-request';
import { logError } from '@/lib/observability';
import { clientIpFromHeaders } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// A5 — la calculadora de llamadas perdidas de kairikos.com.
//
// "¿Cuántas llamadas pierdes a la semana?" → "Eso son 11.700 € al año". Es el
// gancho más barato del plan: no llama a ningún modelo ni a Google, solo
// multiplica. Por eso NO lleva los frenos del formulario de borradores, que
// existen porque cada pulsación allí cuesta dinero; aquí calcular es gratis.
//
// Lo que sí se guarda es el CONTACTO cuando lo deja, que es para lo que
// existe la calculadora: quien pide que le mandemos el cálculo está diciendo
// que el número le ha dolido. Eso es un lead, y va a la misma cola que los
// borradores pedidos (/admin/portal/borradores).
//
// El cálculo reutiliza el mismo lib que el informe comercial
// (estimateMissedCallValue), no una copia: si un día se afina el sector de
// las peluquerías, se afina en los dos sitios a la vez. Y arrastra su misma
// defensa — los valores se recortan antes de multiplicar, porque aquí los
// escribe un desconocido en un formulario público.
// =============================================================================

/** Contactos guardados por IP y hora. Una persona de verdad deja uno. */
const CALCULADORA_MAX_CONTACTOS_POR_IP = 5;
const CALCULADORA_VENTANA_MS = 60 * 60 * 1000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  sector: z.string().trim().max(40).default('otro'),
  llamadasPerdidas: z.number().finite(),
  encargoMedio: z.number().finite().optional(),
  cierre: z.number().finite().optional(),
  /** Opcional: si lo deja, se guarda como lead. Sin él, el cálculo se
   *  devuelve igual — cobrar el número con un email obligatorio espanta a
   *  más gente de la que captura. */
  contacto: z.string().trim().max(200).optional(),
  negocio: z.string().trim().max(200).optional(),
  ciudad: z.string().trim().max(120).optional(),
  /** Campo trampa, como en el formulario de borradores. */
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: CORS });
  }
  if (body.data.website && body.data.website.trim().length > 0) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: CORS });
  }

  const sector = PUBLIC_SECTORS[body.data.sector] ?? PUBLIC_SECTORS.otro;
  const estimate = estimateMissedCallValue(
    {
      missedCallsPerWeek: body.data.llamadasPerdidas,
      averageJobValue: body.data.encargoMedio,
      closeRate: body.data.cierre,
    },
    defaultAssumptionsFor(sector.primaryType),
  );

  // El contacto se guarda como lead, pero un fallo guardándolo NO puede
  // impedir que el visitante vea su número: el cálculo es lo que ha venido a
  // buscar y ya está hecho.
  if (body.data.contacto && isDatabaseConfigured) {
    try {
      const ip = clientIpFromHeaders(req.headers);
      // Tope por IP para lo que se GUARDA (revisión del 30/09/2026): sin él,
      // un script podía llenar la tabla de contactos falsos. El cálculo se
      // sigue devolviendo; lo que deja de hacerse es guardar.
      const recientes = await prisma.calculatorLead.count({
        where: { ipHash: hashIp(ip), createdAt: { gte: new Date(Date.now() - CALCULADORA_VENTANA_MS) } },
      });
      if (recientes < CALCULADORA_MAX_CONTACTOS_POR_IP) {
        await prisma.calculatorLead.create({
          data: {
            ipHash: hashIp(ip),
            sector: body.data.sector.slice(0, 40),
            businessName: body.data.negocio?.slice(0, 200) ?? null,
            city: body.data.ciudad?.slice(0, 120) ?? null,
            contact: body.data.contacto.slice(0, 200),
            missedCallsPerWeek: estimate.assumptions.missedCallsPerWeek,
            averageJobValueCents: Math.round(estimate.assumptions.averageJobValue * 100),
            annualLossCents: estimate.annualLostRevenue * 100,
          },
        });
      }
    } catch (err) {
      logError('calculadora.lead_failed', err, { route: 'api/public/calculadora' }, 'warn');
    }
  }

  return NextResponse.json(
    {
      ok: true,
      anual: estimate.annualLostRevenue,
      mensual: estimate.monthlyLostRevenue,
      // Los supuestos viajan con el resultado para que la página pueda
      // enseñarlos al lado, igual que hace el informe comercial. Un número
      // que no se puede discutir no se puede defender.
      supuestos: estimate.assumptions,
    },
    { headers: CORS },
  );
}
