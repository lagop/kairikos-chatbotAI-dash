import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { RecoveryImportCard } from '@/components/admin/RecoveryImportCard';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Diagnóstico de base de clientes · Admin',
  robots: { index: false, follow: false },
};

// =============================================================================
// La herramienta de venta de `recall`: el diagnóstico sobre el fichero de un
// prospecto que todavía no es cliente.
//
// Sin suscripción y sin guardar nada. El comercial la abre en una llamada,
// sube el export de facturación del prospecto y le enseña su propio dinero
// — cuántos clientes lleva año y medio sin ver, cuánto facturó —. No
// promete nada: le enseña sus números. Si firma, la importación de verdad
// se hace desde su ficha, con su declaración de origen.
// =============================================================================

export default async function RecallDiagnosticPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/portal/login?next=/admin/portal/recall/diagnostico');

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/admin/portal/recall" className="hover:text-kairikos-text">
          ← Volver a altas de llamadas
        </Link>
      </div>
      <PageHeading
        eyebrow="Venta"
        title="Diagnóstico de base de clientes"
        description="Para una llamada comercial: el fichero del prospecto se analiza en el momento y no se guarda."
      />
      <RecoveryImportCard subscriptionId={null} />
    </div>
  );
}
