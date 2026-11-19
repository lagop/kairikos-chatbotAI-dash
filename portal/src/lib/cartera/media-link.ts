// =============================================================================
// Cartera — vídeo y recorrido de una casa (docs/fase1-cartera.md, ficha).
//
// La agente pega el enlace de Matterport, YouTube o Vimeo y se guarda SOLO el
// identificador, como exige el formato de la web (src/lib/media.ts allí): la
// dirección la monta la web, así no se cuela otro dominio ni HTML. Pura: la
// usa el formulario para enseñar qué ha entendido antes de guardar.
// =============================================================================

export type MediaRef = { kind: 'matterport' | 'youtube' | 'vimeo'; id: string };

const MATTERPORT_ID = /^[A-Za-z0-9]{11}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;

/** El identificador de un enlace pegado, o null si no es de los tres
 *  proveedores o no trae un identificador con la forma que admite la web. */
export function parseMediaLink(input: string): MediaRef | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'my.matterport.com' || host === 'matterport.com') {
    const id = url.searchParams.get('m') ?? '';
    return MATTERPORT_ID.test(id) ? { kind: 'matterport', id } : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const id = url.searchParams.get('v') ?? (['embed', 'shorts', 'live'].includes(parts[0] ?? '') ? (parts[1] ?? '') : '');
    return YOUTUBE_ID.test(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'youtu.be') {
    const id = parts[0] ?? '';
    return YOUTUBE_ID.test(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = [...parts].reverse().find((p) => VIMEO_ID.test(p)) ?? '';
    return VIMEO_ID.test(id) ? { kind: 'vimeo', id } : null;
  }
  return null;
}

export function mediaPageUrl(m: MediaRef): string {
  return m.kind === 'matterport' ? `https://my.matterport.com/show/?m=${m.id}` : m.kind === 'youtube' ? `https://www.youtube.com/watch?v=${m.id}` : `https://vimeo.com/${m.id}`;
}
