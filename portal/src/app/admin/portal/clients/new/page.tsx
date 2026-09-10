import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { NewClientForm, type CreatableProduct } from '@/components/admin/NewClientForm';
import { PRODUCT_CATALOGS } from '@/lib/catalogs';
import type { ProductCode } from '@/lib/catalogs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Nuevo cliente · Admin',
  description: 'Alta manual de un cliente que cerró la venta fuera del formulario público.',
  robots: { index: false, follow: false },
};

function isProductCode(value: string): value is ProductCode {
  return value in PRODUCT_CATALOGS;
}

export default async function NewClientPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/clients/new');
  }

  if (!isDatabaseConfigured) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Operador" title="Nuevo cliente" />
        <EmptyState title="No disponible en modo demo" description="El alta manual requiere una cuenta real conectada a base de datos." />
      </div>
    );
  }

  // 'web' se excluye: no tiene precio de catálogo fijo, va por
  // presupuesto (POST /api/portal/web-quote/request) — mismo criterio
  // que ProductAssignment.tsx en la ficha de un cliente existente.
  const rows = await prisma.product.findMany({
    where: { isActive: true, code: { not: 'web' } },
    orderBy: [{ code: 'asc' }, { tier: 'asc' }],
  });
  const products: CreatableProduct[] = rows.map((p) => ({
    id: p.id,
    code: p.code,
    tier: p.tier,
    name: (isProductCode(p.code) ? PRODUCT_CATALOGS[p.code].label : null) ?? p.name,
    priceCents: p.priceCents,
    currency: p.currency,
  }));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Nuevo cliente"
        description="Para una venta cerrada fuera del formulario público (teléfono, email). El cliente recibe un correo para activar su acceso al portal."
      />
      <NewClientForm products={products} />
    </div>
  );
}
