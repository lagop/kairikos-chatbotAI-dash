'use client';

// =============================================================================
// «Regenerar» el borrador de web de un prospecto (29/10/2026), junto a «Ver
// borrador de web» en LeadsSummaryPanel.
//
// Hasta hoy, regenerar era añadir ?regenerar=1 a mano a la dirección. Hace lo
// mismo que la primera vez (texto nuevo con Sonnet y diseño elegido entre las
// plantillas aprobadas de su sector, la menos usada: pickSiteTemplateForSector)
// y por eso pide confirmación: reescribe el texto entero, retoques a mano
// incluidos, y cuesta una generación. La ruta guarda la versión anterior en
// el historial y, al terminar, redirige a la dirección sin el parámetro, para
// que recargar la pestaña no vuelva a generar.
// =============================================================================

const CONFIRM =
  '¿Generar este borrador de nuevo, como si fuera la primera vez?\n\n' +
  '· El texto se escribe entero otra vez (unos 2 céntimos) y el diseño se vuelve a elegir entre las plantillas aprobadas de su sector.\n' +
  '· Los retoques a mano se pierden; la versión de ahora queda en el historial.\n' +
  '· El enlace que ya le mandaste sigue valiendo y enseñará la nueva.';

export function RegenerateWebDraftLink({ leadId }: { leadId: string }) {
  return (
    <a
      href={`/api/admin/portal/prospecting/web-draft/${leadId}?regenerar=1`}
      target="_blank"
      rel="noreferrer"
      className="ml-2 mt-2 inline-block text-sm btn-ghost"
      title="Generarlo de nuevo, con texto nuevo y el diseño elegido otra vez (~2 céntimos)."
      data-testid="leads-summary-web-draft-regenerate"
      onClick={(e) => {
        if (!window.confirm(CONFIRM)) e.preventDefault();
      }}
    >
      Regenerar
    </a>
  );
}
