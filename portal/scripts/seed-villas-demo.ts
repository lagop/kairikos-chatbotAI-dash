/**
 * Reserva propia para villas — datos de demostración para un cliente que ya
 * existe (normalmente uno interno, como demo-alisio@kairikos.com).
 *
 *   npx tsx scripts/seed-villas-demo.ts <email-del-cliente>
 *
 * Activa la contratación 'villas' (si no lo está), crea su VillaRental y tres
 * villas ficticias de la demo del hotel (Sombra Buena) con temporadas de
 * verano y Navidad. Idempotente: lo que ya existe no se toca. Imprime el token
 * del widget para abrir /widget/demo-villas.html?token=…
 *
 * No escribe a mano lo que hace lib/villas/rental.ts (activateVillaRental):
 * ese módulo importa 'server-only' y no carga fuera de Next. Si cambia la
 * forma de activar, cambia también aquí. Contra producción, solo con el visto
 * bueno del propietario: crea una contratación.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const token = (prefix: string) => `${prefix}_${randomBytes(18).toString('base64url')}`;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const VILLAS = [
  { slug: 'alcornoque', name: 'Villa Alcornoque', maxGuests: 4, nightlyCents: 18000, minNights: 2, cleaningFeeCents: 6000 },
  { slug: 'castano', name: 'Villa Castaño', maxGuests: 6, nightlyCents: 24000, minNights: 3, cleaningFeeCents: 8000 },
  { slug: 'encina', name: 'Villa Encina', maxGuests: 2, nightlyCents: 14000, minNights: 2, cleaningFeeCents: 4500 },
];

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Uso: npx tsx scripts/seed-villas-demo.ts <email-del-cliente>');
  const client = await prisma.chatbotClient.findUnique({ where: { email }, select: { id: true, tenantId: true, companyName: true, name: true } });
  if (!client) throw new Error(`No existe el cliente ${email}`);
  const product = await prisma.product.findFirst({ where: { code: 'villas', isActive: true }, select: { id: true } });
  if (!product) throw new Error("Falta el producto 'villas' (¿se aplicó la migración 20261115200000_reserva_villas?)");

  let contract = await prisma.clientProduct.findFirst({ where: { clientId: client.id, productId: product.id }, select: { id: true, status: true } });
  if (!contract) {
    contract = await prisma.clientProduct.create({
      data: { clientId: client.id, productId: product.id, tenantId: client.tenantId, status: 'active', createdBy: 'script:seed-villas-demo', onboardingState: 'live' },
      select: { id: true, status: true },
    });
  } else if (contract.status !== 'active') {
    await prisma.clientProduct.update({ where: { id: contract.id }, data: { status: 'active', cancelledAt: null } });
  }

  let rental = await prisma.villaRental.findUnique({ where: { clientProductId: contract.id } });
  if (!rental) {
    rental = await prisma.villaRental.create({
      data: {
        clientProductId: contract.id,
        clientId: client.id,
        tenantId: client.tenantId,
        publicToken: token('vil'),
        businessName: 'Villas Sombra Buena (demo)',
        balanceNote: 'El resto se paga a la llegada, con tarjeta o en efectivo.',
        cancellationNote: 'Cancelas gratis hasta 30 días antes de la llegada; después, el depósito no se devuelve.',
      },
    });
  }

  const year = new Date().getUTCFullYear();
  for (const [i, v] of VILLAS.entries()) {
    const exists = await prisma.villa.findFirst({ where: { rentalId: rental.id, slug: v.slug } });
    if (exists) continue;
    await prisma.villa.create({
      data: {
        ...v,
        sortOrder: i,
        rentalId: rental.id,
        clientId: client.id,
        icalToken: token('ical'),
        seasons: {
          create: [year, year + 1].flatMap((y) => [
            { name: 'Verano', startDate: day(`${y}-07-01`), endDate: day(`${y}-08-31`), nightlyCents: Math.round(v.nightlyCents * 1.4), minNights: 5 },
            { name: 'Navidad', startDate: day(`${y}-12-20`), endDate: day(`${y + 1}-01-06`), nightlyCents: Math.round(v.nightlyCents * 1.6), minNights: 4 },
          ]),
        },
      },
    });
  }
  console.log(`VillaRental ${rental.id}`);
  console.log(`Token del widget: ${rental.publicToken}`);
  console.log(`Prueba: /widget/demo-villas.html?token=${rental.publicToken}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
