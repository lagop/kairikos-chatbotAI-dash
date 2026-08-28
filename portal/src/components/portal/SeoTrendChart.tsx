// =============================================================================
// SEO con IA — a self-contained SVG line chart for a two-metric daily
// trend. No charting library dependency: this repo has none, and the
// shape needed here (two lines + totals) doesn't justify adding one.
//
// Generic on purpose — used for BOTH Search Console (clicks/
// impressions) and GA4 (users/sessions) on /portal/seo. Genuinely the
// same chart with different labels/data, not two barely-related
// concepts forced together: reused rather than duplicated.
// =============================================================================

export interface SeoTrendPoint {
  date: string; // 'YYYY-MM-DD'
  primary: number;
  secondary: number;
}

const WIDTH = 640;
const HEIGHT = 200;
const PADDING = 28;

function buildPath(values: number[], maxValue: number): string {
  if (values.length === 0) return '';
  const innerWidth = WIDTH - PADDING * 2;
  const innerHeight = HEIGHT - PADDING * 2;
  const stepX = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = PADDING + i * stepX;
      const y = PADDING + innerHeight - (maxValue > 0 ? (v / maxValue) * innerHeight : 0);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function SeoTrendChart({
  points,
  primaryLabel,
  secondaryLabel,
}: {
  points: SeoTrendPoint[];
  primaryLabel: string;
  secondaryLabel: string;
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="seo-trend-chart-empty">
        Todavía no hay datos suficientes — vuelve en unos días.
      </p>
    );
  }

  const primaryValues = points.map((p) => p.primary);
  const secondaryValues = points.map((p) => p.secondary);
  // Both lines share the secondary's scale so they're comparable on one
  // chart. Search Console: clicks <= impressions always. GA4: sessions
  // and users are close enough in magnitude that a shared scale still
  // reads fine — never clips either metric out of view.
  const maxValue = Math.max(...secondaryValues, ...primaryValues, 1);
  const primaryPath = buildPath(primaryValues, maxValue);
  const secondaryPath = buildPath(secondaryValues, maxValue);

  const totalPrimary = primaryValues.reduce((a, b) => a + b, 0);
  const totalSecondary = secondaryValues.reduce((a, b) => a + b, 0);
  const firstDate = points[0].date;
  const lastDate = points[points.length - 1].date;

  return (
    <div className="space-y-2" data-testid="seo-trend-chart">
      <div className="flex gap-6 text-sm">
        <div>
          <p className="text-kairikos-muted">{primaryLabel}</p>
          <p className="text-lg font-semibold tabular-nums">{totalPrimary.toLocaleString('es-ES')}</p>
        </div>
        <div>
          <p className="text-kairikos-muted">{secondaryLabel}</p>
          <p className="text-lg font-semibold tabular-nums">{totalSecondary.toLocaleString('es-ES')}</p>
        </div>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Tendencia de ${primaryLabel.toLowerCase()} y ${secondaryLabel.toLowerCase()}`} className="w-full">
        <path d={secondaryPath} fill="none" stroke="rgb(var(--kairikos-accent2))" strokeWidth={2} opacity={0.7} />
        <path d={primaryPath} fill="none" stroke="rgb(var(--kairikos-accent))" strokeWidth={2.5} />
      </svg>
      <div className="flex items-center justify-between text-xs text-kairikos-muted">
        <span>{firstDate}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-kairikos-accent" /> {primaryLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-kairikos-accent2" /> {secondaryLabel}
          </span>
        </span>
        <span>{lastDate}</span>
      </div>
    </div>
  );
}
