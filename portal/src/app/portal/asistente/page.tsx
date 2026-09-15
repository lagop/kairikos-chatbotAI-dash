import type { Metadata } from 'next';
import { requirePortalSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { AssistantPanel } from '@/components/portal/AssistantPanel';
import { isAssistantConfigured } from '@/lib/assistant-ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Asistente',
  robots: { index: false, follow: false },
};

// =============================================================================
// Fase 5c — la pantalla del asistente.
//
// NO COMPRUEBA NINGÚN PRODUCTO CONTRATADO, y es deliberado: el asistente
// contesta sobre los datos que el cliente YA tiene, sean de donde sean.
// Un cliente con solo `recall` verá sus llamadas y no verá presupuestos,
// porque no los tiene — no porque se le esté negando nada. Meter aquí una
// comprobación de producto convertiría "no tienes presupuestos abiertos"
// en "no tienes acceso a esto", que son cosas distintas y la segunda es
// mentira.
//
// El aislamiento por cliente no depende de esta página: lo garantiza la
// ruta, que toma el clientId de la sesión. Ver su cabecera.
//
// `isAssistantConfigured` se consulta en el SERVIDOR para poder avisar
// arriba de que el texto libre no va a funcionar, en vez de dejar que el
// usuario lo descubra escribiendo una pregunta y recibiendo una excusa.
// Los botones siguen funcionando igual.
// =============================================================================

export default async function AsistentePage() {
  await requirePortalSession();
  const aiReady = await isAssistantConfigured();

  return (
    <div className="space-y-6">
      <PageHeading
        title="Asistente"
        description="Pregúntame por tus presupuestos, tus llamadas o las revisiones que vencen."
      />

      {!aiReady ? (
        <div className="card text-sm text-kairikos-muted" data-testid="assistant-degraded">
          Ahora mismo no puedo entender preguntas escritas, pero los botones de abajo funcionan con
          normalidad.
        </div>
      ) : null}

      <AssistantPanel />
    </div>
  );
}
