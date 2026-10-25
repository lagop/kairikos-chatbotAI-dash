import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PageHeading } from '@/components/portal/PageHeading';
import { WebSalesSettingsPanel } from '@/components/admin/WebSalesSettingsPanel';
import {
  countWebSelfServeUsage,
  getWebSelfServeMonthlyCap,
  DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP,
} from '@/lib/web-self-serve';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Webs · Admin',
  description: 'Cuántas webs se venden al mes sin llamada, desde la página del borrador.',
  alternates: { canonical: '/admin/portal/settings/web' },
  robots: { index: false, follow: false },
};

export default async function AdminWebSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/web');
  }

  const [cap, usage] = isDatabaseConfigured
    ? await Promise.all([getWebSelfServeMonthlyCap(prisma), countWebSelfServeUsage(prisma, new Date())])
    : [DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP, { sold: 0, pending: 0 }];

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Webs"
        description="Cuántas webs se pueden comprar al mes sin llamada, con «La quiero» desde la página del borrador."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <WebSalesSettingsPanel initialCap={cap} soldThisMonth={usage.sold} pendingCheckouts={usage.pending} />
    </div>
  );
}
