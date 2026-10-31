import type { SiteSectionType } from './site-content';

// =============================================================================
// Variantes de sección (30/10/2026) — la misma sección con otra disposición.
//
// Orlando, al ver las plantillas del 30/10: «se parecen mucho, hay un patrón
// que se repite». Era cierto, y por tres motivos:
// - cada plantilla traía UNA pieza por tipo de sección;
// - los bloques ricos los pinta el motor igual en todas;
// - todas estaban escritas sobre el mismo esqueleto: rótulo + h2 + rejilla de
//   tarjetas.
// De una página de muestra con 25 disposiciones (demos/plantillas/variantes/)
// eligió 23. Esta es la lista; el marcado está en
// site-section-variants-markup.ts.
//
// Combinado, como se le propuso:
// - El MOTOR trae una versión de cada variante. La pinta con las variables
//   --k-* de la plantilla (como los bloques ricos), así que respeta sus
//   colores, letras y esquinas, y el acento y la pareja de letras del negocio.
// - Cada PLANTILLA puede traer la suya: la pieza `servicios@indice` gana a la
//   del motor. Así cualquier plantilla tiene todas las variantes desde el
//   primer día, y gana personalidad donde más se nota (portada, servicios).
//
// Sin variante, la sección sale con la pieza propia de la plantilla, como
// hasta hoy: una web publicada no cambia sola de aspecto.
//
// Este módulo lo importa el editor (componente de cliente): solo datos y
// funciones puras, sin el marcado.
// =============================================================================

/** La forma de una disposición, para no repetir dos seguidas
 *  (alternarVariantes). */
export type SiteLayoutShape = 'portada' | 'rejilla' | 'lista' | 'partida' | 'centrada' | 'columnas' | 'mosaico' | 'pestanas' | 'zigzag' | 'linea' | 'franja' | 'carrusel';

export interface SiteSectionVariant {
  id: string;
  /** Lo que lee el cliente en el editor. */
  nombre: string;
  /** La de la página de muestra (P1, S3…), para hablar de ellas. */
  muestra: string;
  forma: SiteLayoutShape;
}

/**
 * Las variantes de cada sección. P4 («formulario a la vista») pone un
 * segundo formulario en la página, además del de contacto: el motor envía
 * los dos (formScript, site-template.ts).
 */
export const SITE_SECTION_VARIANTS: Partial<Record<SiteSectionType, readonly SiteSectionVariant[]>> = {
  portada: [
    { id: 'panoramica', muestra: 'P1', nombre: 'Titular enorme y foto panorámica', forma: 'portada' },
    { id: 'sangre', muestra: 'P2', nombre: 'Foto a sangre con una tarjeta encima', forma: 'portada' },
    { id: 'centrada', muestra: 'P3', nombre: 'Centrada, con las fotos en abanico', forma: 'portada' },
    { id: 'formulario', muestra: 'P4', nombre: 'Con el formulario a la vista', forma: 'portada' },
  ],
  servicios: [
    { id: 'zigzag', muestra: 'S1', nombre: 'Filas en zigzag', forma: 'zigzag' },
    { id: 'pestanas', muestra: 'S2', nombre: 'Pestañas a un lado', forma: 'pestanas' },
    { id: 'indice', muestra: 'S3', nombre: 'Índice numerado con el título fijo', forma: 'lista' },
    { id: 'mosaico', muestra: 'S4', nombre: 'Mosaico con uno destacado', forma: 'mosaico' },
  ],
  sobre: [
    { id: 'cita', muestra: 'Q1', nombre: 'Cita grande y foto redonda', forma: 'centrada' },
    { id: 'media', muestra: 'Q2', nombre: 'Media foto a sangre', forma: 'partida' },
    { id: 'revista', muestra: 'Q3', nombre: 'Revista a dos columnas', forma: 'columnas' },
  ],
  proceso: [{ id: 'linea', muestra: 'L2', nombre: 'Línea de tiempo', forma: 'linea' }],
  garantias: [
    { id: 'marcas', muestra: 'L1', nombre: 'Lista con marcas', forma: 'lista' },
    { id: 'iconos', muestra: 'L3', nombre: 'Iconos grandes centrados', forma: 'centrada' },
  ],
  precios: [{ id: 'ventanitas', muestra: 'L4', nombre: 'Lista con el detalle en una ventanita', forma: 'lista' }],
  opiniones: [
    { id: 'carrusel', muestra: 'O1', nombre: 'Carrusel sobre fondo oscuro', forma: 'carrusel' },
    { id: 'muro', muestra: 'O2', nombre: 'Muro de reseñas', forma: 'mosaico' },
    { id: 'destacada', muestra: 'O3', nombre: 'La nota fija al lado', forma: 'partida' },
  ],
  faq: [
    { id: 'dos-columnas', muestra: 'F1', nombre: 'Acordeón a dos columnas', forma: 'rejilla' },
    { id: 'panel', muestra: 'F2', nombre: 'Preguntas a un lado, respuesta al otro', forma: 'partida' },
  ],
};

