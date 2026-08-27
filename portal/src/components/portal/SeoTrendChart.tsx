// =============================================================================
// SEO con IA, Fase B — a self-contained SVG line chart for the client's
// clicks/impressions trend. No charting library dependency: this repo
// has none yet, and the shape needed here (two lines + totals) doesn't
// justify adding one.
// =============================================================================

export interface SeoTrendPoint {
  date: string; // 'YYYY-MM-DD'
  clicks: number;
  impressions: number;
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

export function SeoTrendChart({ points }: { points: SeoTrendPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="seo-trend-chart-empty">
        Todavía no hay datos suficientes — vuelve en unos días.
      </p>
    );
  }

  const clicks = points.map((p) => p.clicks);
  const impressions = points.map((p) => p.impressions);
  const maxImpressions = Math.max(...impressions, 1);
  // Clicks share the impressions scale so both lines are comparable on
  // one chart — clicks are always <= impressions, so this never clips.
  const clicksPath = buildPath(clicks, maxImpressions);
  const impressionsPath = buildPath(impressions, maxImpressions);

  const totalClicks = clicks.reduce((a, b) => a + b, 0);
  const totalImpressions = impressions.reduce((a, b) => a + b, 0);
  const firstDate = points[0].date;
  const lastDate = points[points.length - 1].date;

  return (
    <div className="space-y-2" data-testid="seo-trend-chart">
      <div className="flex gap-6 text-sm">
        <div>
          <p className="text-kairikos-muted">Clics</p>
          <p className="text-lg font-semibold tabular-nums">{totalClicks.toLocaleString('es-ES')}</p>
        </div>
        <div>
          <p className="text-kairikos-muted">Impresiones</p>
          <p className="text-lg font-semibold tabular-nums">{totalImpressions.toLocaleString('es-ES')}</p>
        </div>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Tendencia de clics e impresiones" className="w-full">
        <path d={impressionsPath} fill="none" stroke="rgb(var(--kairikos-accent2))" strokeWidth={2} opacity={0.7} />
        <path d={clicksPath} fill="none" stroke="rgb(var(--kairikos-accent))" strokeWidth={2.5} />
      </svg>
      <div className="flex items-center justify-between text-xs text-kairikos-muted">
        <span>{firstDate}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-kairikos-accent" /> Clics
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-kairikos-accent2" /> Impresiones
          </span>
        </span>
        <span>{lastDate}</span>
      </div>
    </div>
  );
}
