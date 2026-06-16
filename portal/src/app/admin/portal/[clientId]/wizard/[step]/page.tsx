import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import AdminConfigReview from '@/components/admin/AdminConfigReview';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { parseStepNumber, getStepDefinition, WIZARD_STEP_NUMBERS } from '@/lib/wizard-catalog';

interface PageProps {
  params: { clientId: string; step: string };
}

const STEP_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  let stepNumber: ReturnType<typeof parseStepNumber> | null = null;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    // fall through with default metadata
  }
  const def = stepNumber ? getStepDefinition(stepNumber) : null;
  return {
    title: def
      ? `Paso ${def.number} · ${def.label} · Operador`
      : `Paso del wizard · Operador`,
    description: def
      ? `Revisión del paso ${def.number} (${def.label}) para un cliente concreto.`
      : 'Revisión de un paso del wizard para un cliente concreto.',
    alternates: {
      canonical: `/admin/portal/${params.clientId}/wizard/${params.step}`,
    },
    robots: { index: false, follow: false },
  };
}

function isKnownStep(step: string): boolean {
  if (!STEP_KEY_RE.test(step)) return false;
  return WIZARD_STEP_NUMBERS.some((n) => String(n) === step);
}

export default async function AdminClientWizardStepPage({ params }: PageProps) {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/sin-acceso');
  }

  if (!isKnownStep(params.step)) {
    notFound();
  }

  let stepNumber: ReturnType<typeof parseStepNumber>;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    notFound();
  }
  const def = getStepDefinition(stepNumber);

  let clientLabel = 'Cliente';
  let clientEmail = '';
  if (isDatabaseConfigured) {
    try {
      const c = await prisma.chatbotClient.findUnique({
        where: { id: params.clientId },
        select: { companyName: true, name: true, email: true },
      });
      if (c) {
        clientLabel = c.companyName ?? c.name ?? 'Cliente';
        clientEmail = c.email ?? '';
      } else {
        notFound();
      }
    } catch {
      // fall through; the page still renders with placeholder
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link
          href={`/admin/portal/${params.clientId}/wizard`}
          className="hover:text-kairikos-text"
        >
          ← Volver al wizard de {clientLabel}
        </Link>
      </div>

      <PageHeading
        eyebrow={`Operador · ${clientLabel}${clientEmail ? ` · ${clientEmail}` : ''}`}
        title={`Paso ${def.number}: ${def.label}`}
        description={
          def.v11Deferred
            ? 'Este paso está diferido a v1.1. La vista es de sólo lectura y la aprobación está deshabilitada.'
            : 'Revisa el estado del paso, la versión activa y las acciones disponibles (aprobar o solicitar cambios).'
        }
        actions={
          <Link
            href={`/admin/portal/${params.clientId}/wizard`}
            className="btn-ghost"
            data-testid="admin-wizard-step-back-to-summary"
          >
            Ver resumen del wizard
          </Link>
        }
      />

      <section
        aria-label={`Revisión del paso ${def.number}`}
        data-testid="admin-wizard-step-editor"
        data-step-key={def.key}
        data-step-number={def.number}
        data-v11-deferred={def.v11Deferred ? 'true' : 'false'}
      >
        <AdminConfigReview clientId={params.clientId} />
      </section>
    </div>
  );
}
