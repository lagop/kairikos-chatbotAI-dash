import type { ReportModel } from './prospecting-report';

// =============================================================================
// A1 — el informe de una página, en HTML.
//
// HTML y no PDF a propósito: en este repo no hay ninguna dependencia de
// generación de PDF y meterla (Puppeteer y un Chromium dentro del
// contenedor) es peso y una fuente de fallos nueva para algo que el
// navegador ya sabe hacer. El precedente del repo es exactamente este:
// lead-export.ts sirve CSV y seo-article-html.ts compone HTML.
//
// El destino real es el móvil del prospecto, por WhatsApp, mientras el
// comercial le habla por teléfono: de ahí que sea una sola página, sin
// JavaScript, con @media print para que "Guardar como PDF" salga bien, y
// con todo el CSS en línea porque el enlace se abre fuera del portal.
//
// No hay datos de ningún cliente de Kairikos aquí: es información pública
// de Google sobre un negocio, más una estimación cuyos supuestos se
// imprimen al lado. Esa transparencia no es decoración — la primera
// objeción por teléfono es siempre "yo no pierdo tantas llamadas", y la
// respuesta es enseñar de dónde sale el número, no defenderlo.
// =============================================================================

/** Todo lo que entra en la plantilla viene de Google (nombres de negocios
 *  de terceros): escapar no es opcional. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function euros(value: number): string {
  return `${new Intl.NumberFormat('es-ES').format(value)} €`;
}

function stars(rating: number | null): string {
  return rating === null ? '—' : `${rating.toFixed(1)} ★`;
}

function reviews(count: number | null): string {
  if (count === null) return 'sin datos';
  return count === 1 ? '1 reseña' : `${new Intl.NumberFormat('es-ES').format(count)} reseñas`;
}

function metres(distance: number | null): string {
  if (distance === null) return '';
  return distance >= 1000 ? `a ${(distance / 1000).toFixed(1)} km` : `a ${distance} m`;
}

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #14181f; background: #f6f7f9; line-height: 1.5; }
.sheet { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 28px 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: #5b6472; font-size: 14px; margin: 0 0 24px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #5b6472;
  margin: 28px 0 10px; }
.headline { background: #0f172a; color: #fff; border-radius: 10px; padding: 18px 20px; margin: 20px 0; }
.headline .figure { font-size: 30px; font-weight: 700; line-height: 1.2; }
.headline .caption { font-size: 13px; opacity: .8; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #e6e9ee; }
th { font-weight: 600; color: #5b6472; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
tr.subject td { background: #eef4ff; font-weight: 600; }
ul { margin: 0; padding-left: 18px; }
li { margin-bottom: 6px; }
.assumptions { font-size: 12px; color: #5b6472; margin-top: 8px; }
footer { max-width: 720px; margin: 16px auto 0; font-size: 11px; color: #7b8595; }
@media print {
  body { background: #fff; padding: 0; }
  .sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
}
`;

export function renderProspectingReportHtml(model: ReportModel): string {
  const { subject, comparison, competitors, estimate, findings, capturedAt } = model;

  const rankLine =
    comparison.ratingRank !== null
      ? `${comparison.ratingRank}º de ${comparison.rankedCount} por valoración en su zona`
      : 'Sin valoración en Google todavía';

  // El propio negocio va dentro de la tabla, resaltado, y no en una ficha
  // aparte: la comparación se ve sola cuando las filas están juntas.
  const rows = [
    `<tr class="subject"><td>${esc(subject.name)} <span style="font-weight:400;color:#5b6472">(tu negocio)</span></td>
      <td>${stars(subject.rating)}</td><td>${reviews(subject.reviewCount)}</td><td></td></tr>`,
    ...competitors.map(
      (c) =>
        `<tr><td>${esc(c.name)}</td><td>${stars(c.rating)}</td><td>${reviews(c.reviewCount)}</td><td>${metres(
          c.distanceMeters,
        )}</td></tr>`,
    ),
  ].join('\n');

  const findingsList =
    findings.length > 0
      ? `<ul>${findings.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>`
      : '<p class="sub">Sin hallazgos destacables con los datos públicos disponibles.</p>';

  const competitorsBlock =
    competitors.length > 0
      ? `<table>
          <thead><tr><th>Negocio</th><th>Valoración</th><th>Reseñas</th><th>Distancia</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : `<p class="sub">Google no devolvió competidores comparables en esta zona.</p>`;

  const website = subject.website
    ? `<a href="${esc(subject.website)}" rel="noopener nofollow">${esc(subject.website)}</a>`
    : 'Sin web en su ficha de Google';

  const a = estimate.assumptions;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Es información sobre un negocio de terceros y no debe acabar indexada. -->
<meta name="robots" content="noindex, nofollow">
<title>${esc(subject.name)} · Análisis de presencia digital</title>
<style>${STYLES}</style>
</head>
<body>
<main class="sheet">
  <h1>${esc(subject.name)}</h1>
  <p class="sub">${esc(subject.address ?? subject.location ?? '')}${
    subject.phone ? ` · ${esc(subject.phone)}` : ''
  }</p>

  <div class="headline">
    <div class="figure">${euros(estimate.annualLostRevenue)} al año</div>
    <div class="caption">es lo que se deja de facturar si no se atienden ${a.missedCallsPerWeek} llamadas
      a la semana. ${rankLine}.</div>
  </div>

  <h2>Qué hemos visto</h2>
  ${findingsList}

  <h2>Su zona, hoy</h2>
  ${competitorsBlock}

  <h2>De dónde sale la cifra</h2>
  <p class="assumptions">
    ${a.missedCallsPerWeek} llamadas perdidas a la semana × ${euros(a.averageJobValue)} de encargo medio ×
    ${Math.round(a.closeRate * 100)} % de cierre = ${euros(estimate.monthlyLostRevenue)} al mes.
    Son supuestos conservadores: cámbialos por los tuyos y el cálculo se rehace.
  </p>

  <h2>Su web</h2>
  <p class="sub">${website}</p>
</main>
<footer>
  Datos públicos de Google Maps recogidos el ${capturedAt.toLocaleDateString('es-ES')}.
  Las valoraciones cambian; esta es la foto de ese día. Preparado por Kairikos.
</footer>
</body>
</html>`;
}
