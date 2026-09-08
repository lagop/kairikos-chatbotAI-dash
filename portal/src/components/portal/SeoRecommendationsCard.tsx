import type { SeoRecommendation, RecommendationSeverity } from '@/lib/seo-recommendations';

// =============================================================================
// Fase 3.2 — lo que hay que arreglar en la web del cliente, en su idioma.
//
// La auditoría técnica existía desde Fase A pero solo la veía un operador,
// y en crudo: "imagesMissingAlt: 7". Aquí se le enseña al cliente lo que
// significa y qué hacer, ordenado por lo que más mueve la aguja.
// =============================================================================

const SEVERITY_LABEL: Record<RecommendationSeverity, string> = {
  alta: 'Prioritario',
  media: 'Recomendado',
  baja: 'Mejora menor',
};

const SEVERITY_CLASS: Record<RecommendationSeverity, string> = {
  alta: 'pill-warning',
  media: 'pill-muted',
  baja: 'pill-muted',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

export function SeoRecommendationsCard({
  recommendations,
  checkedAt,
}: {
  recommendations: SeoRecommendation[];
  checkedAt: string | null;
}) {
  const checked = checkedAt ? new Date(checkedAt) : null;
  const checkedLabel = checked && !Number.isNaN(checked.getTime()) ? DATE_FMT.format(checked) : null;

  if (recommendations.length === 0) {
    return (
      <section className="card space-y-2" aria-label="Estado técnico de tu web" data-testid="seo-recommendations-card">
        <p className="text-sm font-semibold">Estado técnico de tu web</p>
        <p className="text-sm text-kairikos-muted">
          No hemos encontrado nada que corregir en la última revisión
          {checkedLabel ? ` (${checkedLabel})` : ''}.
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-4" aria-label="Estado técnico de tu web" data-testid="seo-recommendations-card">
      <div>
        <p className="text-sm font-semibold">Qué mejorar en tu web</p>
        <p className="text-xs text-kairikos-muted">
          {recommendations.length} {recommendations.length === 1 ? 'cosa' : 'cosas'} que hemos encontrado revisando tu
          sitio{checkedLabel ? `, el ${checkedLabel}` : ''}. Ordenadas por lo que más te va a notar Google.
        </p>
      </div>

      <ul className="space-y-3" data-testid="seo-recommendations-list">
        {recommendations.map((rec) => (
          <li
            key={rec.id}
            className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4"
            data-testid="seo-recommendation"
            data-severity={rec.severity}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={SEVERITY_CLASS[rec.severity]}>{SEVERITY_LABEL[rec.severity]}</span>
              <p className="text-sm font-medium text-kairikos-text">{rec.title}</p>
            </div>
            <p className="mt-1.5 text-sm text-kairikos-muted">{rec.detail}</p>
            {rec.autoApplicable ? (
              <p className="mt-1.5 text-xs text-kairikos-accent2" data-testid="seo-recommendation-auto">
                Esto podemos dejarlo aplicado nosotros en tu WordPress.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
