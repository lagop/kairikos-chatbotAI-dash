import type { SiteContent, SiteSectionType } from './site-content';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — los títulos y descripciones de cada
// página: qué se le enseña a la IA de cada una (website-meta-ai.ts) y cómo
// se aplica lo que el cliente acepta. Puro: se prueba sin red ni base.
// =============================================================================

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*#]+/g, '').replace(/\s+/g, ' ').trim();

/** El texto de una sección, para que la IA sepa de qué va la página. */
function sectionText(tipo: SiteSectionType, d: SiteContent['datos']): string {
  switch (tipo) {
    case 'portada':
      return `${d.titular}. ${d.subtitulo}`;
    case 'servicios':
      return `Servicios: ${d.servicios.map((s) => (s.descripcion ? `${s.nombre} (${s.descripcion})` : s.nombre)).join('; ')}`;
    case 'sobre':
      return `Quiénes somos: ${plain(d.sobre).slice(0, 400)}`;
    case 'proceso':
      return `Cómo trabajan: ${d.proceso.map((p) => p.titulo).join('; ')}`;
    case 'garantias':
      return `Garantías: ${d.garantias.map((g) => g.titulo).join('; ')}`;
    case 'precios':
      return `Precios: ${d.precios.filas.map((f) => f.concepto).join('; ')}`;
    case 'faq':
      return `Preguntas: ${d.faq.map((f) => f.pregunta).join('; ')}`;
    case 'zona':
      return `Zona: ${[plain(d.zona.texto), d.zona.lugares.map((l) => l.nombre).join(', ')].filter(Boolean).join(' ')}`;
    case 'contacto':
      return 'Contacto: teléfono, formulario y horario';
    default:
      return '';
  }
}

/** Un resumen por página, con lo que de verdad enseña (sin ocultas ni vacías). */
export function pageSummaries(content: SiteContent): { ruta: string; titulo: string; resumen: string; metaTituloActual: string; metaDescripcionActual: string }[] {
  return content.paginas.map((p) => {
    const parts = p.secciones
      .filter((s) => !s.oculta)
      .map((s) => {
        if (s.tipo === 'bloque') {
          const b = content.bloques.find((x) => x.id === s.id);
          return b ? `${b.titulo}. ${plain(b.texto).slice(0, 300)}` : '';
        }
        return sectionText(s.tipo, content.datos);
      })
      .filter((t) => t.replace(/[^\p{L}]/gu, '').length > 0);
    return {
      ruta: p.ruta,
      titulo: p.titulo,
      resumen: parts.join('\n'),
      metaTituloActual: p.metaTitulo,
      metaDescripcionActual: p.metaDescripcion,
    };
  });
}

/** Aplica las propuestas aceptadas. Solo a páginas que existen; una ruta
 *  desconocida se ignora (el cliente pudo borrar la página entre proponer y
 *  aplicar). Devuelve qué rutas cambiaron, para la auditoría. */
export function applyMetaProposals(
  content: SiteContent,
  proposals: { ruta: string; metaTitulo: string; metaDescripcion: string }[],
): { content: SiteContent; changed: string[] } {
  const next: SiteContent = JSON.parse(JSON.stringify(content));
  const changed: string[] = [];
  for (const p of proposals) {
    const page = next.paginas.find((x) => x.ruta === p.ruta);
    if (!page) continue;
    const titulo = p.metaTitulo.trim().slice(0, 70);
    const descripcion = p.metaDescripcion.trim().slice(0, 160);
    if (titulo === page.metaTitulo && descripcion === page.metaDescripcion) continue;
    page.metaTitulo = titulo;
    page.metaDescripcion = descripcion;
    changed.push(p.ruta || '/');
  }
  return { content: next, changed };
}