/** Las de los bloques ricos: por ahora, el estilo de las pestañas (T1–T3). */
export const SITE_BLOCK_VARIANTS: Partial<Record<string, readonly SiteSectionVariant[]>> = {
  pestanas: [
    { id: 'subrayado', muestra: 'T1', nombre: 'Subrayado que se desliza', forma: 'pestanas' },
    { id: 'pildora', muestra: 'T2', nombre: 'Píldora', forma: 'pestanas' },
    { id: 'tarjetas', muestra: 'T3', nombre: 'Tarjetas', forma: 'pestanas' },
  ],
};

/** Cómo es la pieza PROPIA de cada plantilla. Es una suposición (cada
 *  plantilla la escribe a su manera), pero la de casi todas: lo que dijo
 *  Orlando es justo que todo eran rejillas de tarjetas. */
const OWN_SHAPE: Record<SiteSectionType, SiteLayoutShape> = {
  portada: 'portada',
  cifras: 'franja',
  servicios: 'rejilla',
  sobre: 'partida',
  proceso: 'rejilla',
  garantias: 'rejilla',
  precios: 'lista',
  opiniones: 'rejilla',
  faq: 'lista',
  zona: 'rejilla',
  llamada: 'franja',
  contacto: 'partida',
};

/** La variante `id` de la sección `tipo`, o null si no existe (una que se
 *  quitó, o un valor cualquiera): entonces sale la pieza propia. */
export function sectionVariant(tipo: string, id: string | undefined | null): SiteSectionVariant | null {
  if (!id) return null;
  return SITE_SECTION_VARIANTS[tipo as SiteSectionType]?.find((v) => v.id === id) ?? null;
}

export function blockVariant(tipo: string, id: string | undefined | null): SiteSectionVariant | null {
  if (!id) return null;
  return SITE_BLOCK_VARIANTS[tipo]?.find((v) => v.id === id) ?? null;
}

/** El nombre de la pieza con la que una plantilla sobrescribe una variante. */
export function variantPart(tipo: SiteSectionType, id: string): `${SiteSectionType}@${string}` {
  return `${tipo}@${id}`;
}

/** Las piezas de variante que puede traer una plantilla. */
export const SITE_VARIANT_PARTS: readonly string[] = (Object.entries(SITE_SECTION_VARIANTS) as [SiteSectionType, readonly SiteSectionVariant[]][]).flatMap(
  ([tipo, vs]) => vs.map((v) => variantPart(tipo, v.id)),
);

/** Cuántos juegos de variantes mide el laboratorio: el juego k pone a cada
 *  sección su variante k (dando la vuelta si tiene menos). */
export const SITE_VARIANT_SETS = Math.max(...Object.values(SITE_SECTION_VARIANTS).map((vs) => vs?.length ?? 0));

