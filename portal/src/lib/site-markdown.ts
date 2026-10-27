// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — el formato básico de los textos
// largos que escribe el cliente (sobre nosotros, respuestas, bloques libres).
//
// Un subconjunto deliberadamente pequeño de Markdown: párrafos, saltos de
// línea, **negrita**, *cursiva*, listas con «- » o «1. », títulos «## » y enlaces
// [texto](https://…), tel: o mailto:. Nada más.
//
// Por qué no HTML ni un Markdown completo: lo que sale de aquí acaba en la web
// pública del cliente y, por SFTP, en SU servidor. Se escapa TODO primero y
// solo después se reconocen estas marcas, así que no hay forma de colar una
// etiqueta, un atributo ni un javascript: — el enlace solo admite tres
// esquemas, comprobados sobre el texto ya escapado.
//
// Puro y sin dependencias: se prueba entero sin DOM (los tests corren en Node).
// =============================================================================

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Sobre texto YA escapado: las comillas son &quot; y no pueden cerrar el href.
const LINK_RE = /\[([^\]\n]{1,200})\]\(((?:https?:\/\/|mailto:)[^\s()<>]{1,500}|tel:\+?[0-9 ]{3,20})\)/g;

function inline(escaped: string): string {
  return escaped
    .replace(LINK_RE, (_m, label: string, href: string) => {
      const external = /^https?:/.test(href);
      return `<a href="${href.replace(/ /g, '')}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
}

/**
 * Convierte el texto del cliente en HTML seguro. Texto vacío → cadena vacía,
 * para que una sección pueda decidir no pintarse.
 */
export function renderSiteMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const blocks = normalized.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      // Entrega 5: títulos dentro de una entrada del blog («## …»). Solo h2 y
      // h3: el h1 de la página es el título de la entrada.
      const heading = lines.length === 1 ? /^(#{2,3}) +(\S.*)$/.exec(lines[0]) : null;
      if (heading) {
        const tag = heading[1].length === 2 ? 'h2' : 'h3';
        return `<${tag}>${inline(escapeHtml(heading[2]))}</${tag}>`;
      }
      if (lines.length > 0 && lines.every((l) => /^[-*] +\S/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(escapeHtml(l.replace(/^[-*] +/, '')))}</li>`).join('')}</ul>`;
      }
      if (lines.length > 0 && lines.every((l) => /^\d{1,2}[.)] +\S/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(escapeHtml(l.replace(/^\d{1,2}[.)] +/, '')))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`;
    })
    .join('\n');
}