/** La variante de `tipo` en el juego `k` del laboratorio. */
export function variantInSet(tipo: SiteSectionType, k: number): string | undefined {
  const vs = SITE_SECTION_VARIANTS[tipo];
  return vs?.length ? vs[k % vs.length].id : undefined;
}

type Ref = { tipo: string; id?: string; oculta?: boolean; variante?: string };

/** El contenido con el juego `k` puesto en todas las secciones de todas sus
 *  páginas, también el estilo de los bloques de pestañas. Lo usan el
 *  laboratorio y comprobar.html. */
export function withVariantSet<C extends { paginas: { secciones: Ref[] }[]; bloques: { id: string; tipo: string }[] }>(content: C, k: number): C {
  const blockTipo = new Map(content.bloques.map((b) => [b.id, b.tipo]));
  return {
    ...content,
    paginas: content.paginas.map((p) => ({
      ...p,
      secciones: p.secciones.map((r) => {
        if (r.tipo === 'bloque') {
          const vs = SITE_BLOCK_VARIANTS[blockTipo.get(r.id ?? '') ?? ''];
          return vs?.length ? { ...r, variante: vs[k % vs.length].id } : r;
        }
        const v = variantInSet(r.tipo as SiteSectionType, k);
        return v ? { ...r, variante: v } : r;
      }),
    })),
  };
}

function shapeOf(ref: Ref): SiteLayoutShape | 'bloque' {
  if (ref.tipo === 'bloque') return 'bloque';
  return sectionVariant(ref.tipo, ref.variante)?.forma ?? OWN_SHAPE[ref.tipo as SiteSectionType] ?? 'rejilla';
}

/**
 * Que dos secciones seguidas no tengan la misma forma: a cada una que repita
 * la de la anterior le pone una variante distinta de la anterior y de la
 * siguiente, prefiriendo una que no haya salido ya en la página. Las que no
 * chocan se quedan como estaban, también las elegidas a mano. Las ocultas no
 * cuentan: no se ven.
 *
 * Es un botón del editor y no algo que haga el motor al pintar: así lo que se
 * publica es lo que el cliente vio, y no cambia al añadir una variante nueva.
 *
 * 31/10/2026 — también se aplica al crear un borrador (designForDraft,
 * web-draft-design.ts), que por eso pasa:
 * - `seVe`: qué secciones salen de verdad. En el borrador una sección sin
 *   contenido (zona sin lugares) no se pinta aunque no esté oculta, y si
 *   contara, dos rejillas separadas solo por ella parecerían no tocarse.
 * - `semilla`: por dónde empieza a elegir. Sin ella, todos los borradores
 *   de una plantilla saldrían con las mismas disposiciones.
 */
export function alternarVariantes<T extends Ref>(
  secciones: readonly T[],
  opciones: { seVe?: (ref: T) => boolean; semilla?: number } = {},
): T[] {
  const out = secciones.map((r) => ({ ...r }));
  const seVe = opciones.seVe ?? ((r: T) => !r.oculta);
  const visible = out.filter((r) => !r.oculta && seVe(r));
  const used = new Set(visible.map(shapeOf));
  let turn = Math.max(0, Math.floor(opciones.semilla ?? 0));
  for (let i = 1; i < visible.length; i++) {
    const ref = visible[i];
    const prev = shapeOf(visible[i - 1]);
    if (shapeOf(ref) !== prev || ref.tipo === 'bloque') continue;
    const options = SITE_SECTION_VARIANTS[ref.tipo as SiteSectionType] ?? [];
    const next = visible[i + 1] ? shapeOf(visible[i + 1]) : null;
    const ok = options.filter((v) => v.forma !== prev && v.forma !== next);
    if (!ok.length) continue;
    const fresh = ok.filter((v) => !used.has(v.forma));
    const pool = fresh.length ? fresh : ok;
    const pick = pool[turn++ % pool.length];
    ref.variante = pick.id;
    used.add(pick.forma);
  }
  return out;
}
